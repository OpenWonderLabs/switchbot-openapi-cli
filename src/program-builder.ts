import { Command, InvalidArgumentError } from 'commander';
import { createRequire } from 'node:module';
import { intArg, stringArg, enumArg } from './utils/arg-parsers.js';
import { parseDurationToMs } from './utils/flags.js';
import { isJsonMode } from './utils/output.js';
import { PRODUCT_TAGLINE } from './commands/identity.js';
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
import { registerPolicyCommand } from './commands/policy.js';
import { registerRulesCommand } from './commands/rules.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerInstallCommand } from './commands/install.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerResetCommand } from './commands/reset.js';
import { registerStatusSyncCommand } from './commands/status-sync.js';
import { registerHealthCommand } from './commands/health.js';
import { registerUpgradeCheckCommand } from './commands/upgrade-check.js';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerCodexCommand } from './commands/codex.js';

const require = createRequire(import.meta.url);

export const TOP_LEVEL_COMMANDS = [
  'config', 'devices', 'scenes', 'webhook', 'completion', 'mcp',
  'quota', 'catalog', 'cache', 'events', 'doctor', 'schema',
  'history', 'plan', 'capabilities', 'agent-bootstrap', 'install', 'uninstall', 'status-sync',
  'health', 'upgrade-check', 'daemon', 'reset', 'codex',
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

/**
 * Build and return the fully-configured Commander program with all commands
 * registered. Does NOT call parseAsync — callers decide when to parse.
 *
 * Extracting this from index.ts makes the program tree testable without
 * executing any command actions.
 */
export function buildProgram(): Command {
  const { version: pkgVersion } = require('../package.json') as { version: string };

  const program = new Command();
  program.allowExcessArguments(false);
  if (isJsonMode()) {
    program.configureOutput({ writeErr: () => {} });
  }

  program
    .name('switchbot')
    .description(PRODUCT_TAGLINE)
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
  registerPolicyCommand(program);
  registerRulesCommand(program);
  registerAuthCommand(program);
  registerInstallCommand(program);
  registerUninstallCommand(program);
  registerResetCommand(program);
  registerStatusSyncCommand(program);
  registerHealthCommand(program);
  registerUpgradeCheckCommand(program);
  registerDaemonCommand(program);
  registerCodexCommand(program);

  return program;
}
