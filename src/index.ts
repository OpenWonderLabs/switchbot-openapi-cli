import { Command, CommanderError } from 'commander';
import chalk from 'chalk';
import { emitJsonError, isJsonMode, printJson } from './utils/output.js';
import { commandToJson, resolveTargetCommand } from './utils/help-json.js';
import { buildProgram } from './program-builder.js';
import { primeCredentials } from './credentials/prime.js';
import { getActiveProfile } from './lib/request-context.js';

// Early initialization: check for --no-color flag or NO_COLOR env var and disable chalk.
// This must happen before any commands run so all chalk output is affected.
if (process.argv.includes('--no-color') || Boolean(process.env.NO_COLOR)) {
  chalk.level = 0;
}

const program = buildProgram();

// Prime keychain-stored credentials before any command runs. This is a
// best-effort probe: failures are silently swallowed inside primeCredentials,
// so the existing file-based path remains the safety net. We probe once per
// invocation (even for --help and --version, which is harmless).
program.hook('preAction', async () => {
  await primeCredentials(getActiveProfile() ?? 'default');
});

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
  $ switchbot status-sync start --openclaw-model home-agent

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
      const helpRequested = process.argv.includes('--help') || process.argv.includes('-h') || process.argv.includes('help');
      if (helpRequested) {
        if (isJsonMode()) {
          const target = resolveTargetCommand(program, process.argv.slice(2));
          printJson(commandToJson(target, { includeIdentity: target === program }));
        }
        process.exit(0);
      }
      if (isJsonMode()) {
        const target = resolveTargetCommand(program, process.argv.slice(2));
        const subNames = target.commands.map((c: Command) => c.name()).join(', ');
        const usefulMessage = subNames
          ? `${target.name()}: a subcommand is required. Available: ${subNames}`
          : err.message;
        emitJsonError({ code: 2, kind: 'usage', message: usefulMessage });
      }
      process.exit(2);
    }
    if (err.code === 'commander.version') {
      process.exit(0);
    }
    if (isJsonMode()) {
      const errorMessage = err.code === 'commander.help'
        ? (() => {
            const target = resolveTargetCommand(program, process.argv.slice(2));
            const subNames = target.commands.map((c: Command) => c.name()).join(', ');
            return subNames
              ? `${target.name()}: a subcommand is required. Available: ${subNames}`
              : err.message;
          })()
        : err.message;
      emitJsonError({ code: 2, kind: 'usage', message: errorMessage });
    }
    process.exit(2);
  }
  throw err;
}
