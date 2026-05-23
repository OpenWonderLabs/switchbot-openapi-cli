// packages/openclaw-skill/index.js
import { buildCliArgs, runCli } from './cli.js';

const TOOLS = [
  'devices_list',
  'devices_status',
  'devices_describe',
  'devices_command',
  'scenes_list',
  'scenes_run',
];

export function createServer() {
  const _registeredTools = {};
  for (const tool of TOOLS) {
    _registeredTools[tool] = (params) => runCli(buildCliArgs({ tool, params }));
  }
  return { _registeredTools };
}
