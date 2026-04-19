import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
import { todayUsage } from '../utils/quota.js';
import { describeCache } from '../devices/cache.js';
import { withRequestContext } from '../lib/request-context.js';
import { profileFilePath } from '../config.js';
import { getMqttConfig } from '../mqtt/credential.js';
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

export function createSwitchBotMcpServer(options?: { eventManager?: EventSubscriptionManager }): McpServer {
  const eventManager = options?.eventManager;
  const server = new McpServer(
    {
      name: 'switchbot',
      version: '2.0.0',
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
      const body = await fetchDeviceStatus(deviceId);
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
        'Execute a control command on a device (turnOn, setColor, startClean, unlock, openDoor, createKey, etc.). Destructive commands (Smart Lock unlock, Garage Door open, Keypad createKey/deleteKey) require confirm:true to proceed; otherwise rejected. Commands are validated offline against the device catalog. Use idempotencyKey to safely deduplicate retries within 60 seconds.',
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

      const result = await executeCommand(deviceId, command, parameter, effectiveType);
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
      await executeScene(sceneId);
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
        throw err;
      }
    }
  );

  // ---- account_overview ---------------------------------------------------
  server.registerTool(
    'account_overview',
    {
      title: 'Bootstrap account overview',
      description:
        'Get a complete account snapshot: devices, scenes, quota usage, cache status, and MQTT connection state. Use this for cold-start initialization or periodic health checks.',
      inputSchema: {},
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
        }).optional().describe('MQTT connection state (HTTP mode only)'),
      },
    },
    async () => {
      const deviceList = await fetchDeviceList();
      const sceneList = await fetchScenes();
      const cacheInfo = describeCache();
      const quota = todayUsage();

      const overview = {
        version: '2.0.0',
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
          'State is "disabled" when MQTT credentials are not configured (set SWITCHBOT_MQTT_HOST / USERNAME / PASSWORD).',
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
The MCP server exposes eight tools:
  - list_devices          fetch all physical + IR devices
  - get_device_status     live status for a physical device
  - send_command          control a device (destructive commands need confirm:true)
  - list_scenes           list all manual scenes
  - run_scene             execute a manual scene
  - search_catalog        offline catalog search by type/alias
  - describe_device       metadata + commands + (optionally) live status for one device
  - account_overview      single cold-start snapshot: devices + scenes + quota + cache + MQTT state

Resource (read-only):
  - switchbot://events    snapshot of recent MQTT shadow events from the ring buffer
    Requires SWITCHBOT_MQTT_HOST / SWITCHBOT_MQTT_USERNAME / SWITCHBOT_MQTT_PASSWORD
    env vars; returns {state:"disabled"} when not configured.

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
    .option('--port <n>', 'Listen on HTTP instead of stdio (Streamable HTTP transport)')
    .option('--bind <host>', 'IP address to bind (default 127.0.0.1; use 0.0.0.0 to accept external connections)', '127.0.0.1')
    .option('--auth-token <token>', 'Bearer token for HTTP requests (required for --bind 0.0.0.0; falls back to SWITCHBOT_MCP_TOKEN env var)')
    .option('--cors-origin <url>', 'Allowed CORS origin(s) for HTTP (repeatable)')
    .option('--rate-limit <n>', 'Max requests per minute per profile (default 60)', '60')
    .action(async (options: { port?: string; bind?: string; authToken?: string; corsOrigin?: string | string[]; rateLimit?: string }) => {
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

          const bind = options.bind ?? '127.0.0.1';
          const authToken = options.authToken ?? process.env.SWITCHBOT_MCP_TOKEN;
          const corsOrigins = Array.isArray(options.corsOrigin) ? options.corsOrigin : (options.corsOrigin ? [options.corsOrigin] : []);
          const rateLimit = Math.max(1, Number(options.rateLimit) || 60);

          // Guard: refuse to bind non-localhost without auth
          const isLocalhost = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
          if (!isLocalhost && !authToken) {
            const msg = 'Refusing to listen on 0.0.0.0 without --auth-token. Pass --auth-token <token> or bind to localhost (default).';
            if (isJsonMode()) {
              console.error(JSON.stringify({ error: { code: 2, kind: 'usage', message: msg } }));
            } else {
              console.error(msg);
            }
            process.exit(2);
          }

          const { createServer } = await import('node:http');
          const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

          // Initialize shared EventSubscriptionManager for event streaming.
          // If MQTT creds are present, connect in the background so the HTTP server
          // starts immediately; /ready reflects the real state.
          const eventManager = new EventSubscriptionManager();
          const mqttConfig = getMqttConfig();
          if (mqttConfig) {
            eventManager.initialize(mqttConfig).catch((err: unknown) => {
              console.error('MQTT initialization failed:', err instanceof Error ? err.message : String(err));
            });
          } else {
            console.error('MQTT disabled: set SWITCHBOT_MQTT_HOST, SWITCHBOT_MQTT_USERNAME, SWITCHBOT_MQTT_PASSWORD to enable real-time events.');
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
                version: '2.0.0',
                pid: process.pid,
                uptimeSec: Math.floor(process.uptime()),
              }));
              return;
            }

            if (req.url === '/ready' && req.method === 'GET') {
              const state = eventManager.getState();
              const ready = state !== 'failed' && state !== 'disabled';
              const status = ready ? 200 : 503;
              const body: Record<string, unknown> = { ready, version: '2.0.0', mqtt: state };
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
        const mqttConfig = getMqttConfig();
        if (mqttConfig) {
          eventManager.initialize(mqttConfig).catch((err: unknown) => {
            console.error('MQTT initialization failed:', err instanceof Error ? err.message : String(err));
          });
        }
        const server = createSwitchBotMcpServer({ eventManager });
        const transport = new StdioServerTransport();
        await server.connect(transport);
      } catch (error) {
        handleError(error);
      }
    });
}
