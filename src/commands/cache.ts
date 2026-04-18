import { Command } from 'commander';
import { printJson, isJsonMode, handleError, UsageError } from '../utils/output.js';
import {
  clearCache,
  clearStatusCache,
  describeCache,
  loadStatusCache,
} from '../devices/cache.js';

function formatAge(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function registerCacheCommand(program: Command): void {
  const cache = program
    .command('cache')
    .description('Inspect and manage the local SwitchBot CLI caches')
    .addHelpText('after', `
Two caches live at ~/.switchbot/:
  devices.json   List of known deviceIds + metadata. Refreshed by every
                 'devices list' call. Drives command validation and
                 helpful hints — keep around even if you don't use TTL.
  status.json    Per-device status bodies keyed by deviceId. Only written
                 when a status TTL is enabled (via --cache <duration>).

Cache modes (global flag, apply to any read):
  --cache off | --no-cache   disable cache reads
  --cache auto (default)     list cache on (1h TTL), status cache off
  --cache 5m | --cache 1h    enable both with the given TTL

Subcommands:
  show          Show ages, entry counts, and file locations
  clear         Delete cache files (specify --key to scope)

Examples:
  $ switchbot cache show
  $ switchbot --json cache show
  $ switchbot cache clear                # removes devices.json + status.json
  $ switchbot cache clear --key status   # removes only status.json
  $ switchbot cache clear --key list     # removes only devices.json
`);

  cache
    .command('show')
    .description('Summarize the cache files (paths, ages, entry counts)')
    .action(() => {
      const summary = describeCache();
      if (isJsonMode()) {
        const statusCache = loadStatusCache();
        printJson({
          list: summary.list,
          status: {
            ...summary.status,
            entries: Object.fromEntries(
              Object.entries(statusCache.entries).map(([id, e]) => [id, { fetchedAt: e.fetchedAt }])
            ),
          },
        });
        return;
      }

      console.log('Device list cache (devices.json):');
      console.log(`  Path:        ${summary.list.path}`);
      console.log(`  Exists:      ${summary.list.exists ? 'yes' : 'no'}`);
      if (summary.list.exists) {
        console.log(`  Last update: ${summary.list.lastUpdated ?? '—'}`);
        console.log(`  Age:         ${formatAge(summary.list.ageMs)}`);
        console.log(`  Devices:     ${summary.list.deviceCount ?? 0}`);
      }

      console.log('\nStatus cache (status.json):');
      console.log(`  Path:        ${summary.status.path}`);
      console.log(`  Exists:      ${summary.status.exists ? 'yes' : 'no'}`);
      console.log(`  Entries:     ${summary.status.entryCount}`);
      if (summary.status.entryCount > 0) {
        console.log(`  Oldest:      ${summary.status.oldestFetchedAt ?? '—'}`);
        console.log(`  Newest:      ${summary.status.newestFetchedAt ?? '—'}`);
      }
    });

  cache
    .command('clear')
    .description('Delete cache files')
    .option('--key <which>', 'Which cache to clear: "list" | "status" | "all" (default)', 'all')
    .action((options: { key: string }) => {
      try {
        const key = options.key;
        if (!['list', 'status', 'all'].includes(key)) {
          throw new UsageError(`Unknown --key "${key}". Expected: list, status, all.`);
        }
        const cleared: string[] = [];
        if (key === 'list' || key === 'all') {
          clearCache();
          cleared.push('list');
        }
        if (key === 'status' || key === 'all') {
          clearStatusCache();
          cleared.push('status');
        }
        if (isJsonMode()) {
          printJson({ cleared });
          return;
        }
        console.log(`Cleared: ${cleared.join(', ')}`);
      } catch (error) {
        handleError(error);
      }
    });
}
