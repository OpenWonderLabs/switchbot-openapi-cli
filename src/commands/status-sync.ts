import { Command } from 'commander';
import { stringArg } from '../utils/arg-parsers.js';
import { handleError, isJsonMode, printJson } from '../utils/output.js';
import {
  getStatusSyncStatus,
  probeStatusSyncStart,
  runStatusSyncForeground,
  startStatusSync,
  stopStatusSync,
  type StatusSyncStatus,
} from '../status-sync/manager.js';

function printHumanStatus(status: StatusSyncStatus): void {
  if (!status.running) {
    console.log('status-sync is not running');
    console.log(`state:  ${status.stateDir}`);
    console.log(`stdout: ${status.stdoutLog}`);
    console.log(`stderr: ${status.stderrLog}`);
    return;
  }

  console.log(`status-sync is running (PID ${status.pid})`);
  console.log(`started: ${status.startedAt}`);
  console.log(`state:   ${status.stateDir}`);
  console.log(`stdout:  ${status.stdoutLog}`);
  console.log(`stderr:  ${status.stderrLog}`);
}

export function registerStatusSyncCommand(program: Command): void {
  const statusSync = program
    .command('status-sync')
    .description('Manage a background MQTT -> OpenClaw status-sync bridge powered by events mqtt-tail');

  statusSync
    .command('run')
    .description('Run the status-sync bridge in the foreground for a supervisor or terminal session')
    .option('--openclaw-url <url>', 'OpenClaw gateway URL (default: http://localhost:18789)', stringArg('--openclaw-url'))
    .option('--openclaw-token <token>', 'Bearer token for OpenClaw (or env OPENCLAW_TOKEN)', stringArg('--openclaw-token'))
    .option('--openclaw-model <id>', 'OpenClaw agent model ID to route events to (or env OPENCLAW_MODEL)', stringArg('--openclaw-model'))
    .option('--topic <pattern>', 'MQTT topic filter (default: SwitchBot shadow topic from credential)', stringArg('--topic'))
    .addHelpText(
      'after',
      `
Runs the same MQTT -> OpenClaw bridge logic as \'status-sync start\',
but keeps the process attached to the current terminal. This is the best fit
for agent supervisors, service managers, or container entrypoints that want
foreground process semantics.

Examples:
  $ switchbot status-sync run --openclaw-model home-agent
  $ OPENCLAW_TOKEN=abc OPENCLAW_MODEL=home-agent switchbot status-sync run
`,
    )
    .action(async (options: {
      openclawUrl?: string;
      openclawToken?: string;
      openclawModel?: string;
      topic?: string;
    }) => {
      try {
        const exitCode = await runStatusSyncForeground(options);
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
      } catch (error) {
        handleError(error);
      }
    });

  statusSync
    .command('start')
    .description('Start the background status-sync bridge')
    .option('--openclaw-url <url>', 'OpenClaw gateway URL (default: http://localhost:18789)', stringArg('--openclaw-url'))
    .option('--openclaw-token <token>', 'Bearer token for OpenClaw (or env OPENCLAW_TOKEN)', stringArg('--openclaw-token'))
    .option('--openclaw-model <id>', 'OpenClaw agent model ID to route events to (or env OPENCLAW_MODEL)', stringArg('--openclaw-model'))
    .option('--topic <pattern>', 'MQTT topic filter (default: SwitchBot shadow topic from credential)', stringArg('--topic'))
    .option('--state-dir <path>', 'Override the status-sync state directory (or env SWITCHBOT_STATUS_SYNC_HOME)', stringArg('--state-dir'))
    .option('--force', 'Stop any existing status-sync bridge before starting a new one')
    .option('--probe', 'Perform online preflight: fetch MQTT credentials and probe the OpenClaw URL before spawning')
    .addHelpText(
      'after',
      `
Starts a detached child process that runs:
  switchbot status-sync run ...

Local preflight before spawning:
  - SwitchBot credentials must be configured
  - OpenClaw token + model must be present
  - OpenClaw URL must parse as http:// or https://

Optional online preflight with --probe:
  - fetch MQTT credentials from SwitchBot
  - perform a short HTTP probe against the OpenClaw URL

State files:
  state.json   process metadata (pid, startedAt, command)
  stdout.log   redirected stdout from the child process
  stderr.log   redirected stderr from the child process

Examples:
  $ switchbot status-sync start --openclaw-model home-agent
  $ OPENCLAW_TOKEN=abc OPENCLAW_MODEL=home-agent switchbot status-sync start
  $ switchbot status-sync start --state-dir ~/.switchbot/custom-status-sync --force
`,
    )
    .action(async (options: {
      openclawUrl?: string;
      openclawToken?: string;
      openclawModel?: string;
      topic?: string;
      stateDir?: string;
      force?: boolean;
      probe?: boolean;
    }) => {
      try {
        if (options.probe) {
          await probeStatusSyncStart(options);
        }
        const status = startStatusSync(options);
        if (isJsonMode()) {
          printJson(status);
          return;
        }
        console.log(`Started status-sync (PID ${status.pid}).`);
        console.log(`state:  ${status.stateDir}`);
        console.log(`stdout: ${status.stdoutLog}`);
        console.log(`stderr: ${status.stderrLog}`);
      } catch (error) {
        handleError(error);
      }
    });

  statusSync
    .command('stop')
    .description('Stop the background status-sync bridge')
    .option('--state-dir <path>', 'Override the status-sync state directory (or env SWITCHBOT_STATUS_SYNC_HOME)', stringArg('--state-dir'))
    .action((options: { stateDir?: string }) => {
      try {
        const result = stopStatusSync(options);
        if (isJsonMode()) {
          printJson(result);
          return;
        }
        if (result.stopped) {
          console.log(`Stopped status-sync (PID ${result.pid}).`);
        } else if (result.stale) {
          console.log(`Removed stale status-sync state for PID ${result.pid}.`);
        } else {
          console.log('status-sync is not running');
        }
      } catch (error) {
        handleError(error);
      }
    });

  statusSync
    .command('status')
    .description('Inspect the current status-sync bridge state')
    .option('--state-dir <path>', 'Override the status-sync state directory (or env SWITCHBOT_STATUS_SYNC_HOME)', stringArg('--state-dir'))
    .action((options: { stateDir?: string }) => {
      try {
        const status = getStatusSyncStatus(options);
        if (isJsonMode()) {
          printJson(status);
          return;
        }
        printHumanStatus(status);
      } catch (error) {
        handleError(error);
      }
    });
}
