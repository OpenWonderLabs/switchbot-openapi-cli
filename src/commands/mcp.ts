import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { intArg, stringArg } from '../utils/arg-parsers.js';
import { handleError, isJsonMode, buildErrorPayload, emitJsonError, exitWithError, type ErrorPayload, type ErrorSubKind } from '../utils/output.js';
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
            destructive: z.boolean().optional(),
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
            destructive: tier === 'destructive',
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
          deviceId: z.string().min(1),
          since: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          metrics: z.array(z.string().min(1)).min(1),
          aggs: z.array(z.enum(ALL_AGG_FNS as unknown as [AggFn, ...AggFn[]])).optional(),
          bucket: z.string().optional(),
          maxBucketSamples: z.number().int().positive().max(MAX_SAMPLE_CAP).optional(),
        })
        .strict(),
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
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        structuredContent: res as unknown as Record<string, unknown>,
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

  return server;
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('Run as a Model Context Protocol server so AI agents can call SwitchBot tools')
    .addHelpText('after', `
The MCP server exposes eleven tools:
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
