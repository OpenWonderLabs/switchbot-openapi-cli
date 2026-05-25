// packages/openclaw-skill/index.js
//
// This package does not register a hand-maintained JavaScript tool subset.
// OpenClaw launches the stdio entry declared in `.mcp.json`, which executes
// `bin/start.js`; that bootstrapper then delegates to `switchbot mcp serve`.

export const MCP_SERVER_NAME = 'switchbot';
export const MCP_TRANSPORT = 'stdio';
export const MCP_ENTRY_COMMAND = 'node';
export const MCP_ENTRY_ARGS = ['${pluginDir}/bin/start.js'];
export const MCP_DELEGATE_COMMAND = ['switchbot', 'mcp', 'serve'];

export function createServer() {
  return {
    name: MCP_SERVER_NAME,
    transport: MCP_TRANSPORT,
    command: MCP_ENTRY_COMMAND,
    args: [...MCP_ENTRY_ARGS],
    delegateCommand: [...MCP_DELEGATE_COMMAND],
  };
}

export default createServer;
