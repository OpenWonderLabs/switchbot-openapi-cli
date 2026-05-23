import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const MIN_VERSION = '3.7.1';

function versionAtLeast(have, need) {
  const a = have.split('.').map(n => parseInt(n, 10) || 0);
  const b = need.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

export function makeCheckCli(exec) {
  return async function checkCli() {
    let version;
    try {
      const { stdout } = await exec('switchbot', ['--version'], { timeout: 8000 });
      const m = stdout.trim().match(/\d+\.\d+\.\d+/);
      version = m ? m[0] : null;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return {
          ok: false,
          message: 'switchbot CLI not found. Install with: npm install -g @switchbot/openapi-cli@latest',
        };
      }
      return {
        ok: false,
        message: `Failed to run switchbot --version: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!version) {
      return {
        ok: false,
        message: `Could not parse CLI version string. Upgrade with: npm install -g @switchbot/openapi-cli@latest`,
      };
    }

    if (!versionAtLeast(version, MIN_VERSION)) {
      return {
        ok: false,
        message: `CLI version ${version} is below the required minimum ${MIN_VERSION}. Upgrade with: npm install -g @switchbot/openapi-cli@latest`,
      };
    }

    return { ok: true, version };
  };
}

const defaultExec = promisify(execFile);
export const checkCli = makeCheckCli(defaultExec);
