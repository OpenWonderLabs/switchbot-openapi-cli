import { Command } from 'commander';
import { saveConfig, showConfig } from '../config.js';
import chalk from 'chalk';

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage SwitchBot API credentials')
    .addHelpText('after', `
Credential priority:
  1. Environment variables: SWITCHBOT_TOKEN and SWITCHBOT_SECRET
  2. File: ~/.switchbot/config.json (created by 'config set-token')

Obtain your token/secret from the SwitchBot mobile app:
  Profile → Preferences → Developer Options → Get Token
`);

  config
    .command('set-token')
    .description('Save token and secret to ~/.switchbot/config.json (mode 0600)')
    .argument('<token>', 'API token (long hex string from the SwitchBot app)')
    .argument('<secret>', 'API client secret (hex string from the SwitchBot app)')
    .addHelpText('after', `
Example:
  $ switchbot config set-token 0123abcd... 9876ffff...

Note: the file is written with mode 0600 so only your user can read it.
`)
    .action((token: string, secret: string) => {
      saveConfig(token, secret);
      console.log(chalk.green('✓ Credentials saved to ~/.switchbot/config.json'));
    });

  config
    .command('show')
    .description('Show the current credential source and a masked secret')
    .action(() => {
      showConfig();
    });
}
