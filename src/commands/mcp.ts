import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { handleError } from '../utils/output.js';
import {
  fetchDeviceList,
  fetchDeviceStatus,
  executeCommand,
  describeDevice,
  validateCommand,
  isDestructiveCommand,
  searchCatalog,
  DeviceNotFoundError,
} from '../lib/devices.js';
import { fetchScenes, executeScene } from '../lib/scenes.js';
import { findCatalogEntry } from '../devices/catalog.js';
import { getCachedDevice } from '../devices/cache.js';

/**
 * Factory — build an McpServer with the six SwitchBot tools registered.
 * Exported so tests and alternative transports can reuse it.
 */
export function createSwitchBotMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'switchbot',
      version: '1.4.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'SwitchBot device control. Before issuing a command with destructive effects (e.g. unlock, garage open, keypad createKey), pass confirm:true. Use search_catalog to discover what a device type supports offline; use describe_device to fetch live capabilities for a specific deviceId.',
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
    },
    async () => {
      const body = await fetchDeviceList();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(body, null, 2),
          },
        ],
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
    },
    async ({ deviceId }) => {
      const body = await fetchDeviceStatus(deviceId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(body, null, 2),
          },
        ],
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
          return {
            isError: true,
            content: [{ type: 'text', text: `Device not found: ${deviceId}` }],
          };
        }
        typeName = physical ? physical.deviceType : ir!.remoteType;
      }

      if (isDestructiveCommand(typeName, command, effectiveType) && !confirm) {
        const entry = typeName ? findCatalogEntry(typeName) : null;
        const spec =
          entry && !Array.isArray(entry)
            ? entry.commands.find((c) => c.command === command)
            : undefined;
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: 'destructive_requires_confirm',
                  message: `Command "${command}" on device type "${typeName}" is destructive and requires confirm:true.`,
                  command,
                  deviceType: typeName,
                  description: spec?.description,
                  hint: 'Re-issue the call with confirm:true to proceed.',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // stringifiedParam is what validateCommand expects to decide
      // "no-parameter" conflicts — mirror the CLI behavior.
      const stringifiedParam =
        parameter === undefined ? undefined : typeof parameter === 'string' ? parameter : JSON.stringify(parameter);
      const validation = validateCommand(deviceId, command, stringifiedParam, effectiveType);
      if (!validation.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: 'validation_failed',
                  message: validation.error.message,
                  kind: validation.error.kind,
                  hint: validation.error.hint,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const result = await executeCommand(deviceId, command, parameter, effectiveType);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                command,
                deviceId,
                result,
              },
              null,
              2
            ),
          },
        ],
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
    },
    async ({ sceneId }) => {
      await executeScene(sceneId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, sceneId }, null, 2),
          },
        ],
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
    },
    async () => {
      const scenes = await fetchScenes();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(scenes, null, 2),
          },
        ],
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
    },
    async ({ query, limit }) => {
      const hits = searchCatalog(query, limit);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(hits, null, 2),
          },
        ],
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
    },
    async ({ deviceId, live }) => {
      try {
        const result = await describeDevice(deviceId, { live });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof DeviceNotFoundError) {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
    }
  );

  return server;
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('Run as a Model Context Protocol server so AI agents can call SwitchBot tools')
    .addHelpText('after', `
The MCP server exposes seven tools over stdio:
  - list_devices          fetch all physical + IR devices
  - get_device_status     live status for a physical device
  - send_command          control a device (destructive commands need confirm:true)
  - list_scenes           list all manual scenes
  - run_scene             execute a manual scene
  - search_catalog        offline catalog search by type/alias
  - describe_device       metadata + commands + (optionally) live status for one device

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
    .description('Start the MCP server on stdio')
    .action(async () => {
      try {
        const server = createSwitchBotMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        // stdio transport keeps the process alive; return without exiting.
      } catch (error) {
        handleError(error);
      }
    });
}
