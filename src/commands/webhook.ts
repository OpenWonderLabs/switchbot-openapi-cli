import { Command } from 'commander';
import { createClient } from '../api/client.js';
import { printKeyValue, printJson, isJsonMode, handleError } from '../utils/output.js';
import chalk from 'chalk';

interface WebhookDetails {
  url: string;
  createTime: number;
  lastUpdateTime: number;
  deviceList: string;
  enable: boolean;
}

function assertValidUrl(cmd: Command, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    cmd.error(
      `error: invalid URL "${url}" (expected absolute URL, e.g. https://example.com/hook)`,
      { exitCode: 2, code: 'switchbot.invalidUrl' }
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    cmd.error(
      `error: URL must use http:// or https:// (got "${parsed.protocol}")`,
      { exitCode: 2, code: 'switchbot.invalidUrl' }
    );
  }
}

export function registerWebhookCommand(program: Command): void {
  const webhook = program
    .command('webhook')
    .description('Manage SwitchBot Webhook configuration')
    .addHelpText('after', `
A webhook lets SwitchBot POST device state-change events to a URL you host.
Only one webhook URL can be active per account; "setup" registers it for ALL devices.
`);

  // switchbot webhook setup <url>
  const setup = webhook
    .command('setup')
    .description('Configure the webhook receiver URL (receives events from all devices)')
    .argument('<url>', 'Absolute http(s):// URL where SwitchBot will POST events')
    .addHelpText('after', `
Example:
  $ switchbot webhook setup https://example.com/switchbot/events
`);
  setup.action(async (url: string) => {
      assertValidUrl(setup, url);
      try {
        const client = createClient();
        await client.post('/v1.1/webhook/setupWebhook', {
          action: 'setupWebhook',
          url,
          deviceList: 'ALL',
        });
        console.log(chalk.green(`✓ Webhook configured: ${url}`));
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot webhook query [--details <url>]
  webhook
    .command('query')
    .description('Query webhook configuration')
    .option('--details <url>', 'Query detailed configuration (enable/deviceList/timestamps) for a specific URL')
    .addHelpText('after', `
Without --details, lists all configured webhook URLs.
With --details, prints enable/deviceList/createTime/lastUpdateTime for the given URL.

Examples:
  $ switchbot webhook query
  $ switchbot webhook query --details https://example.com/hook
  $ switchbot webhook query --json
`)
    .action(async (options: { details?: string }) => {
      try {
        const client = createClient();

        if (options.details) {
          const res = await client.post<{ body: WebhookDetails[] }>(
            '/v1.1/webhook/queryWebhook',
            { action: 'queryDetails', urls: [options.details] }
          );

          if (isJsonMode()) {
            printJson(res.data.body);
            return;
          }

          const details = res.data.body;
          if (!details || details.length === 0) {
            console.log('No webhook configuration found for this URL');
            return;
          }

          for (const d of details) {
            printKeyValue({
              url: d.url,
              enable: d.enable,
              deviceList: d.deviceList,
              createTime: new Date(d.createTime).toLocaleString(),
              lastUpdateTime: new Date(d.lastUpdateTime).toLocaleString(),
            });
          }
        } else {
          const res = await client.post<{ body: { urls: string[] } }>(
            '/v1.1/webhook/queryWebhook',
            { action: 'queryUrl' }
          );

          if (isJsonMode()) {
            printJson(res.data.body);
            return;
          }

          const urls = res.data.body.urls ?? [];
          if (urls.length === 0) {
            console.log('No webhooks configured');
            return;
          }

          console.log('Configured Webhook URLs:');
          urls.forEach((u) => console.log(`  ${chalk.cyan(u)}`));
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot webhook update <url> [--enable | --disable]
  const update = webhook
    .command('update')
    .description('Update webhook configuration (enable / disable a registered URL)')
    .argument('<url>', 'URL of the webhook to update (must already be configured)')
    .option('--enable', 'Enable the webhook')
    .option('--disable', 'Disable the webhook')
    .addHelpText('after', `
--enable and --disable are mutually exclusive. If neither is provided, the
webhook is re-submitted with no change to its enabled state.

Examples:
  $ switchbot webhook update https://example.com/hook --enable
  $ switchbot webhook update https://example.com/hook --disable
`);
  update.action(async (url: string, options: { enable?: boolean; disable?: boolean }) => {
      if (options.enable && options.disable) {
        update.error(
          'error: --enable and --disable are mutually exclusive',
          { exitCode: 2, code: 'switchbot.conflictingOptions' }
        );
      }
      assertValidUrl(update, url);
      try {
        const client = createClient();

        const config: { url: string; enable?: boolean } = { url };
        if (options.enable) config.enable = true;
        if (options.disable) config.enable = false;

        await client.post('/v1.1/webhook/updateWebhook', {
          action: 'updateWebhook',
          config,
        });

        const statusText = options.enable ? 'enabled' : options.disable ? 'disabled' : 'updated';
        console.log(chalk.green(`✓ Webhook ${statusText}: ${url}`));
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot webhook delete <url>
  const del = webhook
    .command('delete')
    .description('Delete webhook configuration')
    .argument('<url>', 'URL of the webhook to remove')
    .addHelpText('after', `
Example:
  $ switchbot webhook delete https://example.com/hook
`);
  del.action(async (url: string) => {
      assertValidUrl(del, url);
      try {
        const client = createClient();
        await client.post('/v1.1/webhook/deleteWebhook', {
          action: 'deleteWebhook',
          url,
        });
        console.log(chalk.green(`✓ Webhook deleted: ${url}`));
      } catch (error) {
        handleError(error);
      }
    });
}
