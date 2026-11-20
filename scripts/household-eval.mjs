// Release-development harness only. Never import the production CLI in the user's home.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { caseIds } from './household/fixtures.mjs';

const worker = fileURLToPath(new URL('./household/run-case.mjs', import.meta.url));
const loader = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve('tsx')).href;
const loaderFlag = typeof nodeModule.register === 'function' ? '--import' : '--loader';
const help = 'node scripts/household-eval.mjs [--split practice|heldout] [--case <split/name>] [--min-success 0..1] [--driver name=/trusted/driver.mjs]...';

function parse(args) {
  const config = { drivers: [], minSuccess: 1 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!value || value.startsWith('--')) throw Error(help);
    if (key === '--split' && ['practice', 'heldout'].includes(value)) config.split = value;
    else if (key === '--case' && caseIds.includes(value)) config.id = value;
    else if (key === '--min-success' && Number.isFinite(+value) && +value >= 0 && +value <= 1) config.minSuccess = +value;
    else if (key === '--driver') {
      const match = /^([A-Za-z0-9_.:-]{1,80})=(.+)$/.exec(value);
      if (!match || config.drivers.some(d => d.name === match[1])) throw Error(help);
      config.drivers.push({ name: match[1], script: resolve(match[2]) });
    } else throw Error(help);
  }
  if (!config.drivers.length) config.drivers.push({ name: 'contract' });
  return config;
}

function runCase(id, driver) {
  const home = mkdtempSync(join(tmpdir(), 'switchbot-eval-'));
  try {
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
      TEMP: home, TMP: home, TMPDIR: home, PATH: '', TSX_DISABLE_CACHE: '1', NO_COLOR: '1',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
    const run = spawnSync(process.execPath, [loaderFlag, loader, worker], {
      input: JSON.stringify({ id, driver }), encoding: 'utf8', cwd: home, env,
      timeout: 360000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    if (run.error || run.status !== 0) throw Error(run.error?.message ?? `worker exit ${run.status}: ${run.stderr.slice(-1500)}`);
    return JSON.parse(run.stdout);
  } catch (error) {
    return { id, success: false, harnessError: error.message };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

function summarize(cases) {
  const totals = {}, p95 = {};
  for (const key of ['unexpectedWrites', 'forbiddenRequests', 'toolCalls', 'contextBytes', 'outputBytes', 'toolResultBytes', 'elapsedMs']) {
    const values = cases.map(c => c[key]).filter(Number.isFinite).sort((a, b) => a - b);
    totals[key] = values.reduce((a, b) => a + b, 0);
    p95[key] = values[Math.ceil(values.length * .95) - 1] ?? null;
  }
  return { count: cases.length, successRate: cases.filter(c => c.success).length / cases.length, ...totals, p95 };
}

try {
  const { drivers, id, split, minSuccess } = parse(process.argv.slice(2));
  const ids = caseIds.filter(c => (!id || id === c) && (!split || c.startsWith(split + '/')));
  if (!ids.length) throw Error('No matching cases');
  const runs = drivers.map(driver => {
    const cases = ids.map(c => runCase(c, driver));
    const splits = Object.fromEntries([...new Set(ids.map(c => c.split('/')[0]))].map(s => [s, summarize(cases.filter(c => c.id.startsWith(s + '/')))]));
    const passed = cases.every(c => !c.harnessError && !c.unexpectedWrites && !c.forbiddenRequests)
      && Object.values(splits).every(s => s.successRate >= minSuccess);
    return { name: driver.name, kind: driver.script ? 'external-driver' : 'scripted-contract', passed, splits, cases };
  });
  const passed = runs.every(r => r.passed);
  console.log(JSON.stringify({ formatVersion: 1, boundary: 'offline-axios-simulator', minSuccess, passed, runs }, null, 2));
  process.exitCode = passed ? 0 : 1;
} catch (error) { console.error(error.message); process.exitCode = 2; }
