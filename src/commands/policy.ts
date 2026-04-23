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
  type PolicySchemaVersion,
} from '../policy/schema.js';
import { planMigration, PolicyMigrationError } from '../policy/migrate.js';

// Latest version the CLI knows how to migrate *to*. Distinct from
// CURRENT_POLICY_SCHEMA_VERSION (the version `policy new` emits), which stays
// conservative so fresh files don't leap ahead of what users have adopted.
const LATEST_SUPPORTED_VERSION: PolicySchemaVersion =
  SUPPORTED_POLICY_SCHEMA_VERSIONS[SUPPORTED_POLICY_SCHEMA_VERSIONS.length - 1];

function readEmbeddedTemplate(): string {
  const url = new URL('../policy/examples/policy.example.yaml', import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf-8');
}

export class PolicyFileExistsError extends Error {
  constructor(public readonly policyPath: string) {
    super(`refusing to overwrite existing policy at ${policyPath}`);
    this.name = 'PolicyFileExistsError';
  }
}

export interface ScaffoldPolicyResult {
  policyPath: string;
  schemaVersion: string;
  bytesWritten: number;
  overwritten: boolean;
  /** True when the file already existed and --force was not used (no mutation). */
  skipped?: boolean;
}

/**
 * Write the starter policy template to `policyPath`. Refuses to
 * overwrite an existing file unless `opts.force === true` — the install
 * orchestrator uses `skipExisting: true` instead, which returns
 * `skipped: true` without touching the file.
 */
export function scaffoldPolicyFile(
  policyPath: string,
  opts: { force?: boolean; skipExisting?: boolean } = {},
): ScaffoldPolicyResult {
  const force = opts.force === true;
  if (existsSync(policyPath)) {
    if (opts.skipExisting) {
      return { policyPath, schemaVersion: CURRENT_POLICY_SCHEMA_VERSION, bytesWritten: 0, overwritten: false, skipped: true };
    }
    if (!force) throw new PolicyFileExistsError(policyPath);
  }
  const template = readEmbeddedTemplate();
  mkdirSync(dirname(policyPath), { recursive: true });
  writeFileSync(policyPath, template, { encoding: 'utf-8' });
  return {
    policyPath,
    schemaVersion: CURRENT_POLICY_SCHEMA_VERSION,
    bytesWritten: Buffer.byteLength(template, 'utf-8'),
    overwritten: force,
  };
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
  migrate [path]    Upgrade a policy file to the latest supported schema
                    (v${CURRENT_POLICY_SCHEMA_VERSION} → v${LATEST_SUPPORTED_VERSION} today; no-op if already current)

Exit codes (validate):
  0  valid
  1  invalid (schema violations)
  2  file not found
  3  YAML parse error
  4  internal error

Exit codes (migrate):
  0  no-op (already on the target version) or successful migration
  2  file not found
  3  YAML parse error
  6  source version unsupported by this CLI
  7  migration precheck failed (the upgraded file would not validate)

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

      let result: ScaffoldPolicyResult;
      try {
        result = scaffoldPolicyFile(policyPath, { force });
      } catch (err) {
        if (err instanceof PolicyFileExistsError) {
          const message = err.message;
          const hint = 'pass --force to overwrite, or choose a different path';
          if (isJsonMode()) {
            emitJsonError({ code: 5, kind: 'exists', message, hint, policyPath });
          } else {
            console.error(message);
            console.error(`hint: ${hint}`);
          }
          process.exit(5);
        }
        throw err;
      }

      if (isJsonMode()) {
        printJson(result);
      } else {
        console.log(`✓ wrote starter policy to ${result.policyPath}`);
        console.log(`  schema version: ${result.schemaVersion}`);
        console.log(`  next steps:`);
        console.log(`    1. open the file and fill in the aliases block`);
        console.log(`    2. run \`switchbot policy validate\``);
      }
    });

  policy
    .command('migrate [path]')
    .description(`Upgrade a policy file to the latest supported schema (currently v${LATEST_SUPPORTED_VERSION})`)
    .option('--dry-run', 'show what would change without writing the file')
    .option(
      '--to <version>',
      `target schema version (default: ${LATEST_SUPPORTED_VERSION})`,
      LATEST_SUPPORTED_VERSION,
    )
    .action((pathArg: string | undefined, opts: { dryRun?: boolean; to?: string }) => {
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
      const target = opts.to ?? LATEST_SUPPORTED_VERSION;

      const basePayload: Record<string, unknown> = {
        policyPath,
        fileVersion,
        targetVersion: target,
        supportedVersions: SUPPORTED_POLICY_SCHEMA_VERSIONS,
      };

      if (!fileVersion) {
        const message = `policy has no \`version\` field — add \`version: "${CURRENT_POLICY_SCHEMA_VERSION}"\` and run \`switchbot policy validate\``;
        const payload = { ...basePayload, status: 'no-version-field', message };
        if (isJsonMode()) printJson(payload);
        else console.log(`! ${message}`);
        return;
      }

      if (!SUPPORTED_POLICY_SCHEMA_VERSIONS.includes(fileVersion as PolicySchemaVersion)) {
        const message = `policy schema v${fileVersion} is not supported by this CLI (supports: ${SUPPORTED_POLICY_SCHEMA_VERSIONS.join(', ')})`;
        const hint = 'upgrade @switchbot/openapi-cli, or downgrade the policy file to a supported version';
        if (isJsonMode())
          emitJsonError({ code: 6, kind: 'unsupported-version', ...basePayload, message, hint });
        else {
          console.error(message);
          console.error(`hint: ${hint}`);
        }
        process.exit(6);
      }

      if (!SUPPORTED_POLICY_SCHEMA_VERSIONS.includes(target as PolicySchemaVersion)) {
        const message = `--to ${target}: unknown target version (supports: ${SUPPORTED_POLICY_SCHEMA_VERSIONS.join(', ')})`;
        if (isJsonMode()) emitJsonError({ code: 6, kind: 'unsupported-target', ...basePayload, message });
        else console.error(message);
        process.exit(6);
      }

      if (fileVersion === target) {
        const message = `already on schema v${target}; no migration needed`;
        const payload = { ...basePayload, status: 'already-current', message, bytesWritten: 0 };
        if (isJsonMode()) printJson(payload);
        else console.log(`✓ ${message}`);
        return;
      }

      let plan;
      try {
        plan = planMigration(
          loaded,
          fileVersion as PolicySchemaVersion,
          target as PolicySchemaVersion,
        );
      } catch (err) {
        if (err instanceof PolicyMigrationError) {
          const payload = { ...basePayload, status: 'migration-error', kind: err.code, message: err.message };
          if (isJsonMode()) emitJsonError({ code: 4, ...payload });
          else console.error(err.message);
          process.exit(4);
        }
        throw err;
      }

      if (!plan.precheck.valid) {
        const message = `migrated policy fails schema v${target} precheck; file not written`;
        const payload = {
          ...basePayload,
          status: 'precheck-failed',
          message,
          errors: plan.precheck.errors,
        };
        if (isJsonMode()) emitJsonError({ code: 7, kind: 'migration-precheck-failed', ...payload });
        else {
          console.error(message);
          console.error(formatValidationResult(plan.precheck, plan.nextSource, { color: true }));
          console.error('hint: fix the validation errors above in the current file, then re-run `switchbot policy migrate`.');
        }
        process.exit(7);
      }

      const bytesWritten = Buffer.byteLength(plan.nextSource, 'utf-8');
      const finalPayload = {
        ...basePayload,
        status: opts.dryRun ? 'dry-run' : 'migrated',
        from: plan.fromVersion,
        to: plan.toVersion,
        bytesWritten: opts.dryRun ? 0 : bytesWritten,
      };

      if (opts.dryRun) {
        if (isJsonMode()) printJson(finalPayload);
        else {
          console.log(`• dry-run: would upgrade ${policyPath} (v${plan.fromVersion} → v${plan.toVersion})`);
          console.log(`  bytes: ${bytesWritten}`);
          console.log(`  precheck: valid against v${target}`);
        }
        return;
      }

      writeFileSync(policyPath, plan.nextSource, { encoding: 'utf-8' });
      if (isJsonMode()) printJson(finalPayload);
      else {
        console.log(`✓ migrated ${policyPath} to schema v${plan.toVersion} (from v${plan.fromVersion})`);
        console.log(`  bytes written: ${bytesWritten}`);
      }
    });
}
