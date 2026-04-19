import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { handleError, isJsonMode } from '../utils/output.js';
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
import { findCatalogEntry } from '../devices/catalog.js';
import { getCachedDevice } from '../devices/cache.js';
import { EventSubscriptionManager } from '../mcp/events-subscription.js';
import { resolveTargetIds, runBatchCommand } from './batch.js';
import { runPlan, validatePlan } from './plan.js';
import { createClient } from '../api/client.js';
import { loadConfigForProfile, type SwitchBotConfig } from '../config.js';
import { todayUsage } from '../utils/quota.js';

/**
 * Factory — build an McpServer with the SwitchBot tools registered
 * (device control, plan run, webhooks, quota, events resource).
 */

type McpErrorKind = 'api' | 'runtime' | 'usage' | 'guard';

function mcpError(
  kind: McpErrorKind,
  code: number,
  message: string,
  options?: { hint?: string; retryable?: boolean; context?: Record<string, unknown> },
) {
  const obj: Record<string, unknown> = { code, kind, message };
  if (options?.hint) obj.hint = options.hint;
  if (options?.retryable) obj.retryable = true;
  if (options?.context) obj.context = options.context;
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: obj }, null, 2) }],
  };
}

export interface McpServerOptions {
  /**
   * Resolve SwitchBot credentials for this server instance. Called lazily
   * on every tool/resource invocation so HTTP transport can build one
   * server per request and pass a resolver that reads per-request headers.
   * Defaults to `loadConfigForProfile()` (no profile — falls back to env
   * or ~/.switchbot/config.json).
   */
  configResolver?: () => SwitchBotConfig;
}

