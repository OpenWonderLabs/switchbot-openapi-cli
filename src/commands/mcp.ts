import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { intArg, stringArg } from '../utils/arg-parsers.js';
import { handleError, isJsonMode, buildErrorPayload, exitWithError, type ErrorPayload, type ErrorSubKind } from '../utils/output.js';
import { VERSION } from '../version.js';
import {
  fetchDeviceList,
  fetchDeviceStatus,
  executeCommand,
  describeDevice,
  validateCommand,
  isDestructiveCommand,
  getDestructiveReason,
  searchCatalog,
  DeviceNotFoundError,
  toMcpDescribeShape,
  toMcpDeviceListShape,
  toMcpIrDeviceShape,
} from '../lib/devices.js';
import { fetchScenes, executeScene } from '../lib/scenes.js';
import {
  findCatalogEntry,
  deriveSafetyTier,
  getCommandSafetyReason,
} from '../devices/catalog.js';
import { getCachedDevice } from '../devices/cache.js';
import { validateParameter } from '../devices/param-validator.js';
import { EventSubscriptionManager } from '../mcp/events-subscription.js';
import { deviceHistoryStore } from '../mcp/device-history.js';
import { queryDeviceHistory } from '../devices/history-query.js';
import {
  aggregateDeviceHistory,
  ALL_AGG_FNS,
  MAX_SAMPLE_CAP,
  type AggFn,
  type AggOptions,
} from '../devices/history-agg.js';
import { todayUsage } from '../utils/quota.js';
import { describeCache } from '../devices/cache.js';
import { withRequestContext } from '../lib/request-context.js';
import { profileFilePath, tryLoadConfig } from '../config.js';
import {
  loadPolicyFile,
  resolvePolicyPath,
  PolicyFileNotFoundError,
  PolicyYamlParseError,
} from '../policy/load.js';
import { validateLoadedPolicy } from '../policy/validate.js';
import {
  CURRENT_POLICY_SCHEMA_VERSION,
  SUPPORTED_POLICY_SCHEMA_VERSIONS,
  type PolicySchemaVersion,
} from '../policy/schema.js';
import { planMigration } from '../policy/migrate.js';
import { suggestPlan } from './plan.js';
import { suggestRule } from '../rules/suggest.js';
import { addRuleToPolicyFile, AddRuleError } from '../policy/add-rule.js';
import { writeFileSync } from 'node:fs';
import { readAudit, type AuditEntry } from '../utils/audit.js';
import { parseDurationToMs } from '../utils/flags.js';
import { resolveDeviceId } from '../utils/name-resolver.js';
import { validatePlan } from './plan.js';
import { parse as yamlParse } from 'yaml';
import { diffPolicyValues } from '../policy/diff.js';

const LATEST_SUPPORTED_VERSION: PolicySchemaVersion =
  SUPPORTED_POLICY_SCHEMA_VERSIONS[SUPPORTED_POLICY_SCHEMA_VERSIONS.length - 1];
import { fileURLToPath } from 'node:url';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Factory — build an McpServer with the six SwitchBot tools registered.
 * Exported so tests and alternative transports can reuse it.
 */

type McpErrorKind = 'api' | 'runtime' | 'usage' | 'guard';

function mcpError(
  kind: McpErrorKind,
  code: number,
  message: string,
  options?: {
    hint?: string;
    retryable?: boolean;
    context?: Record<string, unknown>;
    subKind?: ErrorSubKind;
    errorClass?: NonNullable<ErrorPayload['errorClass']>;
    transient?: boolean;
    retryAfterMs?: number;
  },
) {
  const obj: Record<string, unknown> = { code, kind, message };
  if (options?.hint) obj.hint = options.hint;
  if (options?.retryable) obj.retryable = true;
  if (options?.context) obj.context = options.context;
  if (options?.subKind !== undefined) obj.subKind = options.subKind;
  if (options?.errorClass !== undefined) obj.errorClass = options.errorClass;
  if (options?.transient !== undefined) obj.transient = options.transient;
  if (options?.retryAfterMs !== undefined) obj.retryAfterMs = options.retryAfterMs;
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: obj }, null, 2) }],
    structuredContent: { error: obj },
  };
}

/**
 * Convert any thrown error into a structured MCP tool-error response,
 * preserving all ErrorPayload fields (subKind, transient, hint, etc.).
 */
function apiErrorToMcpError(err: unknown) {
  const payload = buildErrorPayload(err);
  return mcpError(payload.kind, payload.code, payload.message, {
    hint: payload.hint,
    retryable: payload.retryable,
    context: payload.context,
    subKind: payload.subKind,
    errorClass: payload.errorClass,
    transient: payload.transient,
    retryAfterMs: payload.retryAfterMs,
  });
}

const DEFAULT_AUDIT_LOG_FILE = pathJoin(os.homedir(), '.switchbot', 'audit.log');

interface AuditFilterOptions {
  since?: string;
  from?: string;
  to?: string;
  kinds?: AuditEntry['kind'][];
  deviceId?: string;
  ruleName?: string;
  results?: Array<'ok' | 'error'>;
}

function resolveAuditRange(opts: Pick<AuditFilterOptions, 'since' | 'from' | 'to'>): {
  fromMs: number;
  toMs: number;
} {
  if (opts.since && (opts.from || opts.to)) {
    throw new Error('--since is mutually exclusive with --from/--to.');
  }
  if (opts.since) {
    const dur = parseDurationToMs(opts.since);
    if (dur === null) {
      throw new Error(`Invalid --since value "${opts.since}". Expected e.g. "30s", "15m", "1h", "7d".`);
    }
    return { fromMs: Date.now() - dur, toMs: Number.POSITIVE_INFINITY };
  }

  let fromMs = Number.NEGATIVE_INFINITY;
  let toMs = Number.POSITIVE_INFINITY;
  if (opts.from) {
    const parsed = Date.parse(opts.from);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid --from value "${opts.from}". Expected ISO-8601 timestamp.`);
    }
    fromMs = parsed;
  }
  if (opts.to) {
    const parsed = Date.parse(opts.to);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid --to value "${opts.to}". Expected ISO-8601 timestamp.`);
    }
    toMs = parsed;
  }
  if (fromMs > toMs) {
    throw new Error('--from must be <= --to.');
  }
  return { fromMs, toMs };
}

function filterAuditEntries(entries: AuditEntry[], opts: AuditFilterOptions): AuditEntry[] {
  const { fromMs, toMs } = resolveAuditRange(opts);
  return entries.filter((entry) => {
    const tMs = Date.parse(entry.t);
    if (!Number.isFinite(tMs)) return false;
    if (tMs < fromMs || tMs > toMs) return false;
    if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes(entry.kind)) return false;
    if (opts.deviceId && entry.deviceId !== opts.deviceId) return false;
    if (opts.ruleName && entry.rule?.name !== opts.ruleName) return false;
    if (opts.results && opts.results.length > 0) {
      if (!entry.result || !opts.results.includes(entry.result)) return false;
    }
    return true;
  });
}

function topNFromMap(counts: Map<string, number>, n: number): Array<{ key: string; count: number }> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

