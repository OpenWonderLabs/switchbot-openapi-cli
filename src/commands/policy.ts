import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { Command } from 'commander';
import { parse as yamlParse } from 'yaml';
import { printJson, emitJsonError, isJsonMode, exitWithError } from '../utils/output.js';
import { readPolicyExampleYaml } from '../embedded-assets.js';
import {
  loadPolicyFile,
  resolvePolicyPath,
  DEFAULT_POLICY_PATH,
  PolicyFileNotFoundError,
  PolicyYamlParseError,
} from '../policy/load.js';
import { validateLoadedPolicy, validateLoadedPolicyAgainstInventory } from '../policy/validate.js';
import { formatValidationResult } from '../policy/format.js';
import {
  CURRENT_POLICY_SCHEMA_VERSION,
  SUPPORTED_POLICY_SCHEMA_VERSIONS,
  type PolicySchemaVersion,
} from '../policy/schema.js';
import { planMigration, PolicyMigrationError } from '../policy/migrate.js';
import { addRuleToPolicyFile, AddRuleError } from '../policy/add-rule.js';
import { diffPolicyValues } from '../policy/diff.js';
import { tryLoadConfig } from '../config.js';
import { fetchDeviceList } from '../lib/devices.js';

// Latest version the CLI knows how to migrate *to*.
// CURRENT_POLICY_SCHEMA_VERSION is the version `policy new` emits by default.
const LATEST_SUPPORTED_VERSION: PolicySchemaVersion =
  SUPPORTED_POLICY_SCHEMA_VERSIONS[SUPPORTED_POLICY_SCHEMA_VERSIONS.length - 1];