export function createSwitchBotMcpServer(options: McpServerOptions = {}): McpServer {
  const configResolver = options.configResolver ?? (() => loadConfigForProfile());
  const getClient = () => createClient(configResolver());
  const server = new McpServer(
    {
      name: 'switchbot',
      version: '1.6.0',
    },
    {
      capabilities: { tools: {}, resources: { subscribe: true } },
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
        'Fetch the inventory of physical devices and IR remotes on this SwitchBot account. Refreshes the local cache.',
      inputSchema: {},
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
      const body = await fetchDeviceList(getClient());
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
      inputSchema: {
        deviceId: z.string().describe('Device ID from list_devices'),
      },
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
      const body = await fetchDeviceStatus(deviceId, getClient());
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        structuredContent: { status: body as { deviceId?: string; deviceType?: string; [key: string]: unknown } },
      };
    }
  );

  // ---- send_command ---------------------------------------------------------
  server.registerTool(
    'send_command',
    {
      title: 'Send a control command to a device',
      description:
        'Send a control command (turnOn, setColor, startClean, unlock, ...) to a device. Destructive commands (unlock, garage open, keypad createKey) require confirm:true; otherwise they are rejected.',
      inputSchema: {
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
      },
      outputSchema: {
        ok: z.literal(true),
        command: z.string(),
        deviceId: z.string(),
        result: z.unknown().describe('API response body from SwitchBot'),
      },
    },
    async ({ deviceId, command, parameter, commandType, confirm }) => {
      const effectiveType = commandType ?? 'command';

      // Resolve the device's catalog type via cache or a fresh lookup so we
      // can evaluate destructive/validation without an extra round-trip if
      // the cache is warm.
      let typeName = getCachedDevice(deviceId)?.type;
      if (!typeName) {
        const body = await fetchDeviceList(getClient());
        const physical = body.deviceList.find((d) => d.deviceId === deviceId);
        const ir = body.infraredRemoteList.find((d) => d.deviceId === deviceId);
        if (!physical && !ir) {
          return mcpError('runtime', 152, `Device not found: ${deviceId}`, {
            hint: "Check the deviceId with 'switchbot devices list' (IDs are case-sensitive).",
          });
        }
        typeName = physical ? physical.deviceType : ir!.remoteType;
      }

      if (isDestructiveCommand(typeName, command, effectiveType) && !confirm) {
        const reason = getDestructiveReason(typeName, command, effectiveType);
        const entry = typeName ? findCatalogEntry(typeName) : null;
        const spec =
          entry && !Array.isArray(entry)
            ? entry.commands.find((c) => c.command === command)
            : undefined;
        const hint = reason
          ? `Re-issue with confirm:true after confirming with the user. Reason: ${reason}`
          : 'Re-issue the call with confirm:true to proceed.';
        return mcpError(
          'guard', 3,
          `Command "${command}" on device type "${typeName}" is destructive and requires confirm:true.`,
          {
            hint,
            context: {
              command,
              deviceType: typeName,
              description: spec?.description ?? null,
              ...(reason ? { destructiveReason: reason } : {}),
            },
          },
        );
      }

      // stringifiedParam is what validateCommand expects to decide
      // "no-parameter" conflicts — mirror the CLI behavior.
      const stringifiedParam =
        parameter === undefined ? undefined : typeof parameter === 'string' ? parameter : JSON.stringify(parameter);
      const validation = validateCommand(deviceId, command, stringifiedParam, effectiveType);
      if (!validation.ok) {
        return mcpError(
          'usage', 2,
          validation.error.message,
          { hint: validation.error.hint, context: { validationKind: validation.error.kind } },
        );
      }

      const result = await executeCommand(deviceId, command, parameter, effectiveType, getClient());
      const structured = { ok: true as const, command, deviceId, result };
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
      inputSchema: {
        sceneId: z.string().describe('Scene ID from list_scenes'),
      },
      outputSchema: {
        ok: z.literal(true),
        sceneId: z.string(),
      },
    },
    async ({ sceneId }) => {
      await executeScene(sceneId, getClient());
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
      inputSchema: {},
      outputSchema: {
        scenes: z.array(z.object({ sceneId: z.string(), sceneName: z.string() })),
      },
    },
    async () => {
      const scenes = await fetchScenes(getClient());
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
      inputSchema: {
        query: z.string().describe('Search query (matches type and aliases, case-insensitive). Use empty string to list all.'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max entries returned (default 20)'),
      },
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
      const hits = searchCatalog(query, limit);
      const structured = { results: hits as unknown as Array<Record<string, unknown>>, total: hits.length };
      return {
        content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }],
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
      inputSchema: {
        deviceId: z.string().describe('Device ID from list_devices'),
        live: z.boolean().optional().default(false).describe('Also fetch live /status values (costs 1 extra API call)'),
      },
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
        const result = await describeDevice(deviceId, { live }, getClient());
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
        throw err;
      }
    }
  );

  // ---- events resource + events_recent -------------------------------------
  const eventsManager = new EventSubscriptionManager();
  const EVENTS_URI = 'switchbot://events';
  // Per-MCP-client subscription state: one unsubscribe function per URI.
  const activeSubscriptions = new Map<string, () => Promise<void>>();

  server.registerResource(
    'events',
    EVENTS_URI,
    {
      title: 'Live device shadow events (MQTT)',
      description:
        'Subscribe to receive notifications/resources/updated on every SwitchBot shadow event (device status change). Read returns the most recent 100 events as a JSON array.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const events = eventsManager.getRecent();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ events }, null, 2),
        }],
      };
    },
  );

  // Hook resources/subscribe -> start forwarding events as resource-updated
  // notifications. Ref-counted inside eventsManager so multiple subscribers
  // share one upstream MQTT client.
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    if (request.params.uri !== EVENTS_URI) {
      throw new Error(`Resource "${request.params.uri}" does not support subscription`);
    }
    if (activeSubscriptions.has(EVENTS_URI)) {
      return {};
    }
    const unsubscribe = await eventsManager.subscribe(() => {
      void server.server.sendResourceUpdated({ uri: EVENTS_URI });
    });
    activeSubscriptions.set(EVENTS_URI, unsubscribe);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const unsub = activeSubscriptions.get(request.params.uri);
    if (unsub) {
      activeSubscriptions.delete(request.params.uri);
      await unsub();
    }
    return {};
  });

  // Tear down MQTT on server close.
  const originalClose = server.close.bind(server);
  server.close = async () => {
    try { await eventsManager.shutdown(); } catch { /* best-effort */ }
    activeSubscriptions.clear();
    return originalClose();
  };

  server.registerTool(
    'events_recent',
    {
      title: 'Return the most recent buffered shadow events',
      description:
        'Returns the last N MQTT shadow events captured since this MCP server started. Use subscribe(switchbot://events) for push-style delivery.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max events returned (default 20, max 100)'),
      },
      outputSchema: {
        events: z.array(z.object({
          ts: z.string(),
          deviceId: z.string(),
          deviceType: z.string(),
          payload: z.record(z.string(), z.unknown()),
        })),
        total: z.number().int(),
      },
    },
    async ({ limit }) => {
      const events = eventsManager.getRecent(limit);
      const structured = { events, total: events.length };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    },
  );

  // ---- devices_batch --------------------------------------------------------
  server.registerTool(
    'devices_batch',
    {
      title: 'Send the same command to many devices',
      description:
        'Fan a single command out to many devices in parallel. Provide either explicit ids[] OR a filter string (e.g. "type=Bot,family=Home"). Destructive commands require yes:true. Returns per-device succeeded/failed breakdown.',
      inputSchema: {
        command: z.string().describe('Command name, e.g. turnOn, turnOff, setBrightness'),
        parameter: z
          .union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .optional()
          .describe('Command parameter (omit for no-arg commands)'),
        ids: z.array(z.string()).optional().describe('Explicit list of deviceIds to target'),
        filter: z.string().optional().describe('Filter expression, e.g. "type=Bot,family=Home"'),
        commandType: z.enum(['command', 'customize']).optional().default('command'),
        concurrency: z.number().int().min(1).max(20).optional().default(5),
        yes: z.boolean().optional().default(false).describe('Required true for destructive commands (unlock, garage open, ...)'),
      },
    },
    async ({ command, parameter, ids, filter, commandType, concurrency, yes }) => {
      if ((!ids || ids.length === 0) && !filter) {
        return mcpError('usage', 2, 'devices_batch requires ids[] or filter to pick targets', {
          hint: 'Pass ids:["ID1","ID2"] or filter:"type=Bot,family=Home".',
        });
      }
      try {
        const resolved = await resolveTargetIds({
          filter,
          ids: ids?.join(','),
          readStdin: false,
        }, getClient);
        if (resolved.ids.length === 0) {
          const empty = { succeeded: [], failed: [], summary: { total: 0, ok: 0, failed: 0, skipped: 0, durationMs: 0 } };
          return {
            content: [{ type: 'text', text: JSON.stringify(empty, null, 2) }],
            structuredContent: empty,
          };
        }
        const result = await runBatchCommand({
          ids: resolved.ids,
          typeMap: resolved.typeMap,
          command,
          parameter,
          commandType,
          concurrency,
          yes,
          getClient,
        });
        if ('blocked' in result) {
          return mcpError(
            'guard', 3,
            `Destructive command "${command}" requires yes:true on ${result.devices.length} device(s).`,
            {
              hint: 'Re-issue the call with yes:true after confirming with the user.',
              context: { command, deviceIds: result.devices.map((d) => d.deviceId) },
            },
          );
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpError('runtime', 1, msg);
      }
    },
  );

  // ---- plan_run -------------------------------------------------------------
  server.registerTool(
    'plan_run',
    {
      title: 'Execute an agent-authored plan',
      description:
        'Validate and execute a SwitchBot plan (version 1.0). The plan JSON describes a sequence of command/scene/wait steps. Destructive steps require yes:true.',
      inputSchema: {
        plan: z
          .object({
            version: z.string(),
            description: z.string().optional(),
            steps: z.array(z.record(z.string(), z.unknown())),
          })
          .passthrough()
          .describe('Plan object (see `switchbot plan schema` for the full JSON Schema)'),
        yes: z.boolean().optional().default(false).describe('Authorize destructive steps (unlock, garage open, ...)'),
        continueOnError: z.boolean().optional().default(false).describe('Keep running after a failed step'),
      },
    },
    async ({ plan, yes, continueOnError }) => {
      const v = validatePlan(plan);
      if (!v.ok) {
        return mcpError('usage', 2, 'plan failed schema validation', {
          context: { issues: v.issues },
        });
      }
      try {
        const out = await runPlan(v.plan, { yes, continueOnError });
        return {
          content: [{ type: 'text', text: JSON.stringify({ ran: true, ...out }, null, 2) }],
          structuredContent: { ran: true, ...out } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpError('runtime', 1, msg);
      }
    },
  );

  // ---- webhook tools --------------------------------------------------------
  function assertWebhookUrl(url: string): string | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return `Invalid URL "${url}"`; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `URL must use http:// or https:// (got "${parsed.protocol}")`;
    }
    return null;
  }

  server.registerTool(
    'webhook_setup',
    {
      title: 'Configure the webhook receiver URL',
      description:
        'Register an absolute http(s):// URL where SwitchBot will POST state-change events. Only one webhook is active per account.',
      inputSchema: {
        url: z.string().describe('Absolute http(s):// URL'),
      },
    },
    async ({ url }) => {
      const err = assertWebhookUrl(url);
      if (err) return mcpError('usage', 2, err);
      try {
        const client = getClient();
        await client.post('/v1.1/webhook/setupWebhook', { action: 'setupWebhook', url, deviceList: 'ALL' });
        const structured = { ok: true as const, url };
        return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      } catch (e) {
        return mcpError('api', 1, e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'webhook_query',
    {
      title: 'Query webhook configuration',
      description:
        'List all configured webhook URLs, or pass `url` to fetch the enable/deviceList/timestamps for a specific one.',
      inputSchema: {
        url: z.string().optional().describe('If set, fetch details for this URL; otherwise list all'),
      },
    },
    async ({ url }) => {
      try {
        const client = getClient();
        if (url) {
          const res = await client.post<{ body: unknown[] }>(
            '/v1.1/webhook/queryWebhook',
            { action: 'queryDetails', urls: [url] },
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(res.data.body ?? [], null, 2) }],
            structuredContent: { details: res.data.body ?? [] },
          };
        }
        const res = await client.post<{ body: { urls: string[] } }>(
          '/v1.1/webhook/queryWebhook',
          { action: 'queryUrl' },
        );
        const urls = res.data.body.urls ?? [];
        return {
          content: [{ type: 'text', text: JSON.stringify({ urls }, null, 2) }],
          structuredContent: { urls },
        };
      } catch (e) {
        return mcpError('api', 1, e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'webhook_update',
    {
      title: 'Enable, disable, or re-submit a webhook',
      description:
        'Update an already-registered webhook URL. Pass enable:true or enable:false to toggle; omit to re-submit without change.',
      inputSchema: {
        url: z.string().describe('URL of the webhook to update'),
        enable: z.boolean().optional().describe('true enables, false disables; omit for no-change re-submit'),
      },
    },
    async ({ url, enable }) => {
      const err = assertWebhookUrl(url);
      if (err) return mcpError('usage', 2, err);
      try {
        const client = getClient();
        const config: { url: string; enable?: boolean } = { url };
        if (enable !== undefined) config.enable = enable;
        await client.post('/v1.1/webhook/updateWebhook', { action: 'updateWebhook', config });
        const status = enable === true ? 'enabled' : enable === false ? 'disabled' : 'updated';
        const structured = { ok: true as const, url, status };
        return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      } catch (e) {
        return mcpError('api', 1, e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'webhook_delete',
    {
      title: 'Delete a webhook',
      description: 'Remove a webhook registration by URL.',
      inputSchema: {
        url: z.string().describe('URL of the webhook to remove'),
      },
    },
    async ({ url }) => {
      const err = assertWebhookUrl(url);
      if (err) return mcpError('usage', 2, err);
      try {
        const client = getClient();
        await client.post('/v1.1/webhook/deleteWebhook', { action: 'deleteWebhook', url });
        const structured = { ok: true as const, url };
        return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      } catch (e) {
        return mcpError('api', 1, e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ---- quota_status ---------------------------------------------------------
  server.registerTool(
    'quota_status',
    {
      title: "Report today's local API quota usage",
      description:
        "Return today's locally-tracked SwitchBot API usage (10,000/day budget). `serverQuotaKnown` is true when a ratelimit header has been observed this session; the `server.remaining` value is then advisory but authoritative.",
      inputSchema: {},
      outputSchema: {
        date: z.string(),
        total: z.number().int(),
        remaining: z.number().int(),
        endpoints: z.record(z.string(), z.number().int()),
        serverQuotaKnown: z.boolean(),
        server: z.object({
          remaining: z.number().int(),
          observedAt: z.string(),
        }).optional(),
      },
    },
    async () => {
      const usage = todayUsage();
      const structured = {
        ...usage,
        serverQuotaKnown: usage.server !== undefined,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    },
  );

  return server;
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('Run as a Model Context Protocol server so AI agents can call SwitchBot tools')
    .addHelpText('after', `
The MCP server exposes these tools over stdio:
  list_devices            fetch all physical + IR devices
  get_device_status       live status for a physical device
  send_command            control a device (destructive commands need confirm:true)
  devices_batch           run one command across many devices in parallel
  list_scenes             list all manual scenes
  run_scene               execute a manual scene
  search_catalog          offline catalog search by type/alias
  describe_device         metadata + commands + (optionally) live status for one device
  events_recent           last N MQTT shadow events from the in-process buffer
  plan_run                validate + execute a SwitchBot plan (v1.0)
  webhook_setup           configure the account's webhook receiver URL
  webhook_query           list webhook URLs, or fetch details for one
  webhook_update          enable/disable a registered webhook URL
  webhook_delete          remove a webhook registration
  quota_status            today's local API quota usage

And one subscribable resource:
  switchbot://events      push notifications/resources/updated on every shadow event

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

HTTP transport (multi-tenant):
  $ switchbot mcp serve --port 3030
  Pass x-switchbot-profile: <name> header (or ?profile=<name> query string)
  to route a request to ~/.switchbot/profiles/<name>.json. Stdio sessions
  always use the profile from --profile / default config.
`);

  mcp
    .command('serve')
    .description('Start the MCP server on stdio (default) or HTTP (--port)')
    .option('--port <n>', 'Listen on HTTP instead of stdio (Streamable HTTP transport)')
    .action(async (options: { port?: string }) => {
      try {
        if (options.port) {
          const port = Number(options.port);
          if (!Number.isFinite(port) || port < 1 || port > 65535) {
            const msg = `Invalid --port "${options.port}". Must be 1-65535.`;
            if (isJsonMode()) {
              console.error(JSON.stringify({ error: { code: 2, kind: 'usage', message: msg } }));
            } else {
              console.error(msg);
            }
            process.exit(2);
          }
          const { createServer } = await import('node:http');
          const httpServer = createServer(async (req, res) => {
            // Stateless mode: fresh transport+server per request (SDK requirement).
            const reqTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            // Per-request profile: read x-switchbot-profile header (or
            // ?profile= query string) so multi-tenant MCP hosts can route
            // different users to different credentials.
            const headerProfile = req.headers['x-switchbot-profile'];
            const profileHeader = Array.isArray(headerProfile) ? headerProfile[0] : headerProfile;
            let profileQuery: string | undefined;
            try {
              const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
              profileQuery = url.searchParams.get('profile') ?? undefined;
            } catch { /* ignore */ }
            const profile = profileHeader || profileQuery;
            const reqServer = createSwitchBotMcpServer({
              configResolver: () => loadConfigForProfile(profile),
            });
            // Register cleanup before any async work so it fires on both normal
            // close and error-path close (after the 500 response ends).
            res.on('close', () => {
              reqTransport.close();
              reqServer.close();
            });
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
          httpServer.listen(port, () => {
            console.error(`SwitchBot MCP server listening on http://localhost:${port}/mcp`);
          });
          return;
        }

        const server = createSwitchBotMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
      } catch (error) {
        handleError(error);
      }
    });
}
