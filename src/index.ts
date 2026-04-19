#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { createRequire } from 'node:module';
import { registerConfigCommand } from './commands/config.js';
import { registerDevicesCommand } from './commands/devices.js';
import { registerScenesCommand } from './commands/scenes.js';
import { registerWebhookCommand } from './commands/webhook.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerQuotaCommand } from './commands/quota.js';
import { registerCatalogCommand } from './commands/catalog.js';
import { registerCacheCommand } from './commands/cache.js';
import { registerEventsCommand } from './commands/events.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerSchemaCommand } from './commands/schema.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerCapabilitiesCommand } from './commands/capabilities.js';
import { beginCommand } from './utils/output.js';

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('switchbot')
  .description('Command-line tool for SwitchBot API v1.1')
  .version(pkgVersion)
  .option('--json', 'Output raw JSON response (disables tables; useful for pipes/scripts)')
  .option('--format <type>', 'Output format: table (default), json, jsonl, tsv, yaml, id')
  .option('--fields <csv>', 'Comma-separated list of columns to include (e.g. --fields=id,name,type)')
  .option('-v, --verbose', 'Log HTTP request/response details to stderr')
  .option('--dry-run', 'Print mutating requests without sending them (GETs still execute)')
  .option('--timeout <ms>', 'HTTP request timeout in milliseconds (default: 30000)')
  .option('--retry-on-429 <n>', 'Max 429 retries before surfacing the error (default: 3)')
  .option('--backoff <strategy>', 'Backoff strategy for retries: "linear" or "exponential" (default)')
  .option('--no-retry', 'Disable 429 retries entirely (equivalent to --retry-on-429 0)')
  .option('--no-quota', 'Disable the local ~/.switchbot/quota.json counter for this run')
  .option('--cache <mode>', 'Cache mode: "off" | "auto" (default: list 1h, status off) | duration like 5m, 1h, 30s (enables both stores)')
  .option('--no-cache', 'Disable cache reads (equivalent to --cache off)')
  .option('--config <path>', 'Override credential file location (default: ~/.switchbot/config.json)')
  .option('--profile <name>', 'Use a named profile: ~/.switchbot/profiles/<name>.json')
  .option('--audit-log [path]', 'Append every mutating command to JSONL audit log (default ~/.switchbot/audit.log)')
  .showHelpAfterError('(run with --help to see usage)')
  .showSuggestionAfterError()
  .hook('preAction', (_thisCommand, actionCommand) => {
    // Build dotted command path (e.g. "devices.status") by walking up parents.
    const names: string[] = [];
    let cur: Command | null = actionCommand;
    while (cur && cur.name() !== 'switchbot') {
      names.unshift(cur.name());
      cur = cur.parent;
    }
    beginCommand(names.join('.'));
  });

registerConfigCommand(program);
registerDevicesCommand(program);
registerScenesCommand(program);
registerWebhookCommand(program);
registerCompletionCommand(program);
registerMcpCommand(program);
registerQuotaCommand(program);
registerCatalogCommand(program);
registerCacheCommand(program);
registerEventsCommand(program);
registerDoctorCommand(program);
registerSchemaCommand(program);
registerHistoryCommand(program);
registerPlanCommand(program);
registerCapabilitiesCommand(program);

program.addHelpText('after', `
Credentials:
  Provide SwitchBot API v1.1 credentials via either:
    • environment variables SWITCHBOT_TOKEN and SWITCHBOT_SECRET (take priority), or
    • ~/.switchbot/config.json written by 'switchbot config set-token'
    • override the file path with --config <path>

Exit codes:
  0  success (including --dry-run intercept)
  1  runtime error (API error, network failure, missing credentials, etc.)
  2  usage error (bad flag, unknown subcommand, invalid argument, unknown device type)

Environment:
  SWITCHBOT_TOKEN   credential token (takes priority over config file)
  SWITCHBOT_SECRET  credential secret (takes priority over config file)
  NO_COLOR          disable ANSI colors (auto-respected via chalk)

Examples:
  $ switchbot config set-token <token> <secret>
  $ switchbot devices list
  $ switchbot devices list --json | jq '.deviceList[].deviceId'
  $ switchbot devices describe <deviceId>         # what commands does this device support?
  $ switchbot devices commands <type>             # offline lookup, e.g. Bot / Curtain / "Smart Lock"
  $ switchbot devices status <deviceId>           # live state: battery, position, temperature, …
  $ switchbot devices command <deviceId> turnOn
  $ switchbot devices command <deviceId> turnOn --dry-run
  $ switchbot scenes execute <sceneId> --verbose
  $ switchbot webhook setup https://your.host/hook

Discovery:
  Don't know a device ID / what it supports?
    switchbot devices list                         → find your deviceIds + types
    switchbot devices describe <deviceId>          → live: metadata + supported commands
    switchbot devices status <deviceId>            → live: current values (battery, position, …)
    switchbot devices types                        → offline: list every known type
    switchbot devices commands <type>              → offline: commands + parameters + status fields for a type

Docs: https://github.com/OpenWonderLabs/SwitchBotAPI
`);

// Map commander usage errors (unknown option, missing argument, etc.) to exit code 2.
program.exitOverride((err: CommanderError) => {
  // --help and --version print to stdout and exit 0
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
    process.exit(0);
  }
  // Everything else from commander (unknown option, missing argument,
  // invalid choice, conflicting options, unknown command) is a usage error.
  process.exit(2);
});

try {
  await program.parseAsync();
} catch (err) {
  // exitOverride already handled CommanderErrors; anything that escapes is a
  // runtime error (should be rare since actions use handleError).
  if (err instanceof CommanderError) {
    process.exit(err.exitCode ?? 2);
  }
  throw err;
}