export function createSwitchBotMcpServer(options?: { eventManager?: EventSubscriptionManager }): McpServer {
  const eventManager = options?.eventManager;
  const server = new McpServer(
    {
      name: 'switchbot',
      version: VERSION,
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        `SwitchBot is an IoT smart home brand by Wonderlabs, Inc. This MCP server controls physical devices \
(Bot, Curtain, Smart Lock, Color Bulb, Meter, Plug, Robot Vacuum, etc.) and IR remotes \
(TV, AC, Set Top Box, etc.) via the SwitchBot Cloud API v1.1.

Device categories:
- physical: Wi-Fi/BLE devices; BLE-only ones require a Hub (check enableCloudService)
- ir: IR remotes learned by a Hub; no status channel, commands only

Key constraints:
- API quota: 10,000 requests/day per account — use cache, avoid polling
- Destructive commands (unlock, garage open, keypad createKey/deleteKey) require confirm:true
- Devices without enableCloudService cannot receive commands via API

Recommended bootstrap sequence:
1. list_devices → get deviceIds and categories
2. search_catalog or describe_device → confirm supported commands offline/online
3. send_command (with confirm:true for destructive commands)

API docs: https://github.com/OpenWonderLabs/SwitchBotAPI`,
    }
  );

  // ---- list_devices ---------------------------------------------------------
  server.registerTool(
    'list_devices',
    {
      title: 'List all devices on the account',
      description:
        'Fetch the complete inventory of physical devices and IR remotes on this SwitchBot account. Refreshes the local metadata cache and groups devices by type. Use this as the bootstrap call to discover available deviceIds. Devices without enableCloudService cannot receive commands via API. IR remotes depend on a Hub for connectivity.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({}).strict(),
      outputSchema: {
        deviceList: z.array(z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          deviceType: z.string().optional(),
          enableCloudService: z.boolean(),
          hubDeviceId: z.string(),
          roomID: z.string().optional(),
          roomName: z.string().nullable().optional(),
          familyName: z.string().optional(),
          controlType: z.string().optional(),
        }).passthrough()).describe('Physical SwitchBot devices'),
        infraredRemoteList: z.array(z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          remoteType: z.string(),
          hubDeviceId: z.string(),
          controlType: z.string().optional(),
        }).passthrough()).describe('IR remote devices'),
      },
    },
    async () => {
      const body = await fetchDeviceList();
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        structuredContent: {
          deviceList: body.deviceList.map(toMcpDeviceListShape),
          infraredRemoteList: body.infraredRemoteList.map(toMcpIrDeviceShape),
        },
      };
    }
  );

  // ---- get_device_status ----------------------------------------------------
  server.registerTool(
    'get_device_status',
    {
      title: 'Get live status for a device',
      description:
        'Query the real-time status payload for a physical device. IR remotes have no status channel and will error.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        deviceId: z.string().describe('Device ID from list_devices'),
      }).strict(),
      outputSchema: {
        status: z.object({
          deviceId: z.string().optional(),
          deviceType: z.string().optional(),
          hubDeviceId: z.string().optional(),
          connectionStatus: z.string().optional(),
        }).passthrough().describe('Live device status (deviceId + deviceType + device-specific fields)'),
      },
    },
    async ({ deviceId }) => {
      const body = await fetchDeviceStatus(deviceId);
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        structuredContent: { status: body as { deviceId?: string; deviceType?: string; [key: string]: unknown } },
      };
    }
  );

  // ---- get_device_history ----------------------------------------------------
  server.registerTool(
    'get_device_history',
    {
      title: 'Get locally-persisted device state history',
      description:
        'Return device state history recorded from MQTT events (persisted to ~/.switchbot/device-history/). ' +
        'No API call — zero quota cost. Use when you need recent historical readings or want to avoid a live API call. ' +
        'Omit deviceId to list all devices with stored history.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        deviceId: z.string().optional().describe('Device MAC address (deviceId). Omit to list all devices with history.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max history entries to return (default 20, max 100)'),
      }).strict(),
      outputSchema: {
        deviceId: z.string().optional(),
        latest: z.unknown().optional(),
        history: z.array(z.unknown()).optional(),
        devices: z.array(z.object({ deviceId: z.string(), latest: z.unknown() })).optional(),
      },
    },
    async ({ deviceId, limit }) => {
      if (deviceId) {
        const latest = deviceHistoryStore.getLatest(deviceId);
        const history = deviceHistoryStore.getHistory(deviceId, limit ?? 20);
        const result = { deviceId, latest, history };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }
      const ids = deviceHistoryStore.listDevices();
      const devices = ids.map((id) => ({ deviceId: id, latest: deviceHistoryStore.getLatest(id) }));
      const result = { devices };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // ---- query_device_history --------------------------------------------------
  server.registerTool(
    'query_device_history',
    {
      title: 'Query time-ranged device history',
      description:
        'Return records from the append-only JSONL history (~/.switchbot/device-history/<deviceId>.jsonl) ' +
        'filtered by a relative duration (since) or absolute ISO-8601 range (from/to). ' +
        'No API call — zero quota cost. Use for trend questions like "how many times did this switch turn on last week".',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        deviceId: z.string().describe('Device ID to query'),
        since: z.string().optional().describe('Relative window ending now, e.g. "30s", "15m", "1h", "7d". Mutually exclusive with from/to.'),
        from: z.string().optional().describe('Range start (ISO-8601).'),
        to: z.string().optional().describe('Range end (ISO-8601).'),
        fields: z.array(z.string()).optional().describe('Project these payload fields; omit for the full payload.'),
        limit: z.number().int().min(1).max(10000).optional().describe('Max records to return (default 1000).'),
      }).strict(),
      outputSchema: {
        deviceId: z.string(),
        count: z.number().int(),
        records: z.array(z.object({
          t: z.string(),
          topic: z.string(),
          deviceType: z.string().optional(),
          payload: z.unknown(),
        })),
      },
    },
    async ({ deviceId, since, from, to, fields, limit }) => {
      if (since && (from || to)) {
        return mcpError('usage', 2, '--since is mutually exclusive with --from/--to.');
      }
      try {
        const records = await queryDeviceHistory(deviceId, { since, from, to, fields, limit });
        const result = { deviceId, count: records.length, records };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'history query failed';
        return mcpError('usage', 2, msg);
      }
    }
  );

  // ---- send_command ---------------------------------------------------------
  server.registerTool(
    'send_command',
    {
      title: 'Send a control command to a device',
      description:
        'Execute a control command on a device (turnOn, setColor, startClean, unlock, openDoor, createKey, etc.). Destructive commands (Smart Lock unlock, Garage Door open, Keypad createKey/deleteKey) require confirm:true to proceed; otherwise rejected. Commands are validated offline against the device catalog. Use idempotencyKey to safely deduplicate retries within 60 seconds.',
      _meta: { agentSafetyTier: 'action' },
      inputSchema: z.object({
        deviceId: z.string().describe('Device ID from list_devices'),
        command: z.string().describe('Command name, case-sensitive (e.g. turnOn, setColor, unlock)'),
        parameter: z
          .union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .optional()
          .describe('Command parameter. Omit for no-arg commands.'),
        commandType: z
          .enum(['command', 'customize'])
          .optional()
          .default('command')
          .describe('"command" for built-in commands; "customize" for user-defined IR buttons'),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe('Required true for destructive commands (unlock, garage open, createKey, ...)'),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            'Deduplication key — repeat calls with the same key within 60s replay the first result (adds replayed:true). Same key + different (command, parameter) within 60s returns an idempotency_conflict guard error.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe('When true, do not call the API — return { ok:true, dryRun:true, wouldSend:{...} } instead.'),
      }).strict(),
      outputSchema: {
        ok: z.literal(true),
        command: z.string().optional(),
        deviceId: z.string().optional(),
        result: z.unknown().optional().describe('API response body from SwitchBot (absent on dryRun)'),
        verification: z
          .object({
            verifiable: z.boolean(),
            reason: z.string(),
            suggestedFollowup: z.string(),
          })
          .optional()
          .describe(
            'Present when the target is an IR device. IR is unidirectional — agents should treat the success as "signal sent" not "state changed".',
          ),
        dryRun: z.literal(true).optional().describe('Present when dryRun:true was requested'),
        wouldSend: z.object({
          deviceId: z.string(),
          command: z.string(),
          parameter: z.unknown(),
          commandType: z.string(),
        }).optional().describe('The request shape that would have been POSTed (present when dryRun:true)'),
      },
    },
    async ({ deviceId, command, parameter, commandType, confirm, idempotencyKey, dryRun }) => {
      const effectiveType = commandType ?? 'command';
      let effectiveCommand = command;
      let effectiveParameter: unknown = parameter;

      // stringifiedParam mirrors the CLI form that validateCommand /
      // validateParameter expect — B-1 runs on the string representation.
      const stringifiedParam =
        parameter === undefined ? undefined : typeof parameter === 'string' ? parameter : JSON.stringify(parameter);

      // dryRun early-return — no API call. We still preflight the deviceId
      // against the local cache so fabricated IDs don't silently pass
      // validation (bug #SYS-3). Dry-run is meant to catch bad inputs; a
      // dry-run that accepts anything is worse than no dry-run at all.
      if (dryRun) {
        const cached = getCachedDevice(deviceId);
        if (!cached) {
          return mcpError('usage', 2, `Device "${deviceId}" not found in local cache.`, {
            subKind: 'device-not-found',
            hint: "Run 'list_devices' first to warm the cache, then retry with dryRun:true.",
            context: { deviceId },
          });
        }
        const dryValidation = validateCommand(deviceId, effectiveCommand, stringifiedParam, effectiveType);
        if (!dryValidation.ok) {
          return mcpError(
            'usage',
            2,
            dryValidation.error.message,
            {
              hint: dryValidation.error.hint,
              context: {
                validationKind: dryValidation.error.kind,
                deviceType: cached.type,
                command: effectiveCommand,
              },
            },
          );
        }
        if (dryValidation.normalized) {
          effectiveCommand = dryValidation.normalized;
        }
        // R-2: run B-1 param validation in dry-run too, so dry-run doesn't
        // falsely accept inputs the live API would reject.
        if (effectiveType !== 'customize') {
          const pv = validateParameter(cached.type, effectiveCommand, stringifiedParam);
          if (!pv.ok) {
            return mcpError('usage', 2, pv.error, {
              hint: 'Dry-run rejected the parameter client-side; the API would reject it too.',
              context: { deviceType: cached.type, command: effectiveCommand, parameter: stringifiedParam },
            });
          }
          if (pv.normalized !== undefined) {
            effectiveParameter = pv.normalized;
          }
        }
        const wouldSend = {
          deviceId,
          command: effectiveCommand,
          parameter: effectiveParameter ?? 'default',
          commandType: effectiveType,
        };
        const structured = { ok: true as const, dryRun: true as const, wouldSend };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      }

      // Resolve the device's catalog type via cache or a fresh lookup so we
      // can evaluate destructive/validation without an extra round-trip if
      // the cache is warm.
      let typeName = getCachedDevice(deviceId)?.type;
      if (!typeName) {
        const body = await fetchDeviceList();
        const physical = body.deviceList.find((d) => d.deviceId === deviceId);
        const ir = body.infraredRemoteList.find((d) => d.deviceId === deviceId);
        if (!physical && !ir) {
          return mcpError('runtime', 152, `Device not found: ${deviceId}`, {
            hint: "Check the deviceId with 'switchbot devices list' (IDs are case-sensitive).",
          });
        }
        typeName = physical ? physical.deviceType : ir!.remoteType;
      }

      if (isDestructiveCommand(typeName, effectiveCommand, effectiveType) && !confirm) {
        const reason = getDestructiveReason(typeName, effectiveCommand, effectiveType);
        const entry = typeName ? findCatalogEntry(typeName) : null;
        const spec =
          entry && !Array.isArray(entry)
            ? entry.commands.find((c) => c.command === effectiveCommand)
            : undefined;
        const hint = reason
          ? `Re-issue with confirm:true after confirming with the user. Reason: ${reason}`
          : 'Re-issue the call with confirm:true to proceed.';
        return mcpError(
          'guard', 3,
          `Command "${effectiveCommand}" on device type "${typeName}" is destructive and requires confirm:true.`,
          {
            hint,
            context: {
              command: effectiveCommand,
              deviceType: typeName,
              description: spec?.description ?? null,
              ...(reason ? { safetyReason: reason, destructiveReason: reason } : {}),
            },
          },
        );
      }

      // validateCommand covers command existence + required/unexpected-parameter.
      // stringifiedParam was computed once at the top of the handler so dry-run
      // and live paths share the same shape.
      const validation = validateCommand(deviceId, effectiveCommand, stringifiedParam, effectiveType);
      if (!validation.ok) {
        return mcpError(
          'usage', 2,
          validation.error.message,
          {
            hint: validation.error.hint,
            context: { validationKind: validation.error.kind, deviceType: typeName, command: effectiveCommand },
          },
        );
      }
      if (validation.normalized) {
        effectiveCommand = validation.normalized;
      }

      // R-2: run B-1 client-side parameter validator (range/format checks).
      // Customize commands (user-defined IR buttons) opt out — the catalog
      // cannot know their expected shape.
      if (effectiveType !== 'customize') {
        const pv = validateParameter(typeName, effectiveCommand, stringifiedParam);
        if (!pv.ok) {
          return mcpError('usage', 2, pv.error, {
            context: { deviceType: typeName, command: effectiveCommand, parameter: stringifiedParam, validationKind: 'param-out-of-range' },
          });
        }
        if (pv.normalized !== undefined) {
          effectiveParameter = pv.normalized;
        }
      }

      let result: unknown;
      try {
        result = await executeCommand(deviceId, effectiveCommand, effectiveParameter, effectiveType, undefined, {
          idempotencyKey,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'IdempotencyConflictError') {
          return mcpError('guard', 2, err.message, {
            hint: 'Use a fresh idempotencyKey, or wait for the prior key to expire (60s TTL).',
            context: {
              existingShape: (err as { existingShape?: string }).existingShape,
              newShape: (err as { newShape?: string }).newShape,
            },
          });
        }
        return apiErrorToMcpError(err);
      }
      const isIr = getCachedDevice(deviceId)?.category === 'ir';
      const structured: {
        ok: true;
        command: string;
        deviceId: string;
        result: unknown;
        verification?: {
          verifiable: boolean;
          reason: string;
          suggestedFollowup: string;
        };
      } = { ok: true as const, command: effectiveCommand, deviceId, result };
      if (isIr) {
        structured.verification = {
          verifiable: false,
          reason: 'IR transmission is unidirectional; no receipt acknowledgment is possible.',
          suggestedFollowup: 'Confirm visible change manually or via a paired state sensor.',
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  // ---- run_scene ------------------------------------------------------------
  server.registerTool(
    'run_scene',
    {
      title: 'Execute a manual scene',
      description: 'Execute a manual SwitchBot scene by its sceneId (from list_scenes).',
      _meta: { agentSafetyTier: 'action' },
      inputSchema: z.object({
        sceneId: z.string().describe('Scene ID from list_scenes'),
        dryRun: z
          .boolean()
          .optional()
          .describe('When true, do not call the API — return { ok:true, dryRun:true, wouldSend:{...} } instead.'),
      }).strict(),
      outputSchema: {
        ok: z.literal(true),
        sceneId: z.string().optional(),
        dryRun: z.literal(true).optional().describe('Present when dryRun:true was requested'),
        wouldSend: z.object({
          sceneId: z.string(),
        }).optional().describe('The request shape that would have been POSTed (present when dryRun:true)'),
      },
    },
    async ({ sceneId, dryRun }) => {
      if (dryRun) {
        let scenes: Array<{ sceneId: string; sceneName: string }> = [];
        try {
          scenes = await fetchScenes();
        } catch {
          // network failure — degrade gracefully, skip validation
        }
        const found = scenes.find((s) => s.sceneId === sceneId);
        if (scenes.length > 0 && !found) {
          return mcpError('usage', 2, `Scene not found: ${sceneId}`, {
            subKind: 'scene-not-found',
            hint: "Check the sceneId with 'list_scenes' (IDs are case-sensitive).",
            context: { sceneId, candidates: scenes.map((s) => ({ sceneId: s.sceneId, sceneName: s.sceneName })).slice(0, 5) },
          });
        }
        const wouldSend = { sceneId, sceneName: found?.sceneName ?? null };
        const structured = { ok: true as const, dryRun: true as const, wouldSend };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      }
      try {
        await executeScene(sceneId);
      } catch (err) {
        return apiErrorToMcpError(err);
      }
      const structured = { ok: true as const, sceneId };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  // ---- list_scenes (companion to run_scene) ---------------------------------
  server.registerTool(
    'list_scenes',
    {
      title: 'List all manual scenes',
      description: 'Fetch all manual scenes configured in the SwitchBot app.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({}).strict(),
      outputSchema: {
        scenes: z.array(z.object({ sceneId: z.string(), sceneName: z.string() })),
      },
    },
    async () => {
      const scenes = await fetchScenes();
      return {
        content: [{ type: 'text', text: JSON.stringify(scenes, null, 2) }],
        structuredContent: { scenes },
      };
    }
  );

  // ---- search_catalog -------------------------------------------------------
  server.registerTool(
    'search_catalog',
    {
      title: 'Search the offline device catalog',
      description:
        'Search the built-in device catalog by type name or alias. Returns matching entries with their commands, roles, destructive flags, and status fields. No API call.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        query: z.string().describe('Search query (matches type and aliases, case-insensitive). Must be non-empty; use list_catalog_types to enumerate instead.'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max entries returned (default 20)'),
      }).strict(),
      outputSchema: {
        results: z.array(z.object({
          type: z.string(),
          category: z.enum(['physical', 'ir']),
          commands: z.array(z.object({
            command: z.string(),
            parameter: z.string(),
            description: z.string(),
            commandType: z.enum(['command', 'customize']).optional(),
            idempotent: z.boolean().optional(),
            safetyTier: z.enum(['read', 'mutation', 'ir-fire-forget', 'destructive', 'maintenance']).optional(),
            safetyReason: z.string().optional(),
          }).passthrough()),
          aliases: z.array(z.string()).optional(),
          statusFields: z.array(z.string()).optional(),
          role: z.string().optional(),
          readOnly: z.boolean().optional(),
        }).passthrough()).describe('Matching catalog entries'),
        total: z.number().int().describe('Number of entries returned'),
      },
    },
    async ({ query, limit }) => {
      if (query.trim() === '') {
        return mcpError(
          'usage',
          2,
          'search_catalog requires a non-empty query.',
          {
            hint: "Pass a search term like 'Bot' or 'Hub', or call list_catalog_types to enumerate all types without a query.",
          },
        );
      }
      const hits = searchCatalog(query, limit);
      const normalised = hits.map((e) => ({
        ...e,
        commands: e.commands.map((c) => {
          const tier = deriveSafetyTier(c, e);
          const reason = getCommandSafetyReason(c);
          return {
            ...c,
            safetyTier: tier,
            ...(reason ? { safetyReason: reason } : {}),
          };
        }),
      }));
      const structured = { results: normalised as unknown as Array<Record<string, unknown>>, total: normalised.length };
      return {
        content: [{ type: 'text', text: JSON.stringify(normalised, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  // ---- describe_device ------------------------------------------------------
  server.registerTool(
    'describe_device',
    {
      title: 'Describe a specific device',
      description:
        'Resolve a deviceId to its metadata + catalog entry + suggested safe actions. Pass live:true to also fetch real-time status values.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        deviceId: z.string().describe('Device ID from list_devices'),
        live: z.boolean().optional().default(false).describe('Also fetch live /status values (costs 1 extra API call)'),
      }).strict(),
      outputSchema: {
        device: z.object({
          device: z.object({ deviceId: z.string(), deviceName: z.string() }).passthrough(),
          isPhysical: z.boolean(),
          typeName: z.string(),
          controlType: z.string().nullable(),
          source: z.enum(['catalog', 'live', 'catalog+live', 'none']),
          capabilities: z.unknown().nullable(),
          suggestedActions: z.array(z.object({
            command: z.string(),
            parameter: z.string().optional(),
            description: z.string(),
          })).optional(),
          inheritedLocation: z.object({
            family: z.string().optional(),
            room: z.string().optional(),
          }).optional(),
        }).passthrough().describe('Device metadata, catalog entry, capabilities, and optional live status'),
      },
    },
    async ({ deviceId, live }) => {
      try {
        const result = await describeDevice(deviceId, { live });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: { device: toMcpDescribeShape(result) },
        };
      } catch (err) {
        if (err instanceof DeviceNotFoundError) {
          return mcpError('runtime', 152, err.message, {
            hint: "Check the deviceId with 'switchbot devices list' (IDs are case-sensitive).",
            context: { deviceId },
          });
        }
        return apiErrorToMcpError(err);
      }
    }
  );

  // ---- aggregate_device_history --------------------------------------------
  server.registerTool(
    'aggregate_device_history',
    {
      title: 'Aggregate device history',
      description:
        'Bucketed statistics (count/min/max/avg/sum/p50/p95) over JSONL-recorded device history. Read-only; no network calls.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z
        .object({
          deviceId: z.string().min(1).describe('Device ID to aggregate over (must exist in ~/.switchbot/device-history/).'),
          since: z
            .string()
            .optional()
            .describe('Relative window ending now, e.g. "30s", "15m", "1h", "7d". Mutually exclusive with from/to.'),
          from: z.string().optional().describe('Range start (ISO-8601). Requires `to`.'),
          to: z.string().optional().describe('Range end (ISO-8601). Requires `from`.'),
          metrics: z
            .array(z.string().min(1))
            .min(1)
            .describe('One or more numeric payload field names to aggregate (e.g. ["temperature","humidity"]).'),
          aggs: z
            .array(z.enum(ALL_AGG_FNS as unknown as [AggFn, ...AggFn[]]))
            .optional()
            .describe('Aggregation functions to apply per metric (default: ["count","avg"]).'),
          bucket: z
            .string()
            .optional()
            .describe('Bucket width like "5m", "1h", "1d". Omit for a single bucket spanning the full range.'),
          maxBucketSamples: z
            .number()
            .int()
            .positive()
            .max(MAX_SAMPLE_CAP)
            .optional()
            .describe(`Sample cap per bucket to bound memory (default ${10_000}, max ${MAX_SAMPLE_CAP}). partial=true in the result when any bucket was capped.`),
        })
        .strict(),
      outputSchema: {
        deviceId: z.string(),
        bucket: z.string().optional().describe('Bucket width echoed back when specified; omitted for single-bucket results.'),
        from: z.string().describe('Effective range start (ISO-8601).'),
        to: z.string().describe('Effective range end (ISO-8601).'),
        metrics: z.array(z.string()).describe('Metrics that were requested.'),
        aggs: z
          .array(z.enum(ALL_AGG_FNS as unknown as [AggFn, ...AggFn[]]))
          .describe('Aggregation functions that were applied.'),
        buckets: z
          .array(
            z.object({
              t: z.string().describe('Bucket start timestamp (ISO-8601).'),
              metrics: z
                .record(
                  z.string(),
                  z
                    .object({
                      count: z.number().optional(),
                      min: z.number().optional(),
                      max: z.number().optional(),
                      avg: z.number().optional(),
                      sum: z.number().optional(),
                      p50: z.number().optional(),
                      p95: z.number().optional(),
                    })
                    .describe('Per-aggregate function result for this metric in this bucket.'),
                )
                .describe('Per-metric result keyed by metric name.'),
            }),
          )
          .describe('Time-ordered buckets; empty when no records match.'),
        partial: z.boolean().describe('True if any bucket was sample-capped; retry with a higher maxBucketSamples or a narrower range for exact values.'),
        notes: z.array(z.string()).describe('Human-readable notes about the aggregation (e.g. "metric X is non-numeric").'),
      },
    },
    async (args) => {
      const opts: AggOptions = {
        since: args.since,
        from: args.from,
        to: args.to,
        metrics: args.metrics,
        aggs: args.aggs,
        bucket: args.bucket,
        maxBucketSamples: args.maxBucketSamples,
      };
      const res = await aggregateDeviceHistory(args.deviceId, opts);
      const structured: Record<string, unknown> = {
        deviceId: res.deviceId,
        from: res.from,
        to: res.to,
        metrics: res.metrics,
        aggs: res.aggs,
        buckets: res.buckets,
        partial: res.partial,
        notes: res.notes,
      };
      if (res.bucket !== undefined) structured.bucket = res.bucket;
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        structuredContent: structured,
      };
    },
  );

  // ---- account_overview ---------------------------------------------------
  server.registerTool(
    'account_overview',
    {
      title: 'Bootstrap account overview',
      description:
        'Get a complete account snapshot: devices, scenes, quota usage, cache status, and MQTT connection state. Use this for cold-start initialization or periodic health checks.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({}).strict(),
      outputSchema: {
        version: z.string(),
        schemaVersion: z.string(),
        devices: z.array(z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          deviceType: z.string().optional(),
        }).passthrough()).describe('All physical devices'),
        infraredRemotes: z.array(z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          remoteType: z.string(),
        }).passthrough()).describe('All IR remotes'),
        scenes: z.array(z.object({
          sceneId: z.string(),
          sceneName: z.string(),
        }).passthrough()).describe('All manual scenes'),
        quota: z.object({
          date: z.string(),
          total: z.number(),
          remaining: z.number(),
          endpoints: z.record(z.string(), z.number()).optional(),
        }).describe('Today\'s quota usage'),
        cache: z.object({
          list: z.object({
            path: z.string(),
            exists: z.boolean(),
            lastUpdated: z.string().optional(),
            ageMs: z.number().optional(),
            deviceCount: z.number().optional(),
          }),
          status: z.object({
            path: z.string(),
            exists: z.boolean(),
            entryCount: z.number(),
            oldestFetchedAt: z.string().optional(),
            newestFetchedAt: z.string().optional(),
          }),
        }).describe('Cache status'),
        mqtt: z.object({
          state: z.string(),
          subscribers: z.number(),
        }).optional().describe('MQTT connection state (present when REST credentials are configured; auto-provisioned via POST /v1.1/iot/credential)'),
      },
    },
    async () => {
      const deviceList = await fetchDeviceList();
      const sceneList = await fetchScenes();
      const cacheInfo = describeCache();
      const quota = todayUsage();

      const overview = {
        version: VERSION,
        schemaVersion: '1.1',
        devices: deviceList.deviceList.map(toMcpDeviceListShape),
        infraredRemotes: deviceList.infraredRemoteList.map(toMcpIrDeviceShape),
        scenes: sceneList.map((s) => ({
          sceneId: s.sceneId,
          sceneName: s.sceneName,
        })),
        quota: {
          date: quota.date,
          total: quota.total,
          remaining: quota.remaining,
          endpoints: quota.endpoints,
        },
        cache: {
          list: cacheInfo.list,
          status: cacheInfo.status,
        },
        ...(eventManager ? {
          mqtt: {
            state: eventManager.getState(),
            subscribers: eventManager.getSubscriberCount(),
          },
        } : {}),
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(overview, null, 2),
        }],
        structuredContent: overview,
      };
    }
  );

  // ---- policy_validate -----------------------------------------------------
  server.registerTool(
    'policy_validate',
    {
      title: 'Validate a policy.yaml file',
      description:
        'Check a policy file against the embedded JSON Schema (supports v0.1 and v0.2). ' +
        'Returns the validation result with per-error line/col and a hint. ' +
        'When no path is given, reads the resolved default (${SWITCHBOT_POLICY_PATH} or ~/.config/openclaw/switchbot/policy.yaml). ' +
        'Use before relying on aliases/quiet_hours/confirmations so the agent never acts on a broken policy.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        path: z.string().optional().describe('Optional policy file path; defaults to the resolved default path'),
      }).strict(),
      outputSchema: {
        policyPath: z.string(),
        schemaVersion: z.string(),
        present: z.boolean().describe('false when the file does not exist'),
        valid: z.boolean().nullable().describe('null when present=false'),
        errors: z.array(z.object({
          path: z.string(),
          line: z.number().optional(),
          col: z.number().optional(),
          keyword: z.string(),
          message: z.string(),
          hint: z.string().optional(),
          schemaPath: z.string(),
        })).describe('Empty when valid or when the file is missing'),
      },
    },
    async ({ path: pathArg }) => {
      const policyPath = resolvePolicyPath({ flag: pathArg });
      try {
        const loaded = loadPolicyFile(policyPath);
        const result = validateLoadedPolicy(loaded);
        const structured = {
          policyPath: result.policyPath,
          schemaVersion: result.schemaVersion,
          present: true,
          valid: result.valid,
          errors: result.errors,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      } catch (err) {
        if (err instanceof PolicyFileNotFoundError) {
          const structured = {
            policyPath,
            schemaVersion: CURRENT_POLICY_SCHEMA_VERSION,
            present: false,
            valid: null,
            errors: [],
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
            structuredContent: structured,
          };
        }
        if (err instanceof PolicyYamlParseError) {
          const structured = {
            policyPath,
            schemaVersion: CURRENT_POLICY_SCHEMA_VERSION,
            present: true,
            valid: false,
            errors: err.yamlErrors.map((e) => ({
              path: '',
              line: e.line,
              col: e.col,
              keyword: 'yaml-parse',
              message: e.message,
              schemaPath: '',
            })),
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
            structuredContent: structured,
          };
        }
        throw err;
      }
    }
  );

  // ---- policy_new ----------------------------------------------------------
  server.registerTool(
    'policy_new',
    {
      title: 'Scaffold a starter policy.yaml',
      description:
        'Write a starter policy file to the resolved default path (or a given path). Refuses to overwrite unless force=true. ' +
        'This is a write action: the agent should only call it after confirming with the user.',
      _meta: { agentSafetyTier: 'action' },
      inputSchema: z.object({
        path: z.string().optional().describe('Optional target path; defaults to the resolved default'),
        force: z.boolean().optional().describe('When true, overwrite an existing file'),
      }).strict(),
      outputSchema: {
        policyPath: z.string(),
        schemaVersion: z.string(),
        bytesWritten: z.number(),
        overwritten: z.boolean(),
      },
    },
    async ({ path: pathArg, force }) => {
      const policyPath = resolvePolicyPath({ flag: pathArg });
      const doForce = force === true;
      if (fs.existsSync(policyPath) && !doForce) {
        return mcpError('guard', 5, `refusing to overwrite existing policy at ${policyPath}`, {
          hint: 'pass force=true to overwrite, or choose a different path',
          context: { policyPath },
        });
      }
      const templateUrl = new URL('../policy/examples/policy.example.yaml', import.meta.url);
      const template = fs.readFileSync(fileURLToPath(templateUrl), 'utf-8');
      fs.mkdirSync(pathDirname(policyPath), { recursive: true });
      fs.writeFileSync(policyPath, template, { encoding: 'utf-8' });
      const structured = {
        policyPath,
        schemaVersion: CURRENT_POLICY_SCHEMA_VERSION,
        bytesWritten: Buffer.byteLength(template, 'utf-8'),
        overwritten: doForce,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  // ---- policy_migrate ------------------------------------------------------
  server.registerTool(
    'policy_migrate',
    {
      title: 'Migrate a policy file to the latest supported schema',
      description:
        'Upgrades the policy file\'s schema version in place while preserving comments. ' +
        'Safe by default: if the migrated document would fail schema validation, the file is NOT rewritten ' +
        'and the tool returns status="precheck-failed" with the list of errors. ' +
        'Pass dryRun=true to preview without touching the file. ' +
        'Currently the only supported upgrade path is v0.1 → v0.2.',
      _meta: { agentSafetyTier: 'action' },
      inputSchema: z.object({
        path: z.string().optional().describe('Optional policy file path; defaults to the resolved default path'),
        dryRun: z.boolean().optional().describe('When true, report what would change without writing'),
        to: z.string().optional().describe(`Target schema version (default: latest supported, "${LATEST_SUPPORTED_VERSION}")`),
      }).strict(),
      outputSchema: {
        policyPath: z.string(),
        fileVersion: z.string().optional(),
        targetVersion: z.string(),
        supportedVersions: z.array(z.string()),
        status: z.enum([
          'already-current',
          'migrated',
          'dry-run',
          'no-version-field',
          'unsupported',
          'precheck-failed',
          'file-not-found',
        ]),
        from: z.string().optional(),
        to: z.string().optional(),
        bytesWritten: z.number().optional(),
        message: z.string(),
        errors: z
          .array(z.object({ path: z.string(), keyword: z.string(), message: z.string() }))
          .optional(),
      },
    },
    async ({ path: pathArg, dryRun, to }) => {
      const policyPath = resolvePolicyPath({ flag: pathArg });
      const target = (to ?? LATEST_SUPPORTED_VERSION) as PolicySchemaVersion;

      let loaded;
      try {
        loaded = loadPolicyFile(policyPath);
      } catch (err) {
        if (err instanceof PolicyFileNotFoundError) {
          const structured = {
            policyPath,
            targetVersion: target,
            supportedVersions: [...SUPPORTED_POLICY_SCHEMA_VERSIONS],
            status: 'file-not-found' as const,
            message: `policy file not found: ${policyPath}`,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
            structuredContent: structured,
          };
        }
        throw err;
      }

      const data = loaded.data as { version?: unknown } | null;
      const fileVersion = typeof data?.version === 'string' ? data.version : undefined;
      const base = {
        policyPath,
        fileVersion,
        targetVersion: target,
        supportedVersions: [...SUPPORTED_POLICY_SCHEMA_VERSIONS],
      };

      if (!fileVersion) {
        const structured = {
          ...base,
          status: 'no-version-field' as const,
          message: `policy has no \`version\` field — add \`version: "${CURRENT_POLICY_SCHEMA_VERSION}"\``,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      }

      if (!SUPPORTED_POLICY_SCHEMA_VERSIONS.includes(fileVersion as PolicySchemaVersion)) {
        const structured = {
          ...base,
          status: 'unsupported' as const,
          message: `policy schema v${fileVersion} is not supported (supports: ${SUPPORTED_POLICY_SCHEMA_VERSIONS.join(', ')})`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      }

      if (fileVersion === target) {
        const structured = {
          ...base,
          status: 'already-current' as const,
          message: `already on schema v${target}; no migration needed`,
          bytesWritten: 0,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      }

      const plan = planMigration(loaded, fileVersion as PolicySchemaVersion, target);
      if (!plan.precheck.valid) {
        const structured = {
          ...base,
          status: 'precheck-failed' as const,
          message: `migrated policy fails schema v${target} precheck; file not written`,
          errors: plan.precheck.errors.map((e) => ({ path: e.path, keyword: e.keyword, message: e.message })),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      }

      const bytes = Buffer.byteLength(plan.nextSource, 'utf-8');
      if (dryRun) {
        const structured = {
          ...base,
          status: 'dry-run' as const,
          from: plan.fromVersion,
          to: plan.toVersion,
          bytesWritten: 0,
          message: `dry-run: would upgrade v${plan.fromVersion} → v${plan.toVersion} (${bytes} bytes)`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        };
      }

      writeFileSync(policyPath, plan.nextSource, { encoding: 'utf-8' });
      const structured = {
        ...base,
        status: 'migrated' as const,
        from: plan.fromVersion,
        to: plan.toVersion,
        bytesWritten: bytes,
        message: `migrated ${policyPath} to schema v${plan.toVersion} (from v${plan.fromVersion})`,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    }
  );

  // ---- policy_diff ---------------------------------------------------------
  server.registerTool(
    'policy_diff',
    {
      title: 'Compare two policy files',
      description:
        'Compare two policy YAML files and return the same contract as `switchbot --json policy diff`: ' +
        '{ leftPath, rightPath, equal, changeCount, truncated, stats, changes, diff }.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        left_path: z.string().min(1).describe('Path to the baseline policy file.'),
        right_path: z.string().min(1).describe('Path to the candidate policy file.'),
      }).strict(),
      outputSchema: {
        leftPath: z.string(),
        rightPath: z.string(),
        equal: z.boolean(),
        changeCount: z.number().int(),
        truncated: z.boolean(),
        stats: z.object({
          added: z.number().int(),
          removed: z.number().int(),
          changed: z.number().int(),
        }),
        changes: z.array(z.object({
          path: z.string(),
          kind: z.enum(['added', 'removed', 'changed']),
          before: z.unknown().optional(),
          after: z.unknown().optional(),
        })),
        diff: z.string(),
      },
    },
    ({ left_path, right_path }) => {
      let leftSource = '';
      let rightSource = '';
      try {
        leftSource = fs.readFileSync(left_path, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return mcpError('usage', 2, `policy file not found: ${left_path}`, {
            context: { policyPath: left_path },
          });
        }
        return mcpError('runtime', 1, `failed to read ${left_path}: ${String(err)}`);
      }
      try {
        rightSource = fs.readFileSync(right_path, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return mcpError('usage', 2, `policy file not found: ${right_path}`, {
            context: { policyPath: right_path },
          });
        }
        return mcpError('runtime', 1, `failed to read ${right_path}: ${String(err)}`);
      }

      let leftDoc: unknown;
      let rightDoc: unknown;
      try {
        leftDoc = yamlParse(leftSource);
      } catch (err) {
        return mcpError('usage', 2, `YAML parse error in ${left_path}: ${(err as Error).message}`);
      }
      try {
        rightDoc = yamlParse(rightSource);
      } catch (err) {
        return mcpError('usage', 2, `YAML parse error in ${right_path}: ${(err as Error).message}`);
      }

      const result = {
        leftPath: left_path,
        rightPath: right_path,
        ...diffPolicyValues(leftDoc, rightDoc, leftSource, rightSource),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  // switchbot://events resource — snapshot of recent shadow events from the ring buffer.
  // Returns up to 100 recent events. When MQTT is disabled, returns an empty list with a state note.
  // URI: switchbot://events  (optional query: ?filter=<expression>  ?limit=<n>)
  if (eventManager) {
    server.registerResource(
      'events',
      'switchbot://events',
      {
        title: 'SwitchBot real-time shadow events',
        description:
          'Recent device shadow-update events received via MQTT. Returns a JSON snapshot of the ring buffer. ' +
          'State is "disabled" when REST credentials (SWITCHBOT_TOKEN + SWITCHBOT_SECRET) are not configured.',
        mimeType: 'application/json',
      },
      (_uri) => {
        const state = eventManager.getState();
        const events = state !== 'disabled' ? eventManager.getRecentEvents(100) : [];
        return {
          contents: [{
            uri: 'switchbot://events',
            mimeType: 'application/json',
            text: JSON.stringify({ state, count: events.length, events }, null, 2),
          }],
        };
      },
    );
  }

  // ---- plan_suggest ---------------------------------------------------------
  server.registerTool(
    'plan_suggest',
    {
      title: 'Draft a SwitchBot execution plan from intent',
      description:
        'Generate a candidate Plan JSON from a natural language intent and a list of device IDs. ' +
        'Uses keyword heuristics (no LLM) to pick the command. The returned plan is ready to pass to ' +
        '`plan run` — review and edit before executing. Recognised commands: turnOn, turnOff, press, ' +
        'lock, unlock, open, close, pause. Falls back to turnOn with a warning when intent is unclear.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        intent: z.string().min(1).describe('Natural language description of what to do (e.g. "turn off all lights").'),
        device_ids: z.array(z.string().min(1)).min(1).describe('Device IDs to act on.'),
      }).strict(),
      outputSchema: {
        plan: z.unknown().describe('Candidate Plan JSON (version 1.0) ready to pass to plan run.'),
        warnings: z.array(z.string()).describe('Informational warnings (e.g. unrecognized intent defaulted to turnOn).'),
      },
    },
    ({ intent, device_ids }) => {
      const devices = device_ids.map((id) => {
        const cached = getCachedDevice(id);
        return { id, name: cached?.name, type: cached?.type };
      });
      try {
        const { plan, warnings } = suggestPlan({ intent, devices });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ plan, warnings }, null, 2) }],
          structuredContent: { plan, warnings },
        };
      } catch (err) {
        return apiErrorToMcpError(err);
      }
    },
  );

  // ---- plan_run -------------------------------------------------------------
  server.registerTool(
    'plan_run',
    {
      title: 'Validate and execute a SwitchBot plan',
      description:
        'Execute a Plan JSON object (version 1.0). Destructive command steps are skipped unless yes=true. ' +
        'Scene and wait steps run in order. Returns per-step results and a summary.',
      _meta: { agentSafetyTier: 'action' },
      inputSchema: z.object({
        plan: z.unknown().describe('Plan JSON object (same schema as `switchbot plan run`).'),
        yes: z.boolean().optional().describe('Authorize destructive command steps.'),
        continue_on_error: z.boolean().optional().describe('Keep executing later steps after a failed step.'),
      }).strict(),
      outputSchema: {
        ran: z.boolean(),
        plan: z.unknown(),
        results: z.array(z.unknown()),
        summary: z.object({
          total: z.number().int(),
          ok: z.number().int(),
          error: z.number().int(),
          skipped: z.number().int(),
        }),
      },
    },
    async ({ plan, yes, continue_on_error }) => {
      const validated = validatePlan(plan);
      if (!validated.ok) {
        return mcpError('usage', 2, 'plan invalid', {
          context: { issues: validated.issues },
          hint: 'Fix the reported issues and retry plan_run.',
        });
      }

      const out: {
        ran: true;
        plan: typeof validated.plan;
        results: Array<
          | { step: number; type: 'command'; deviceId: string; command: string; status: 'ok' | 'error' | 'skipped'; error?: string }
          | { step: number; type: 'scene'; sceneId: string; status: 'ok' | 'error'; error?: string }
          | { step: number; type: 'wait'; ms: number; status: 'ok' }
        >;
        summary: { total: number; ok: number; error: number; skipped: number };
      } = {
        ran: true,
        plan: validated.plan,
        results: [],
        summary: { total: validated.plan.steps.length, ok: 0, error: 0, skipped: 0 },
      };

      const continueOnError = continue_on_error === true;
      const allowDestructive = yes === true;

      for (let i = 0; i < validated.plan.steps.length; i++) {
        const step = validated.plan.steps[i];
        const idx = i + 1;

        if (step.type === 'wait') {
          await new Promise((resolve) => setTimeout(resolve, step.ms));
          out.results.push({ step: idx, type: 'wait', ms: step.ms, status: 'ok' });
          out.summary.ok++;
          continue;
        }

        if (step.type === 'scene') {
          try {
            await executeScene(step.sceneId);
            out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'ok' });
            out.summary.ok++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'error', error: msg });
            out.summary.error++;
            if (!continueOnError) break;
          }
          continue;
        }

        let resolvedDeviceId = '';
        try {
          resolvedDeviceId = resolveDeviceId(step.deviceId, step.deviceName);
          const commandType = step.commandType ?? 'command';
          const deviceType = getCachedDevice(resolvedDeviceId)?.type;
          const destructive = isDestructiveCommand(deviceType, step.command, commandType);
          if (destructive && !allowDestructive) {
            out.results.push({
              step: idx,
              type: 'command',
              deviceId: resolvedDeviceId,
              command: step.command,
              status: 'skipped',
              error: 'destructive — rerun with yes=true',
            });
            out.summary.skipped++;
            if (!continueOnError) break;
            continue;
          }

          await executeCommand(resolvedDeviceId, step.command, step.parameter, commandType);
          out.results.push({
            step: idx,
            type: 'command',
            deviceId: resolvedDeviceId,
            command: step.command,
            status: 'ok',
          });
          out.summary.ok++;
        } catch (err) {
          if (err instanceof Error && err.name === 'DryRunSignal') {
            out.results.push({
              step: idx,
              type: 'command',
              deviceId: resolvedDeviceId || step.deviceId || 'unknown',
              command: step.command,
              status: 'ok',
            });
            out.summary.ok++;
            continue;
          }
          const msg = err instanceof Error ? err.message : String(err);
          out.results.push({
            step: idx,
            type: 'command',
            deviceId: resolvedDeviceId || step.deviceId || 'unknown',
            command: step.command,
            status: 'error',
            error: msg,
          });
          out.summary.error++;
          if (!continueOnError) break;
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    },
  );

  // ---- audit_query ----------------------------------------------------------
  server.registerTool(
    'audit_query',
    {
      title: 'Query command/rule audit log entries',
      description:
        'Filter entries from the local audit log (default ~/.switchbot/audit.log) by time range, kind, device, rule, and result. ' +
        'Useful for review flows and rule-fire inspection without leaving MCP.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        file: z.string().optional().describe('Optional audit log path; defaults to ~/.switchbot/audit.log.'),
        since: z.string().optional().describe('Relative window ending now (e.g. "30m", "24h"). Mutually exclusive with from/to.'),
        from: z.string().optional().describe('Range start (ISO-8601).'),
        to: z.string().optional().describe('Range end (ISO-8601).'),
        kinds: z.array(z.enum(['command', 'rule-fire', 'rule-fire-dry', 'rule-throttled', 'rule-webhook-rejected'])).optional(),
        device_id: z.string().optional().describe('Filter by deviceId.'),
        rule_name: z.string().optional().describe('Filter by rule.name (rule-engine entries).'),
        results: z.array(z.enum(['ok', 'error'])).optional().describe('Filter by execution result.'),
        limit: z.number().int().min(1).max(5000).optional().describe('Max entries returned from the tail of the filtered set (default 200).'),
      }).strict(),
      outputSchema: {
        file: z.string(),
        totalMatched: z.number().int(),
        returned: z.number().int(),
        entries: z.array(z.unknown()),
      },
    },
    ({ file, since, from, to, kinds, device_id, rule_name, results, limit }) => {
      const filePath = file ?? DEFAULT_AUDIT_LOG_FILE;
      const entries = readAudit(filePath);
      try {
        const filtered = filterAuditEntries(entries, {
          since,
          from,
          to,
          kinds,
          deviceId: device_id,
          ruleName: rule_name,
          results,
        });
        const bounded = filtered.slice(-Math.max(1, limit ?? 200));
        const out = {
          file: filePath,
          totalMatched: filtered.length,
          returned: bounded.length,
          entries: bounded,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        return mcpError('usage', 2, err instanceof Error ? err.message : 'invalid audit query options');
      }
    },
  );

  // ---- audit_stats ----------------------------------------------------------
  server.registerTool(
    'audit_stats',
    {
      title: 'Aggregate audit log counts for review dashboards',
      description:
        'Compute summary counters over the local audit log: by kind, by result, top devices, and top rules. ' +
        'Supports the same filters as audit_query.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        file: z.string().optional().describe('Optional audit log path; defaults to ~/.switchbot/audit.log.'),
        since: z.string().optional().describe('Relative window ending now (e.g. "6h"). Mutually exclusive with from/to.'),
        from: z.string().optional().describe('Range start (ISO-8601).'),
        to: z.string().optional().describe('Range end (ISO-8601).'),
        kinds: z.array(z.enum(['command', 'rule-fire', 'rule-fire-dry', 'rule-throttled', 'rule-webhook-rejected'])).optional(),
        device_id: z.string().optional().describe('Filter by deviceId.'),
        rule_name: z.string().optional().describe('Filter by rule.name (rule-engine entries).'),
        results: z.array(z.enum(['ok', 'error'])).optional().describe('Filter by execution result.'),
        top_n: z.number().int().min(1).max(100).optional().describe('Number of top device/rule rows to return (default 10).'),
      }).strict(),
      outputSchema: {
        file: z.string(),
        totalMatched: z.number().int(),
        byKind: z.record(z.string(), z.number().int()),
        byResult: z.record(z.string(), z.number().int()),
        topDevices: z.array(z.object({ deviceId: z.string(), count: z.number().int() })),
        topRules: z.array(z.object({ ruleName: z.string(), count: z.number().int() })),
      },
    },
    ({ file, since, from, to, kinds, device_id, rule_name, results, top_n }) => {
      const filePath = file ?? DEFAULT_AUDIT_LOG_FILE;
      const entries = readAudit(filePath);
      try {
        const filtered = filterAuditEntries(entries, {
          since,
          from,
          to,
          kinds,
          deviceId: device_id,
          ruleName: rule_name,
          results,
        });

        const byKind = new Map<string, number>();
        const byResult = new Map<string, number>();
        const byDevice = new Map<string, number>();
        const byRule = new Map<string, number>();

        for (const entry of filtered) {
          byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
          if (entry.result) byResult.set(entry.result, (byResult.get(entry.result) ?? 0) + 1);
          if (entry.deviceId) byDevice.set(entry.deviceId, (byDevice.get(entry.deviceId) ?? 0) + 1);
          if (entry.rule?.name) byRule.set(entry.rule.name, (byRule.get(entry.rule.name) ?? 0) + 1);
        }

        const topN = top_n ?? 10;
        const out = {
          file: filePath,
          totalMatched: filtered.length,
          byKind: Object.fromEntries([...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
          byResult: Object.fromEntries([...byResult.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
          topDevices: topNFromMap(byDevice, topN).map((item) => ({ deviceId: item.key, count: item.count })),
          topRules: topNFromMap(byRule, topN).map((item) => ({ ruleName: item.key, count: item.count })),
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        return mcpError('usage', 2, err instanceof Error ? err.message : 'invalid audit stats options');
      }
    },
  );

  // ---- rules_suggest --------------------------------------------------------
  server.registerTool(
    'rules_suggest',
    {
      title: 'Draft a SwitchBot automation rule from intent',
      description:
        'Generate a candidate automation rule YAML from a natural language intent. ' +
        'Uses keyword heuristics (no LLM) to infer trigger, schedule, and command. ' +
        'Always emits dry_run: true — the rule must be reviewed before arming. ' +
        'Pass the returned rule_yaml to policy_add_rule to inject it into policy.yaml.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z.object({
        intent: z.string().min(1).describe('Natural language description (e.g. "turn off lights at 10pm").'),
        trigger: z.enum(['mqtt', 'cron', 'webhook']).optional().describe('Trigger type (inferred from intent if omitted).'),
        device_ids: z.array(z.string().min(1)).optional().describe('Device IDs; first is sensor for mqtt triggers, rest are action targets.'),
        event: z.string().optional().describe('MQTT event name override (e.g. motion.detected).'),
        schedule: z.string().optional().describe('5-field cron expression override (e.g. "0 22 * * *").'),
        days: z.array(z.string()).optional().describe('Weekday filter (e.g. ["mon","tue","wed","thu","fri"]).'),
        webhook_path: z.string().optional().describe('Webhook path override (default /action).'),
      }).strict(),
      outputSchema: {
        rule: z.unknown().describe('Rule object matching the v0.2 policy schema.'),
        rule_yaml: z.string().describe('YAML string ready to pipe to policy_add_rule.'),
        warnings: z.array(z.string()).describe('Informational warnings (e.g. unrecognized intent defaulted).'),
      },
    },
    ({ intent, trigger, device_ids, event, schedule, days, webhook_path }) => {
      const devices = (device_ids ?? []).map((id) => {
        const cached = getCachedDevice(id);
        return { id, name: cached?.name, type: cached?.type };
      });
      try {
        const { rule, ruleYaml, warnings } = suggestRule({
          intent,
          trigger,
          devices,
          event,
          schedule,
          days,
          webhookPath: webhook_path,
        });
        return {
          content: [{ type: 'text' as const, text: ruleYaml }],
          structuredContent: { rule, rule_yaml: ruleYaml, warnings },
        };
      } catch (err) {
        return apiErrorToMcpError(err);
      }
    },
  );

  // ---- policy_add_rule ------------------------------------------------------
  server.registerTool(
    'policy_add_rule',
    {
      title: 'Append a rule to automation.rules[] in policy.yaml',
      description:
        'Inject a rule YAML snippet (as produced by rules_suggest) into the automation.rules[] ' +
        'array in policy.yaml. Preserves existing comments and formatting. ' +
        'Always run with dry_run: true first so the agent can show the diff for user approval. ' +
        'Never set enable_automation: true without explicitly informing the user.',
      _meta: { agentSafetyTier: 'action' },
      inputSchema: z.object({
        rule_yaml: z.string().min(1).describe('YAML string of a single rule object (e.g. from rules_suggest).'),
        policy_path: z.string().optional().describe('Path to policy.yaml (defaults to $SWITCHBOT_POLICY_PATH or ~/.switchbot/policy.yaml).'),
        enable_automation: z.boolean().default(false).describe('If true, sets automation.enabled: true after inserting the rule.'),
        dry_run: z.boolean().default(false).describe('If true, compute and return the diff without writing to disk.'),
        force: z.boolean().default(false).describe('If true, overwrite an existing rule with the same name.'),
      }).strict(),
      outputSchema: {
        policyPath: z.string().describe('Resolved path to the policy file.'),
        ruleName: z.string().describe('Name of the rule that was (or would be) inserted.'),
        written: z.boolean().describe('True when the file was actually written.'),
        diff: z.string().describe('Unified-style diff showing lines added/removed.'),
      },
    },
    ({ rule_yaml, policy_path, enable_automation, dry_run, force }) => {
      const policyPath = resolvePolicyPath({ flag: policy_path });
      try {
        const result = addRuleToPolicyFile({
          ruleYaml: rule_yaml,
          policyPath,
          enableAutomation: enable_automation,
          dryRun: dry_run,
          force,
        });
        const out = { policyPath, ruleName: result.ruleName, written: result.written, diff: result.diff };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        if (err instanceof AddRuleError) {
          return apiErrorToMcpError(new Error(`${err.code}: ${err.message}`));
        }
        return apiErrorToMcpError(err);
      }
    },
  );

  return server;
}

/**
 * P10: list the tool names registered on an McpServer instance. Used by
 * `doctor`'s dry-run check. The MCP SDK keeps `_registeredTools` private,
 * so we reach through a narrow cast — safe because this only runs in
 * diagnostic code and the shape is stable across SDK versions.
 */
export function listRegisteredTools(server: McpServer): string[] {
  const internal = server as unknown as { _registeredTools?: Record<string, unknown> };
  if (!internal._registeredTools) return [];
  return Object.keys(internal._registeredTools).sort();
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('Run as a Model Context Protocol server so AI agents can call SwitchBot tools')
    .addHelpText('after', `
  The MCP server exposes twenty-one tools:
  - list_devices            fetch all physical + IR devices
  - get_device_status       live status for a physical device
  - send_command            control a device (destructive commands need confirm:true)
  - list_scenes             list all manual scenes
  - run_scene               execute a manual scene
  - search_catalog          offline catalog search by type/alias
  - describe_device         metadata + commands + (optionally) live status for one device
  - account_overview        single cold-start snapshot: devices + scenes + quota + cache + MQTT state
  - get_device_history      fetch raw JSONL history records for a device
  - query_device_history    filter + page history records with field/time predicates
  - aggregate_device_history compute count/min/max/avg/sum/p50/p95 over history records
  - policy_validate         check policy.yaml against the embedded schema (v0.1 / v0.2)
  - policy_new              scaffold a starter policy.yaml (action — confirm first)
  - policy_migrate          upgrade policy.yaml to the latest schema (action — preserves comments)
  - policy_diff             compare two policy files with structural + line diff output
  - plan_suggest            draft a Plan JSON from intent + device IDs (heuristic, no LLM)
  - plan_run                validate + execute a Plan JSON document
  - audit_query             filter audit log entries by time/device/rule/result
  - audit_stats             aggregate audit counts by kind/result/device/rule
  - rules_suggest           draft an automation rule YAML from intent (heuristic, no LLM)
  - policy_add_rule         append a rule into automation.rules[] in policy.yaml

Resource (read-only):
  - switchbot://events    snapshot of recent MQTT shadow events from the ring buffer
    Auto-provisioned from SWITCHBOT_TOKEN + SWITCHBOT_SECRET;
    returns {state:"disabled"} when credentials are not configured.

Example Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):

  {
    "mcpServers": {
      "switchbot": {
        "command": "switchbot",
        "args": ["mcp", "serve"],
        "env": {
          "SWITCHBOT_TOKEN": "...",
          "SWITCHBOT_SECRET": "..."
        }
      }
    }
  }

Inspect locally:
  $ npx @modelcontextprotocol/inspector switchbot mcp serve
`);

  mcp
    .command('serve')
    .description('Start the MCP server on stdio (default) or HTTP (--port)')
    .option('--port <n>', 'Listen on HTTP instead of stdio (Streamable HTTP transport)', intArg('--port', { min: 1, max: 65535 }))
    .option('--bind <host>', 'IP address to bind (default 127.0.0.1; use 0.0.0.0 to accept external connections)', stringArg('--bind'), '127.0.0.1')
    .option('--auth-token <token>', 'Bearer token for HTTP requests (required for --bind 0.0.0.0; falls back to SWITCHBOT_MCP_TOKEN env var)', stringArg('--auth-token'))
    .option('--cors-origin <url>', 'Allowed CORS origin(s) for HTTP (repeatable)', stringArg('--cors-origin'))
    .option('--rate-limit <n>', 'Max requests per minute per profile (default 60)', intArg('--rate-limit', { min: 1 }), '60')
    .addHelpText('after', `
Examples:
  $ switchbot mcp serve
  $ switchbot mcp serve --port 8787
  $ switchbot mcp serve --port 8787 --bind 127.0.0.1 --auth-token your-token
  $ switchbot mcp serve --port 8787 --bind 0.0.0.0 --auth-token your-token
`)
    .action(async (options: { port?: string; bind?: string; authToken?: string; corsOrigin?: string | string[]; rateLimit?: string }) => {
      try {
        if (options.port) {
          const port = Number(options.port);
          if (!Number.isFinite(port) || port < 1 || port > 65535) {
            exitWithError(`Invalid --port "${options.port}". Must be 1-65535.`);
          }

          const bind = options.bind ?? '127.0.0.1';
          const authToken = options.authToken ?? process.env.SWITCHBOT_MCP_TOKEN;
          const corsOrigins = Array.isArray(options.corsOrigin) ? options.corsOrigin : (options.corsOrigin ? [options.corsOrigin] : []);
          const rateLimit = Math.max(1, Number(options.rateLimit) || 60);

          // Guard: refuse to bind non-localhost without auth
          const isLocalhost = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
          if (!isLocalhost && !authToken) {
            exitWithError('Refusing to listen on 0.0.0.0 without --auth-token. Pass --auth-token <token> or bind to localhost (default).');
          }

          const { createServer } = await import('node:http');
          const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

          // Initialize shared EventSubscriptionManager for event streaming.
          // Credentials are auto-provisioned from the SwitchBot API using the
          // account's token+secret — no extra MQTT env vars needed.
          const eventManager = new EventSubscriptionManager();
          const mqttCreds = tryLoadConfig();
          if (mqttCreds) {
            eventManager.initialize(mqttCreds.token, mqttCreds.secret).catch((err: unknown) => {
              console.error('MQTT initialization failed:', err instanceof Error ? err.message : String(err));
            });
          } else {
            console.error('MQTT disabled: credentials not configured.');
          }

          // Helper: constant-time token comparison
          const tokenMatch = (provided: string | undefined): boolean => {
            if (!authToken) return true; // No token configured, allow all
            if (!provided) return false;
            const expected = authToken;
            let match = true;
            for (let i = 0; i < Math.max(expected.length, provided.length); i++) {
              if ((expected[i] ?? '\0') !== (provided[i] ?? '\0')) match = false;
            }
            return match;
          };

          // Helper: rate limit check
          const checkRateLimit = (profile: string): boolean => {
            const now = Date.now();
            const bucket = rateLimitMap.get(profile);
            if (!bucket || now >= bucket.resetAt) {
              rateLimitMap.set(profile, { count: 1, resetAt: now + 60000 });
              return true;
            }
            bucket.count++;
            return bucket.count <= rateLimit;
          };

          const httpServer = createServer(async (req, res) => {
            // Health and metrics routes (no auth required)
            if (req.url === '/healthz' && req.method === 'GET') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: true,
                version: VERSION,
                pid: process.pid,
                uptimeSec: Math.floor(process.uptime()),
              }));
              return;
            }

            if (req.url === '/ready' && req.method === 'GET') {
              const state = eventManager.getState();
              const ready = state !== 'failed' && state !== 'disabled';
              const status = ready ? 200 : 503;
              const body: Record<string, unknown> = { ready, version: VERSION, mqtt: state };
              if (!ready) body.reason = state === 'disabled' ? 'mqtt disabled' : 'mqtt failed';
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(body));
              return;
            }

            if (req.url === '/metrics' && req.method === 'GET') {
              const mqttState = eventManager.getState();
              const metrics = `# HELP switchbot_mqtt_connected MQTT connection status (0=disconnected, 1=connected)
# TYPE switchbot_mqtt_connected gauge
switchbot_mqtt_connected ${mqttState === 'connected' ? 1 : 0}

# HELP switchbot_mqtt_state Current MQTT state (1 for the active state, 0 otherwise)
# TYPE switchbot_mqtt_state gauge
switchbot_mqtt_state{state="disabled"} ${mqttState === 'disabled' ? 1 : 0}
switchbot_mqtt_state{state="connecting"} ${mqttState === 'connecting' ? 1 : 0}
switchbot_mqtt_state{state="connected"} ${mqttState === 'connected' ? 1 : 0}
switchbot_mqtt_state{state="reconnecting"} ${mqttState === 'reconnecting' ? 1 : 0}
switchbot_mqtt_state{state="failed"} ${mqttState === 'failed' ? 1 : 0}

# HELP switchbot_mqtt_subscribers Number of active event subscribers
# TYPE switchbot_mqtt_subscribers gauge
switchbot_mqtt_subscribers ${eventManager.getSubscriberCount()}

# HELP process_uptime_seconds Process uptime in seconds
# TYPE process_uptime_seconds gauge
process_uptime_seconds ${Math.floor(process.uptime())}
`;
              res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
              res.end(metrics);
              return;
            }

            // Extract profile from header or query string
            const headerProfile = req.headers['x-switchbot-profile'];
            const profileHeader = Array.isArray(headerProfile) ? headerProfile[0] : headerProfile;
            let profileQuery: string | undefined;
            try {
              const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
              profileQuery = url.searchParams.get('profile') ?? undefined;
            } catch { /* ignore */ }
            const profile = profileHeader || profileQuery;

            // CORS preflight
            if (req.method === 'OPTIONS') {
              if (corsOrigins.length > 0) {
                const origin = req.headers.origin;
                if (origin && corsOrigins.includes(origin)) {
                  res.writeHead(200, {
                    'Access-Control-Allow-Origin': origin,
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                  });
                  res.end();
                  return;
                }
              }
              res.writeHead(204);
              res.end();
              return;
            }

            // Rate limit check
            if (!checkRateLimit(profile ?? 'default')) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' }, id: null }));
              return;
            }

            // Auth check
            const authHeader = req.headers.authorization;
            const [scheme, token] = (authHeader ?? '').split(' ');
            if (authToken && (scheme !== 'Bearer' || !tokenMatch(token))) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
              return;
            }

            // CORS headers for allowed origins
            if (corsOrigins.length > 0) {
              const origin = req.headers.origin;
              if (origin && corsOrigins.includes(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
              }
            }

            // Reject unknown profiles early: avoids confusing downstream credential
            // errors and protects against probing for valid profile names.
            if (profile) {
              const envCredsPresent = !!(process.env.SWITCHBOT_TOKEN && process.env.SWITCHBOT_SECRET);
              if (!envCredsPresent && !fs.existsSync(profileFilePath(profile))) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  jsonrpc: '2.0',
                  error: { code: -32001, message: `Unknown profile: ${profile}` },
                  id: null,
                }));
                return;
              }
            }

            // Stateless mode: fresh transport+server per request (SDK requirement).
            const reqTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            const reqServer = createSwitchBotMcpServer({ eventManager });
            // Register cleanup before any async work so it fires on both normal
            // close and error-path close (after the 500 response ends).
            res.on('close', () => {
              reqTransport.close();
              reqServer.close();
            });
            // Route per-request credentials via AsyncLocalStorage so loadConfig()
            // picks up this request's profile instead of the process-global flag.
            await withRequestContext({ profile: profile ?? undefined }, async () => {
              try {
                await reqServer.connect(reqTransport);
                await reqTransport.handleRequest(req, res);
              } catch (err) {
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
                }
              }
            });
          });

          // Graceful shutdown
          let isShuttingDown = false;
          const gracefulShutdown = async () => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            console.error('Shutting down...');
            await eventManager.shutdown();
            httpServer.close(() => {
              console.error('Server closed');
              process.exit(0);
            });
            // Force exit after 30s
            setTimeout(() => {
              console.error('Force exiting after 30s timeout');
              process.exit(1);
            }, 30000);
          };
          process.on('SIGTERM', gracefulShutdown);
          process.on('SIGINT', gracefulShutdown);

          httpServer.listen(port, bind, () => {
            console.error(`SwitchBot MCP server listening on http://${bind}:${port}/mcp`);
            if (authToken) {
              console.error('  Authentication: required (Bearer token)');
            }
            if (corsOrigins.length > 0) {
              console.error(`  CORS origins: ${corsOrigins.join(', ')}`);
            }
          });
          return;
        }

        const eventManager = new EventSubscriptionManager();
        const mqttCreds = tryLoadConfig();
        if (mqttCreds) {
          eventManager.initialize(mqttCreds.token, mqttCreds.secret).catch((err: unknown) => {
            console.error('MQTT initialization failed:', err instanceof Error ? err.message : String(err));
          });
        }
        const server = createSwitchBotMcpServer({ eventManager });
        const transport = new StdioServerTransport();
        await server.connect(transport);

        let isShuttingDown = false;
        const gracefulShutdown = async () => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          console.error('Shutting down...');
          // Force exit after 30s if shutdown hangs (e.g. stuck MQTT disconnect).
          const forceExit = setTimeout(() => {
            console.error('Force exiting after 30s timeout');
            process.exit(1);
          }, 30000);
          forceExit.unref();
          try {
            await eventManager.shutdown();
          } catch (err) {
            console.error('Error during shutdown:', err instanceof Error ? err.message : String(err));
          }
          process.exit(0);
        };

        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);
        process.stdin.on('end', gracefulShutdown);
      } catch (error) {
        handleError(error);
      }
    });
}