function readEmbeddedTemplate(): string {
  return readPolicyExampleYaml();
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

function validationScopeLine(scope: string): string {
  if (scope === 'schema+offline-semantics+live-inventory') {
    return 'Validation scope: schema + offline semantics + live inventory checks + local safety guards.';
  }
  return 'Validation scope: schema + offline semantics + local safety guards.';
}

function validationNotCheckedLine(scope: string): string {
  if (scope === 'schema+offline-semantics+live-inventory') {
    return 'Not checked: live capabilities, current firmware, and runtime-only device behavior.';
  }
  return 'Not checked: alias targets against live devices; command support on the real target device, live capabilities, or current firmware.';
}

function summarizeChangeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v.length > 64 ? `${v.slice(0, 61)}...` : v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[array:${v.length}]`;
  if (typeof v === 'object') return `{object:${Object.keys(v as Record<string, unknown>).length}}`;
  return String(v);
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
  validate [path]   Check a policy file against the embedded schema + offline semantics
                    (add --live to resolve aliases and rule targets against current inventory)
  new [path]        Write a starter policy to the default location (or a given path)
  migrate [path]    Rewrite a policy file between schema versions this CLI still supports
                    (this build only supports v${CURRENT_POLICY_SCHEMA_VERSION}; legacy v0.1 files cannot be migrated here)
  diff <left> <right>
                    Compare two policy files and print structural + line diff
  add-rule          Append a rule YAML (from stdin) into automation.rules[]

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
  $ switchbot policy diff ./policy.before.yaml ./policy.after.yaml
`,
    );

  policy
    .command('validate [path]')
    .description(
      `Validate a policy.yaml against the embedded v${CURRENT_POLICY_SCHEMA_VERSION} schema, offline semantics, and local safety guards`,
    )
    .option('--live', 'Also resolve aliases and rule target devices against the current account inventory (1 API call)')
    .option('--no-color', 'disable ANSI color in human output')
    .option('--no-snippet', 'omit the source-line + caret preview')
    .action(async (pathArg: string | undefined, opts: { color?: boolean; snippet?: boolean; live?: boolean }) => {
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

      let result = validateLoadedPolicy(loaded);
      if (opts.live) {
        if (!tryLoadConfig()) {
          exitWithError({
            code: 1,
            kind: 'runtime',
            message: 'policy validate --live requires configured SwitchBot credentials.',
            extra: {
              hint: "Run 'switchbot config set-token' first, or set SWITCHBOT_TOKEN and SWITCHBOT_SECRET.",
            },
          });
          return;
        }
        const inventory = await fetchDeviceList(undefined, { bypassCache: true });
        result = validateLoadedPolicyAgainstInventory(loaded, inventory);
      }

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
      console.log('');
      console.log(validationScopeLine(result.validationScope));
      console.log(validationNotCheckedLine(result.validationScope));
      process.exit(result.valid ? 0 : 1);
    });

  policy
    .command('new [path]')
    .description('Write a starter policy.yaml (fails if the file exists unless --force)')
    .option('-o, --output <path>', 'write the starter policy to this path (alias of positional [path])')
    .option('-f, --force', 'overwrite an existing policy file')
    .action((pathArg: string | undefined, opts: { force?: boolean; output?: string }) => {
      const policyPath = resolvePolicyPath({ flag: opts.output ?? pathArg });
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
    .description(`Rewrite a policy file between schema versions supported by this CLI (currently only v${LATEST_SUPPORTED_VERSION})`)
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
        const isLegacy = fileVersion === '0.1';
        const message = isLegacy
          ? `policy schema v${fileVersion} is legacy and cannot be migrated by this CLI`
          : `policy schema v${fileVersion} is not supported by this CLI (supports: ${SUPPORTED_POLICY_SCHEMA_VERSIONS.join(', ')})`;
        const hint = isLegacy
          ? 'use @switchbot/openapi-cli <=2.15 to migrate v0.1 first, then upgrade back to this release'
          : 'upgrade @switchbot/openapi-cli, or downgrade the policy file to a supported version';
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

  policy
    .command('diff <left> <right>')
    .description('Compare two policy files and print structural changes + line diff')
    .action((leftPath: string, rightPath: string) => {
      let leftSource = '';
      let rightSource = '';
      try {
        leftSource = readFileSync(leftPath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          exitPolicyError('file-not-found', `policy file not found: ${leftPath}`, { policyPath: leftPath });
        }
        exitPolicyError('internal', `failed to read ${leftPath}: ${String(err)}`);
      }
      try {
        rightSource = readFileSync(rightPath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          exitPolicyError('file-not-found', `policy file not found: ${rightPath}`, { policyPath: rightPath });
        }
        exitPolicyError('internal', `failed to read ${rightPath}: ${String(err)}`);
      }

      let leftDoc: unknown;
      let rightDoc: unknown;
      try {
        leftDoc = yamlParse(leftSource);
      } catch (err) {
        exitPolicyError('yaml-parse', `YAML parse error in ${leftPath}: ${(err as Error).message}`, {
          policyPath: leftPath,
        });
      }
      try {
        rightDoc = yamlParse(rightSource);
      } catch (err) {
        exitPolicyError('yaml-parse', `YAML parse error in ${rightPath}: ${(err as Error).message}`, {
          policyPath: rightPath,
        });
      }

      const result = diffPolicyValues(leftDoc, rightDoc, leftSource, rightSource);

      if (isJsonMode()) {
        printJson({
          leftPath,
          rightPath,
          ...result,
        });
        return;
      }

      if (result.equal) {
        console.log(`✓ no structural differences between ${leftPath} and ${rightPath}`);
        return;
      }

      console.log(`~ policy diff: ${leftPath} -> ${rightPath}`);
      console.log(
        `  changes: ${result.changeCount} (added=${result.stats.added}, removed=${result.stats.removed}, changed=${result.stats.changed})`,
      );
      if (result.truncated) {
        console.log('  note: output truncated at max structural changes');
      }
      for (const c of result.changes) {
        if (c.kind === 'added') {
          console.log(`  + ${c.path}: ${summarizeChangeValue(c.after)}`);
        } else if (c.kind === 'removed') {
          console.log(`  - ${c.path}: ${summarizeChangeValue(c.before)}`);
        } else {
          console.log(`  ~ ${c.path}: ${summarizeChangeValue(c.before)} -> ${summarizeChangeValue(c.after)}`);
        }
      }
      console.log('');
      console.log(result.diff);
    });

  policy
    .command('add-rule')
    .description('Append a rule (read from stdin) into automation.rules[] in policy.yaml')
    .option('--policy <path>', 'Path to policy.yaml (or set $SWITCHBOT_POLICY_PATH)')
    .option('--enable', 'Set automation.enabled: true after inserting the rule')
    .option('--force', 'Overwrite an existing rule with the same name')
    .option('--dry-run', 'Print the diff without writing to disk')
    .addHelpText('after', `
Reads rule YAML from stdin. Combine with 'rules suggest' for a full pipeline:

  $ switchbot rules suggest --intent "turn off lights at 10pm" --trigger cron \\
      --device <id> | switchbot policy add-rule --dry-run
  $ switchbot rules suggest --intent "turn off lights at 10pm" --trigger cron \\
      --device <id> | switchbot policy add-rule --enable
`)
    .action(async (opts: { policy?: string; enable?: boolean; force?: boolean; dryRun?: boolean }) => {
      const policyPath = resolvePolicyPath({ flag: opts.policy });
      let ruleYaml: string;
      try {
        ruleYaml = await readStdinText();
      } catch (err) {
        exitPolicyError('internal', `failed to read stdin: ${(err as Error).message}`);
      }
      if (!ruleYaml!.trim()) {
        exitPolicyError('internal', 'no rule YAML received on stdin');
      }
      try {
        const result = addRuleToPolicyFile({
          ruleYaml: ruleYaml!,
          policyPath,
          enableAutomation: opts.enable,
          force: opts.force,
          dryRun: opts.dryRun,
        });
        if (isJsonMode()) {
          printJson({
            policyPath,
            ruleName: result.ruleName,
            written: result.written,
            diff: result.diff,
          });
        } else {
          console.log(result.diff);
          if (result.written) {
            console.log(`✓ rule "${result.ruleName}" added to ${policyPath}`);
          } else {
            console.log(`• dry-run: rule "${result.ruleName}" not written`);
          }
        }
      } catch (err) {
        if (err instanceof AddRuleError) {
          exitPolicyError('internal', err.message, { kind: err.code });
        }
        throw err;
      }
    });

  // switchbot policy backup [file]
  policy
    .command('backup [file]')
    .description('Copy the active policy to a backup file (default: <policy>.bak.yaml).')
    .option('--force', 'Overwrite an existing backup file.')
    .addHelpText('after', `
Creates a point-in-time snapshot of the active policy file so it can be
restored if a migration or manual edit breaks things.

Default backup path: same directory as the policy, with ".bak.yaml" suffix.

Examples:
  $ switchbot policy backup
  $ switchbot policy backup ./my-backup.yaml
  $ switchbot policy backup --force
`)
    .action((fileArg: string | undefined, opts: { force?: boolean }) => {
      const source = resolvePolicyPath({});
      if (!existsSync(source)) {
        exitPolicyError('file-not-found', `policy file not found: ${source}`, { path: source });
      }

      const dest = fileArg
        ? resolvePath(fileArg)
        : source.replace(/\.yaml$/, '.bak.yaml').replace(/\.yml$/, '.bak.yml');

      if (!opts.force && existsSync(dest)) {
        exitWithError({ code: 2, kind: 'usage', message: `Backup file already exists: ${dest}. Use --force to overwrite.` });
      }

      try {
        copyFileSync(source, dest);
      } catch (err) {
        exitPolicyError('internal', `Failed to write backup: ${err instanceof Error ? err.message : String(err)}`, { source, dest });
      }

      const size = statSync(dest).size;
      if (isJsonMode()) {
        printJson({ ok: true, source, dest, sizeBytes: size });
      } else {
        console.log(`Backup written: ${dest}  (${size} bytes)`);
        console.log(`Restore with:  switchbot policy restore ${dest}`);
      }
    });

  // switchbot policy restore <file>
  policy
    .command('restore <file>')
    .description('Restore a policy backup, validating it before applying.')
    .option('--no-validate', 'Skip schema validation before restoring (use if migrating manually).')
    .addHelpText('after', `
Validates the backup file against the current schema before overwriting the
active policy. A .pre-restore.bak.yaml snapshot of the current policy is
automatically created before overwriting. Use --no-validate to skip
validation (e.g. when restoring an older version for manual migration).

Example:
  $ switchbot policy restore ./policy.bak.yaml
`)
    .action((fileArg: string, opts: { validate?: boolean }) => {
      const source = resolvePath(fileArg);
      if (!existsSync(source)) {
        exitPolicyError('file-not-found', `restore source not found: ${source}`, { path: source });
      }

      // Validate before touching the active policy.
      if (opts.validate !== false) {
        let loaded;
        try {
          loaded = loadPolicyFile(source);
        } catch (err) {
          if (err instanceof PolicyFileNotFoundError) {
            exitPolicyError('file-not-found', `restore source not found: ${err.policyPath}`, { path: err.policyPath });
          }
          if (err instanceof PolicyYamlParseError) {
            exitPolicyError('yaml-parse', `YAML parse error in ${err.policyPath}: ${err.message}`, { path: err.policyPath });
          }
          throw err;
        }
        const vResult = validateLoadedPolicy(loaded);
        if (!vResult.valid) {
          const firstError = vResult.errors[0]?.message ?? 'schema validation failed';
          exitWithError({
            code: 1, kind: 'usage',
            message: `Backup failed validation: ${firstError}`,
            context: { errorCount: vResult.errors.length, hint: 'Use --no-validate to restore anyway.' },
          });
        }
      }

      const dest = resolvePolicyPath({});
      const destDir = dirname(dest);
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true, mode: 0o700 });
      }

      // Take an auto-backup of the current policy before overwriting.
      if (existsSync(dest)) {
        const autoBackup = dest.replace(/\.yaml$/, '.pre-restore.bak.yaml').replace(/\.yml$/, '.pre-restore.bak.yml');
        try {
          copyFileSync(dest, autoBackup);
        } catch {
          // best-effort — if it fails, proceed anyway
        }
      }

      try {
        copyFileSync(source, dest);
      } catch (err) {
        exitPolicyError('internal', `Failed to restore: ${err instanceof Error ? err.message : String(err)}`, { source, dest });
      }

      const size = statSync(dest).size;
      if (isJsonMode()) {
        printJson({ ok: true, restored: dest, from: source, sizeBytes: size });
      } else {
        console.log(`Policy restored from: ${source}`);
        console.log(`Active policy:        ${dest}  (${size} bytes)`);
        console.log('Run `switchbot policy validate` to confirm the restored file is valid.');
      }
    });
}

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}
