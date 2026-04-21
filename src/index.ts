#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { createRequire } from 'node:module';
import chalk from 'chalk';
import { intArg, stringArg, enumArg } from './utils/arg-parsers.js';
import { parseDurationToMs } from './utils/flags.js';
import { emitJsonError, isJsonMode, printJson } from './utils/output.js';
import { commandToJson, resolveTargetCommand } from './utils/help-json.js';
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
import { registerAgentBootstrapCommand } from './commands/agent-bootstrap.js';

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require('../package.json') as { version: string };

// Early initialization: check for --no-color flag or NO_COLOR env var and disable chalk.
// This must happen before any commands run so all chalk output is affected.
if (process.argv.includes('--no-color') || Boolean(process.env.NO_COLOR)) {
  chalk.level = 0;
}

const program = new Command();
if (isJsonMode()) {
  // In --json mode, commander writes plain-text usage errors by default.
  // Silence that channel and emit a single structured error in the catch block.
  program.configureOutput({ writeErr: () => {} });
}

// Top-level subcommand names. Used by stringArg to produce clearer errors when
// a value is omitted and the next argv token turns out to be a subcommand name.
const TOP_LEVEL_COMMANDS = [
  'config', 'devices', 'scenes', 'webhook', 'completion', 'mcp',
  'quota', 'catalog', 'cache', 'events', 'doctor', 'schema',
  'history', 'plan', 'capabilities', 'agent-bootstrap',
] as const;

const cacheModeArg = (value: string): string => {
  if (value.startsWith('-')) {
    throw new InvalidArgumentError(
      `--cache requires a mode value, got "${value}". ` +
        `Valid: "off", "auto", or a duration like "5m", "1h". Use --cache=<mode> if needed.`,
    );
  }
  if (value === 'off' || value === 'auto') return value;
  if (parseDurationToMs(value) !== null) return value;
  throw new InvalidArgumentError(
    `--cache must be "off", "auto", or a duration like "30s"/"5m"/"1h" (got "${value}")`,
  );
};

program
  .name('switchbot')
  .description('Command-line tool for SwitchBot API v1.1')
  .version(pkgVersion)
  .option('--no-color', 'Disable ANSI colors in output')
  .option('--json', 'Output raw JSON response (disables tables; useful for pipes/scripts)')
  .option('--format <type>', 'Output format: table (default), json, jsonl, tsv, yaml, id, markdown', enumArg('--format', ['table', 'json', 'jsonl', 'tsv', 'yaml', 'id', 'markdown']))
  .option('--fields <csv>', 'Comma-separated list of columns to include (e.g. --fields=id,name,type)', stringArg('--fields', { disallow: TOP_LEVEL_COMMANDS }))
  .option('--table-style <style>', 'Table rendering style: unicode (default on TTY), ascii (default on pipes), simple, markdown', enumArg('--table-style', ['unicode', 'ascii', 'simple', 'markdown']))
  .option('-v, --verbose', 'Log HTTP request/response details to stderr')
  .option('--dry-run', 'Print mutating requests without sending them (GETs still execute)')
  .option('--timeout <ms>', 'HTTP request timeout in milliseconds (default: 30000)', intArg('--timeout', { min: 1 }))
  .option('--retry-on-429 <n>', 'Max 429 retries before surfacing the error (default: 3)', intArg('--retry-on-429', { min: 0 }))
  .option('--backoff <strategy>', 'Backoff strategy for retries: "linear" or "exponential" (default)', enumArg('--backoff', ['linear', 'exponential']))
  .option('--no-retry', 'Disable 429 retries entirely (equivalent to --retry-on-429 0)')
  .option('--no-quota', 'Disable the local ~/.switchbot/quota.json counter for this run')
  .option('--cache <mode>', 'Cache mode: "off" | "auto" (default: list 1h, status off) | duration like 5m, 1h, 30s (enables both stores)', cacheModeArg)
  .option('--no-cache', 'Disable cache reads (equivalent to --cache off)')
  .option('--config <path>', 'Override credential file location (default: ~/.switchbot/config.json)', stringArg('--config', { disallow: TOP_LEVEL_COMMANDS }))
  .option('--profile <name>', 'Use a named profile: ~/.switchbot/profiles/<name>.json', stringArg('--profile', { disallow: TOP_LEVEL_COMMANDS }))
  .option('--audit-log', 'Append every mutating command to JSONL audit log (default path: ~/.switchbot/audit.log)')
  .option('--audit-log-path <path>', 'Custom audit log file path; use together with --audit-log', stringArg('--audit-log-path', { disallow: TOP_LEVEL_COMMANDS }))
  .showHelpAfterError('(run with --help to see usage)')
  .showSuggestionAfterError();

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
registerAgentBootstrapCommand(program);

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
  SWITCHBOT_TOKEN          credential token (takes priority over config file)
  SWITCHBOT_SECRET         credential secret (takes priority over config file)
  NO_COLOR                 disable ANSI colors (auto-respected via chalk)

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

// Map commander usage errors (unknown option, missing argument, argParser
// InvalidArgumentError, etc.) to exit code 2. Commander's exitOverride is
// per-command: subcommand errors won't bubble to the root override, so walk
// every registered command and apply the same handler.
const usageExitHandler = (err: CommanderError): never => {
  throw err;
};

function applyExitOverride(cmd: Command): void {
  cmd.exitOverride(usageExitHandler);
  cmd.commands.forEach(applyExitOverride);
}
applyExitOverride(program);

// Enable "did you mean" suggestions across every subcommand, not just the root.
// Without this, `switchbot devices lst` fails without suggesting `list`.
function enableSuggestions(cmd: Command): void {
  cmd.showSuggestionAfterError(true);
  cmd.commands.forEach(enableSuggestions);
}
enableSuggestions(program);

// In JSON mode suppress the plain-text help output so we can emit structured JSON instead.
if (isJsonMode()) {
  program.configureOutput({ writeOut: () => {} });
}

try {
  await program.parseAsync();
} catch (err) {
  // Subcommand-level CommanderErrors (e.g. InvalidArgumentError from an
  // argParser on a subcommand option) don't always hit the root exitOverride.
  // Mirror the root mapping so all usage errors surface as exit 2.
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed') {
      if (isJsonMode()) {
        const target = resolveTargetCommand(program, process.argv.slice(2));
        printJson(commandToJson(target));
      }
      process.exit(0);
    }
    if (err.code === 'commander.version') {
      process.exit(0);
    }
    if (isJsonMode()) {
      emitJsonError({ code: 2, kind: 'usage', message: err.message });
    }
    process.exit(2);
  }
  throw err;
}
