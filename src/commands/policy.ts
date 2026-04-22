import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { printJson, emitJsonError, isJsonMode } from '../utils/output.js';
import {
  loadPolicyFile,
  resolvePolicyPath,
  DEFAULT_POLICY_PATH,
  PolicyFileNotFoundError,
  PolicyYamlParseError,
} from '../policy/load.js';
import { validateLoadedPolicy } from '../policy/validate.js';
import { formatValidationResult } from '../policy/format.js';
import {
  CURRENT_POLICY_SCHEMA_VERSION,
  SUPPORTED_POLICY_SCHEMA_VERSIONS,
} from '../policy/schema.js';

function readEmbeddedTemplate(): string {
  const url = new URL('../policy/examples/policy.example.yaml', import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf-8');
}

function exitPolicyError(kind: 'file-not-found' | 'yaml-parse' | 'internal', message: string, extra: Record<string, unknown> = {}): never {
  const code = kind === 'file-not-found' ? 2 : kind === 'yaml-parse' ? 3 : 4;
  if (isJsonMode()) {
    emitJsonError({ code, kind, message, ...extra });
  } else {
    console.error(message);
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') console.error(`  ${k}: ${v}`);
    }
  }
  process.exit(code);
}

export function registerPolicyCommand(program: Command): void {
  const policy = program
    .command('policy')
    .description('Validate, scaffold, and migrate policy.yaml for the OpenClaw SwitchBot skill')
    .addHelpText(
      'after',
      `
The policy file tells an AI agent your device aliases, quiet hours,
audit log path, and which actions always or never need confirmation.
Default location: ${DEFAULT_POLICY_PATH}

Subcommands:
  validate [path]   Check a policy file against the embedded schema
  new [path]        Write a starter policy to the default location (or a given path)
  migrate [path]    Upgrade a policy file to the current schema version
                    (no-op today; the only supported version is ${CURRENT_POLICY_SCHEMA_VERSION})

Exit codes (validate):
  0  valid
  1  invalid (schema violations)
  2  file not found
  3  YAML parse error
  4  internal error

Examples:
  $ switchbot policy validate
  $ switchbot policy validate ./policy.yaml
  $ switchbot policy validate --json | jq '.data.errors'
  $ switchbot policy new
  $ switchbot policy new ./policy.yaml --force
  $ switchbot policy migrate
`,
    );

  policy
    .command('validate [path]')
    .description(`Validate a policy.yaml against the embedded v${CURRENT_POLICY_SCHEMA_VERSION} schema`)
    .option('--no-color', 'disable ANSI color in human output')
    .option('--no-snippet', 'omit the source-line + caret preview')
    .action((pathArg: string | undefined, opts: { color?: boolean; snippet?: boolean }) => {
      const policyPath = resolvePolicyPath({ flag: pathArg });

      let loaded;
      try {
        loaded = loadPolicyFile(policyPath);
      } catch (err) {
        if (err instanceof PolicyFileNotFoundError) {
          exitPolicyError('file-not-found', `policy file not found: ${err.policyPath}`, {
            hint: `run \`switchbot policy new\` to create one at the default location (${DEFAULT_POLICY_PATH})`,
            policyPath: err.policyPath,
          });
        }
        if (err instanceof PolicyYamlParseError) {
          exitPolicyError('yaml-parse', `YAML parse error in ${err.policyPath}: ${err.message}`, {
            policyPath: err.policyPath,
            yamlErrors: err.yamlErrors as unknown as Record<string, unknown>,
          });
        }
        exitPolicyError('internal', `unexpected error loading policy: ${String(err)}`);
      }

      const result = validateLoadedPolicy(loaded);

      if (isJsonMode()) {
        printJson(result);
        process.exit(result.valid ? 0 : 1);
      }

      console.log(
        formatValidationResult(result, loaded.source, {
          color: opts.color !== false,
          noSnippet: opts.snippet === false,
        }),
      );
      process.exit(result.valid ? 0 : 1);
    });

  policy
    .command('new [path]')
    .description('Write a starter policy.yaml (fails if the file exists unless --force)')
    .option('-f, --force', 'overwrite an existing policy file')
    .action((pathArg: string | undefined, opts: { force?: boolean }) => {
      const policyPath = resolvePolicyPath({ flag: pathArg });
      const force = opts.force === true;

      if (existsSync(policyPath) && !force) {
        const message = `refusing to overwrite existing policy at ${policyPath}`;
        const hint = 'pass --force to overwrite, or choose a different path';
        if (isJsonMode()) {
          emitJsonError({ code: 5, kind: 'exists', message, hint, policyPath });
        } else {
          console.error(message);
          console.error(`hint: ${hint}`);
        }
        process.exit(5);
      }

      const template = readEmbeddedTemplate();
      mkdirSync(dirname(policyPath), { recursive: true });
      writeFileSync(policyPath, template, { encoding: 'utf-8' });

      const payload = {
        policyPath,
        schemaVersion: CURRENT_POLICY_SCHEMA_VERSION,
        bytesWritten: Buffer.byteLength(template, 'utf-8'),
        overwritten: force,
      };

      if (isJsonMode()) {
        printJson(payload);
      } else {
        console.log(`✓ wrote starter policy to ${policyPath}`);
        console.log(`  schema version: ${CURRENT_POLICY_SCHEMA_VERSION}`);
        console.log(`  next steps:`);
        console.log(`    1. open the file and fill in the aliases block`);
        console.log(`    2. run \`switchbot policy validate\``);
      }
    });

  policy
    .command('migrate [path]')
    .description('Upgrade a policy file to the current schema version (no-op today)')
    .action((pathArg: string | undefined) => {
      const policyPath = resolvePolicyPath({ flag: pathArg });

      let loaded;
      try {
        loaded = loadPolicyFile(policyPath);
      } catch (err) {
        if (err instanceof PolicyFileNotFoundError) {
          exitPolicyError('file-not-found', `policy file not found: ${err.policyPath}`, {
            hint: 'run `switchbot policy new` first',
            policyPath: err.policyPath,
          });
        }
        if (err instanceof PolicyYamlParseError) {
          exitPolicyError('yaml-parse', `YAML parse error in ${err.policyPath}: ${err.message}`, {
            policyPath: err.policyPath,
          });
        }
        exitPolicyError('internal', `unexpected error loading policy: ${String(err)}`);
      }

      const data = loaded.data as { version?: unknown } | null;
      const fileVersion = typeof data?.version === 'string' ? data.version : undefined;

      const payload: Record<string, unknown> = {
        policyPath,
        fileVersion,
        currentVersion: CURRENT_POLICY_SCHEMA_VERSION,
        supportedVersions: SUPPORTED_POLICY_SCHEMA_VERSIONS,
      };

      if (!fileVersion) {
        payload.status = 'no-version-field';
        payload.message = `policy has no \`version\` field — add \`version: "${CURRENT_POLICY_SCHEMA_VERSION}"\` and run \`switchbot policy validate\``;
        if (isJsonMode()) printJson(payload);
        else {
          console.log(`! ${payload.message as string}`);
        }
        return;
      }

      if (SUPPORTED_POLICY_SCHEMA_VERSIONS.includes(fileVersion as typeof SUPPORTED_POLICY_SCHEMA_VERSIONS[number])) {
        if (fileVersion === CURRENT_POLICY_SCHEMA_VERSION) {
          payload.status = 'already-current';
          payload.message = `already on schema v${CURRENT_POLICY_SCHEMA_VERSION}; no migration needed`;
        } else {
          payload.status = 'older-but-supported';
          payload.message = `schema v${fileVersion} is still supported by this CLI; no migration needed`;
        }
        if (isJsonMode()) printJson(payload);
        else console.log(`✓ ${payload.message as string}`);
        return;
      }

      payload.status = 'unsupported';
      payload.message = `policy schema v${fileVersion} is not supported by this CLI (supports: ${SUPPORTED_POLICY_SCHEMA_VERSIONS.join(', ')})`;
      payload.hint = 'upgrade @switchbot/openapi-cli, or downgrade the policy file to a supported version';
      if (isJsonMode()) emitJsonError({ code: 6, kind: 'unsupported-version', ...payload });
      else {
        console.error(payload.message);
        console.error(`hint: ${payload.hint as string}`);
      }
      process.exit(6);
    });
}
