import { Command } from 'commander';
import { printJson, isJsonMode } from '../utils/output.js';
import {
  DAILY_QUOTA,
  loadQuota,
  resetQuota,
  todayUsage,
} from '../utils/quota.js';

export function registerQuotaCommand(program: Command): void {
  const quota = program
    .command('quota')
    .description('Inspect and manage the local SwitchBot API request counter')
    .addHelpText('after', `
Every request the CLI makes is counted locally in ~/.switchbot/quota.json.
Counts are bucketed by local date, one record per endpoint pattern. This
is a best-effort mirror of the SwitchBot 10,000/day limit — it does not
include requests made outside this CLI (mobile app, other scripts).

Subcommands:
  status   Show today's usage and the last 7 days (alias: show)
  reset    Delete the local counter file

Examples:
  $ switchbot quota status
  $ switchbot quota show            # alias of 'status'
  $ switchbot quota status --json
  $ switchbot quota reset
`);

  quota
    .command('status')
    .alias('show')
    .description("Show today's usage and the last 7 days (alias: show)")
    .action(() => {
      const usage = todayUsage();
      const history = loadQuota();

      if (isJsonMode()) {
        printJson({
          today: {
            date: usage.date,
            total: usage.total,
            remaining: usage.remaining,
            dailyLimit: DAILY_QUOTA,
            endpoints: usage.endpoints,
          },
          history: history.days,
        });
        return;
      }

      console.log(`Today (${usage.date}):`);
      console.log(`  Requests used:      ${usage.total} / ${DAILY_QUOTA}`);
      console.log(`  Remaining budget:   ${usage.remaining}`);
      if (Object.keys(usage.endpoints).length === 0) {
        console.log('  (no requests recorded yet)');
      } else {
        console.log('  Endpoint breakdown:');
        const entries = Object.entries(usage.endpoints).sort((a, b) => b[1] - a[1]);
        for (const [endpoint, count] of entries) {
          console.log(`    ${endpoint.padEnd(48)} ${count}`);
        }
      }

      const otherDays = Object.entries(history.days)
        .filter(([d]) => d !== usage.date)
        .sort((a, b) => b[0].localeCompare(a[0]));
      if (otherDays.length > 0) {
        console.log('\nRecent history:');
        for (const [date, bucket] of otherDays) {
          console.log(`  ${date}  ${bucket.total}`);
        }
      }
    });

  quota
    .command('reset')
    .description('Delete the local quota counter file')
    .action(() => {
      resetQuota();
      if (isJsonMode()) {
        printJson({ reset: true });
      } else {
        console.log('Quota counter reset.');
      }
    });
}
