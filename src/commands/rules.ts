import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isJsonMode, printJson, exitWithError } from '../utils/output.js';
import {
  loadPolicyFile,
  resolvePolicyPath,
  DEFAULT_POLICY_PATH,
  PolicyFileNotFoundError,
  PolicyYamlParseError,
} from '../policy/load.js';
import { validateLoadedPolicy } from '../policy/validate.js';
import type { AutomationBlock, Rule } from '../rules/types.js';
import { isWebhookTrigger } from '../rules/types.js';
import { lintRules, RulesEngine, type LintResult } from '../rules/engine.js';
import { tryLoadConfig } from '../config.js';
import { fetchMqttCredential } from '../mqtt/credential.js';
import { SwitchBotMqttClient } from '../mqtt/client.js';
import { WebhookTokenStore } from '../rules/webhook-token.js';
import {
  getDefaultPidFilePaths,
  writePidFile,
  clearPidFile,
  consumeReloadSentinel,
  writeReloadSentinel,
  readPidFile,
  sighupSupported,
  isPidAlive,
} from '../rules/pid-file.js';
import { readAudit, type AuditEntry } from '../utils/audit.js';
import {
  aggregateRuleAudits,
  filterRuleAudits,
  RULE_AUDIT_KINDS,
} from '../rules/audit-query.js';
import { parseDurationToMs } from '../devices/history-query.js';

const DEFAULT_AUDIT_PATH = path.join(os.homedir(), '.switchbot', 'audit.log');

interface LoadedAutomation {
  path: string;
  automation: AutomationBlock | null;
  aliases: Record<string, string>;
  schemaVersion?: string;
}

function loadAutomation(policyPathFlag: string | undefined): LoadedAutomation | null {
  const path = resolvePolicyPath({ flag: policyPathFlag });
  let loaded;
  try {
    loaded = loadPolicyFile(path);
  } catch (err) {
    if (err instanceof PolicyFileNotFoundError) {
      exitWithError({
        code: 2,
        kind: 'usage',
        message: `policy file not found: ${path}`,
        extra: { subKind: 'file-not-found' },
      });
    }
    if (err instanceof PolicyYamlParseError) {
      exitWithError({
        code: 3,
        kind: 'runtime',
        message: `YAML parse error in ${path}: ${err.message}`,
        extra: { subKind: 'yaml-parse', errors: err.yamlErrors },
      });
    }
    throw err;
  }

  const result = validateLoadedPolicy(loaded);
  if (!result.valid) {
    exitWithError({
      code: 4,
      kind: 'runtime',
      message: 'policy file failed schema validation. Run `switchbot policy validate` for details.',
      extra: { subKind: 'invalid-policy', path },
    });
  }

  const data = (loaded.data ?? {}) as Record<string, unknown>;
  const automation = (data.automation ?? null) as AutomationBlock | null;
  const aliases: Record<string, string> = {};
  const rawAliases = data.aliases;
  if (rawAliases && typeof rawAliases === 'object') {
    for (const [k, v] of Object.entries(rawAliases as Record<string, unknown>)) {
      if (typeof v === 'string') aliases[k] = v;
    }
  }
  return { path, automation, aliases, schemaVersion: result.schemaVersion };
}

function describeTrigger(rule: Rule): string {
  const t = rule.when;
  if (t.source === 'mqtt') return t.device ? `mqtt:${t.event}@${t.device}` : `mqtt:${t.event}`;
  if (t.source === 'cron') return `cron:${t.schedule}`;
  return `webhook:${t.path}`;
}

function formatLintHuman(result: LintResult, schemaVersion?: string): string {
  const lines: string[] = [];
  lines.push(`policy schema: v${schemaVersion ?? '?'}`);
  lines.push(`rules: ${result.rules.length}  valid: ${result.valid}  unsupported: ${result.unsupportedCount}`);
  for (const r of result.rules) {
    lines.push(`  [${r.status}] ${r.name}`);
    for (const i of r.issues) {
      lines.push(`      ${i.severity}/${i.code}: ${i.message}`);
    }
  }
  return lines.join('\n');
}

function registerLint(rules: Command): void {
  rules
    .command('lint [path]')
    .description('Static-check automation.rules — no MQTT, no API calls.')
    .action((pathArg: string | undefined) => {
      const loaded = loadAutomation(pathArg);
      if (!loaded) return;
      const result = lintRules(loaded.automation);
      if (isJsonMode()) {
        printJson({
          policyPath: loaded.path,
          policySchemaVersion: loaded.schemaVersion,
          automationEnabled: loaded.automation?.enabled === true,
          ...result,
        });
      } else {
        console.log(formatLintHuman(result, loaded.schemaVersion));
      }
      process.exit(result.valid ? 0 : 1);
    });
}

function registerList(rules: Command): void {
  rules
    .command('list [path]')
    .description('List the rules declared in a policy file, with trigger / throttle / dry_run summary.')
    .action((pathArg: string | undefined) => {
      const loaded = loadAutomation(pathArg);
      if (!loaded) return;
      const ruleEntries = (loaded.automation?.rules ?? []).map((r) => ({
        name: r.name,
        enabled: r.enabled !== false,
        trigger: describeTrigger(r),
        conditions: r.conditions?.length ?? 0,
        actions: r.then.length,
        throttle: r.throttle?.max_per ?? null,
        dry_run: r.dry_run === true,
      }));
      if (isJsonMode()) {
        printJson({
          policyPath: loaded.path,
          automationEnabled: loaded.automation?.enabled === true,
          rules: ruleEntries,
        });
      } else if (ruleEntries.length === 0) {
        console.log('No rules in this policy file.');
      } else {
        console.log(`automation.enabled: ${loaded.automation?.enabled === true}`);
        console.log('name | enabled | trigger | conds | actions | throttle | dry');
        for (const r of ruleEntries) {
          console.log(
            `${r.name} | ${r.enabled} | ${r.trigger} | ${r.conditions} | ${r.actions} | ${r.throttle ?? '-'} | ${r.dry_run}`,
          );
        }
      }
    });
}

function registerRun(rules: Command): void {
  rules
    .command('run [path]')
    .description('Start the rules engine: subscribe to MQTT and execute matching rules (long-running).')
    .option('--dry-run', 'Force every action into dry-run mode, overriding rule-level dry_run=false.')
    .option('--token <token>', 'SwitchBot API token (falls back to env / config).')
    .option('--secret <secret>', 'SwitchBot API secret (falls back to env / config).')
    .option('--max-firings <n>', 'Stop after this many successful fires (test / demo use).', (v) => Number.parseInt(v, 10))
    .option('--webhook-port <n>', 'Webhook listener port (default 18790). Pass 0 for an auto-allocated port.', (v) => Number.parseInt(v, 10))
    .option('--webhook-host <host>', 'Webhook listener bind address (default 127.0.0.1; set 0.0.0.0 to expose beyond loopback).')
    .action(async (pathArg: string | undefined, opts: { dryRun?: boolean; token?: string; secret?: string; maxFirings?: number; webhookPort?: number; webhookHost?: string }) => {
      const loaded = loadAutomation(pathArg);
      if (!loaded) return;

      if (loaded.automation?.enabled !== true) {
        const msg = 'automation.enabled is not true — nothing to run.';
        if (isJsonMode()) {
          printJson({ kind: 'control', controlKind: 'disabled', message: msg });
        } else {
          console.error(msg);
        }
        process.exit(0);
      }

      const lint = lintRules(loaded.automation);
      if (!lint.valid) {
        if (!isJsonMode()) {
          console.error('rules lint failed:');
          console.error(formatLintHuman(lint, loaded.schemaVersion));
        }
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: 'rules lint failed — fix errors before running',
          extra: { subKind: 'lint-failed', ...lint },
        });
      }

      // Resolve credentials: CLI flags > env (via tryLoadConfig) > config file.
      let token = opts.token;
      let secret = opts.secret;
      if (!token || !secret) {
        const cfg = tryLoadConfig();
        if (cfg) {
          token = token ?? cfg.token;
          secret = secret ?? cfg.secret;
        }
      }
      if (!token || !secret) {
        exitWithError({
          code: 2,
          kind: 'usage',
          message: 'SwitchBot token + secret are required. Set SWITCHBOT_TOKEN / SWITCHBOT_SECRET or use `switchbot config set-token`.',
          extra: { subKind: 'missing-credentials' },
        });
      }

      const needsWebhook = (loaded.automation?.rules ?? []).some((r) => isWebhookTrigger(r.when) && r.enabled !== false);
      const webhookTokenStore = new WebhookTokenStore();
      const webhookToken = needsWebhook ? webhookTokenStore.getOrCreate() : undefined;

      if (!isJsonMode()) console.error('Fetching MQTT credentials…');
      const credential = await fetchMqttCredential(token, secret);
      const client = new SwitchBotMqttClient(credential, () => fetchMqttCredential(token!, secret!));

      const engine = new RulesEngine({
        automation: loaded.automation,
        aliases: loaded.aliases,
        mqttClient: client,
        mqttCredential: credential,
        globalDryRun: opts.dryRun === true,
        maxFirings: opts.maxFirings,
        webhookToken,
        webhookPort: opts.webhookPort,
        webhookHost: opts.webhookHost,
      });

      let stopping = false;
      const pidPaths = getDefaultPidFilePaths();
      writePidFile(pidPaths.pidFile);
      const cleanup = () => {
        clearPidFile(pidPaths.pidFile);
        // Drop any stale reload sentinel too — this process won't see it.
        consumeReloadSentinel(pidPaths.reloadFile);
      };
      const stop = async (code: number) => {
        if (stopping) return;
        stopping = true;
        try {
          await engine.stop();
          await client.disconnect();
        } finally {
          cleanup();
          process.exit(code);
        }
      };
      process.once('SIGINT', () => { stop(0).catch(() => process.exit(1)); });
      process.once('SIGTERM', () => { stop(0).catch(() => process.exit(1)); });

      await client.connect();
      await engine.start();

      const doReload = async (trigger: 'signal' | 'sentinel'): Promise<void> => {
        try {
          const fresh = loadAutomation(pathArg);
          if (!fresh) return;
          const result = await engine.reload(fresh.automation, fresh.aliases);
          if (result.changed) {
            if (!isJsonMode()) {
              console.error(
                `rules: reloaded (${trigger}) — ${engine.getStats().rulesActive} active rule(s)`,
              );
              for (const w of result.warnings) console.error(`  warning: ${w}`);
            } else {
              printJson({
                kind: 'control',
                controlKind: 'reloaded',
                t: new Date().toISOString(),
                trigger,
                rulesActive: engine.getStats().rulesActive,
                warnings: result.warnings,
              });
            }
          } else {
            const msg = `rules: reload refused — ${result.errors.join(', ')}`;
            if (!isJsonMode()) console.error(msg);
            else printJson({ kind: 'control', controlKind: 'reload-refused', errors: result.errors });
          }
        } catch (err) {
          const msg = `rules: reload failed — ${err instanceof Error ? err.message : String(err)}`;
          if (!isJsonMode()) console.error(msg);
          else printJson({ kind: 'control', controlKind: 'reload-failed', error: msg });
        }
      };

      if (sighupSupported()) {
        process.on('SIGHUP', () => { doReload('signal').catch(() => undefined); });
      }
      const reloadPoll = setInterval(() => {
        if (consumeReloadSentinel(pidPaths.reloadFile)) {
          doReload('sentinel').catch(() => undefined);
        }
      }, 2000);
      reloadPoll.unref();

      if (!isJsonMode()) {
        console.error(
          `Rules engine started — ${engine.getStats().rulesActive} active rule(s), ${opts.dryRun ? 'global dry-run' : 'live'}.`,
        );
        console.error(`pid ${process.pid} (${pidPaths.pidFile}); reload: \`switchbot rules reload\`.`);
        if (needsWebhook) {
          const boundPort = engine.getWebhookPort();
          console.error(
            `Webhook listener on ${opts.webhookHost ?? '127.0.0.1'}:${boundPort ?? '?'} (bearer file: ${webhookTokenStore.getFilePath()}).`,
          );
        }
      } else {
        printJson({
          kind: 'control',
          controlKind: 'session_start',
          t: new Date().toISOString(),
          pid: process.pid,
          pidFile: pidPaths.pidFile,
          rulesActive: engine.getStats().rulesActive,
          globalDryRun: opts.dryRun === true,
          webhookPort: needsWebhook ? engine.getWebhookPort() : null,
        });
      }

      // Keep the process alive until SIGINT/SIGTERM or maxFirings stops the
      // engine. Poll the engine state rather than blocking forever — a
      // long-running process with zero wake-ups is still cheap.
      await new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          const s = engine.getStats();
          if (!s.started) {
            clearInterval(tick);
            clearInterval(reloadPoll);
            resolve();
          }
        }, 1000);
      });
      await stop(0);
    });
}

function resolveSinceMs(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const durMs = parseDurationToMs(since);
  if (durMs === null) {
    exitWithError({
      code: 2,
      kind: 'usage',
      message: `Invalid --since value "${since}". Expected e.g. "30s", "15m", "1h", "7d".`,
      extra: { subKind: 'invalid-since' },
    });
  }
  return Date.now() - (durMs as number);
}

function formatAuditLine(e: AuditEntry): string {
  const rule = e.rule?.name ?? '(no-rule)';
  const trigger = e.rule?.triggerSource ?? '?';
  const device = e.rule?.matchedDevice ?? e.deviceId ?? '-';
  const status =
    e.kind === 'rule-fire'
      ? e.result === 'error'
        ? 'error'
        : 'fire'
      : e.kind === 'rule-fire-dry'
        ? 'dry'
        : e.kind === 'rule-throttled'
          ? 'throttled'
          : 'rejected';
  const reason = e.rule?.reason ?? e.error ?? '';
  const reasonSuffix = reason ? `  ${reason}` : '';
  return `${e.t}  ${status.padEnd(9)} ${rule}  [${trigger}:${device}]${reasonSuffix}`;
}

function registerTail(rules: Command): void {
  rules
    .command('tail')
    .description('Stream rule-* entries from the audit log.')
    .option('--file <path>', `Audit log path (default ${DEFAULT_AUDIT_PATH})`)
    .option('--since <duration>', 'Only entries newer than this window (e.g. 1h, 30m, 7d).')
    .option('--rule <name>', 'Filter to a single rule name.')
    .option('-f, --follow', 'Keep the process open and stream new lines as they arrive.')
    .action(async (opts: { file?: string; since?: string; rule?: string; follow?: boolean }) => {
      const file = opts.file ?? DEFAULT_AUDIT_PATH;
      const sinceMs = resolveSinceMs(opts.since);

      const existing = fs.existsSync(file) ? readAudit(file) : [];
      const filtered = filterRuleAudits(existing, { sinceMs, ruleName: opts.rule });

      if (isJsonMode()) {
        for (const e of filtered) console.log(JSON.stringify(e));
      } else if (filtered.length === 0 && !opts.follow) {
        console.log(
          `(no rule-* entries in ${file}${opts.rule ? ` for rule "${opts.rule}"` : ''})`,
        );
      } else {
        for (const e of filtered) console.log(formatAuditLine(e));
      }

      if (!opts.follow) return;

      // Follow: poll the file size and parse only newly appended bytes.
      // Audit writes are append-only and infrequent, so 500 ms is plenty.
      let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
      let buffer = '';
      const emit = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(trimmed) as AuditEntry;
        } catch {
          return;
        }
        const kept = filterRuleAudits([entry], { sinceMs, ruleName: opts.rule });
        if (kept.length === 0) return;
        if (isJsonMode()) console.log(JSON.stringify(entry));
        else console.log(formatAuditLine(entry));
      };

      const poll = setInterval(() => {
        if (!fs.existsSync(file)) return;
        const size = fs.statSync(file).size;
        if (size < offset) {
          // Log was truncated / rotated — restart from the top.
          offset = 0;
          buffer = '';
        }
        if (size === offset) return;
        const fd = fs.openSync(file, 'r');
        try {
          const chunk = Buffer.alloc(size - offset);
          fs.readSync(fd, chunk, 0, chunk.length, offset);
          offset = size;
          buffer += chunk.toString('utf-8');
        } finally {
          fs.closeSync(fd);
        }
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          emit(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }, 500);

      await new Promise<void>((resolve) => {
        const onStop = () => {
          clearInterval(poll);
          resolve();
        };
        process.once('SIGINT', onStop);
        process.once('SIGTERM', onStop);
      });
    });
}

function formatReplayTable(report: ReturnType<typeof aggregateRuleAudits>): string {
  const lines: string[] = [];
  lines.push(`total rule-entries: ${report.total}`);
  if (report.webhookRejectedCount > 0) {
    lines.push(`webhook-rejected (no rule): ${report.webhookRejectedCount}`);
  }
  if (report.summaries.length === 0) {
    lines.push('(no rules recorded in the audit window)');
    return lines.join('\n');
  }
  lines.push('rule | trigger | fires | dries | throttled | errors | error% | first | last');
  for (const s of report.summaries) {
    lines.push(
      `${s.rule} | ${s.triggerSource ?? '-'} | ${s.fires} | ${s.driesFires} | ${s.throttled} | ${s.errors} | ${(s.errorRate * 100).toFixed(1)}% | ${s.firstAt ?? '-'} | ${s.lastAt ?? '-'}`,
    );
  }
  return lines.join('\n');
}

function registerReplay(rules: Command): void {
  rules
    .command('replay')
    .description('Aggregate rule-* audit entries per rule (fire/throttle/error counts).')
    .option('--file <path>', `Audit log path (default ${DEFAULT_AUDIT_PATH})`)
    .option('--since <duration>', 'Only entries newer than this window (e.g. 1h, 7d).')
    .option('--rule <name>', 'Filter to a single rule name.')
    .action((opts: { file?: string; since?: string; rule?: string }) => {
      const file = opts.file ?? DEFAULT_AUDIT_PATH;
      const entries = fs.existsSync(file) ? readAudit(file) : [];
      const sinceMs = resolveSinceMs(opts.since);
      const filtered = filterRuleAudits(entries, {
        sinceMs,
        ruleName: opts.rule,
        kinds: RULE_AUDIT_KINDS,
      });
      const report = aggregateRuleAudits(filtered);
      if (isJsonMode()) {
        printJson({
          file,
          sinceMs: sinceMs ?? null,
          ruleFilter: opts.rule ?? null,
          ...report,
        });
      } else {
        console.log(formatReplayTable(report));
      }
    });
}

function registerReload(rules: Command): void {
  rules
    .command('reload')
    .description('Trigger a policy hot-reload on the running `rules run` process.')
    .action(() => {
      const pidPaths = getDefaultPidFilePaths();
      const pid = readPidFile(pidPaths.pidFile);
      if (pid === null || !isPidAlive(pid)) {
        exitWithError({
          code: 2,
          kind: 'usage',
          message: `no running rules engine (pid file: ${pidPaths.pidFile}).`,
          extra: { subKind: 'no-engine', pidFile: pidPaths.pidFile },
        });
      }
      if (sighupSupported()) {
        try {
          process.kill(pid, 'SIGHUP');
        } catch (err) {
          exitWithError({
            code: 1,
            kind: 'runtime',
            message: `failed to send SIGHUP to pid ${pid}: ${err instanceof Error ? err.message : String(err)}`,
            extra: { subKind: 'signal-failed', pid },
          });
        }
        if (isJsonMode()) {
          printJson({ status: 'signalled', pid, method: 'SIGHUP' });
        } else {
          console.log(`Sent SIGHUP to pid ${pid}.`);
        }
      } else {
        writeReloadSentinel(pidPaths.reloadFile);
        if (isJsonMode()) {
          printJson({
            status: 'signalled',
            pid,
            method: 'sentinel',
            file: pidPaths.reloadFile,
          });
        } else {
          console.log(
            `Wrote reload sentinel ${pidPaths.reloadFile}; engine polls every 2 s.`,
          );
        }
      }
    });
}

function registerWebhookRotateToken(rules: Command): void {
  rules
    .command('webhook-rotate-token')
    .description('Generate and persist a fresh webhook bearer token.')
    .action(() => {
      const store = new WebhookTokenStore();
      const fresh = store.rotate();
      if (isJsonMode()) {
        printJson({ status: 'rotated', filePath: store.getFilePath(), tokenLength: fresh.length });
      } else {
        console.log(`Webhook bearer rotated. Token written to ${store.getFilePath()}.`);
        console.log('New token (copy now — it is not shown again):');
        console.log(fresh);
      }
    });
}

function registerWebhookShowToken(rules: Command): void {
  rules
    .command('webhook-show-token')
    .description('Print the current webhook bearer token (creating one if absent).')
    .action(() => {
      const store = new WebhookTokenStore();
      const token = store.getOrCreate();
      if (isJsonMode()) {
        printJson({ filePath: store.getFilePath(), tokenLength: token.length });
      } else {
        console.log(token);
      }
    });
}

export function registerRulesCommand(program: Command): void {
  const rules = program
    .command('rules')
    .description('Run, list, and lint automation rules declared in policy.yaml (v0.2, preview).')
    .addHelpText(
      'after',
      `
Reads the same policy file as \`switchbot policy\` (${DEFAULT_POLICY_PATH} by
default; override with --policy or $SWITCHBOT_POLICY_PATH).

Subcommands:
  lint [path]               Static-check rule definitions; no MQTT, no API calls.
  list [path]               Print a human/JSON summary of each rule's trigger + actions.
  run  [path]               Subscribe to MQTT (+ cron/webhook) and execute matching rules.
  reload                    Hot-reload the running engine's policy (SIGHUP on Unix,
                            pid-file sentinel on Windows).
  tail                      Stream rule-* entries from the audit log (--follow tails).
  replay                    Per-rule aggregate: fires/dries/throttled/errors + window.
  webhook-rotate-token      Rotate the bearer token used for webhook triggers.
  webhook-show-token        Print the current bearer token (creating one if absent).

MQTT, cron, and webhook triggers are all wired. Destructive commands (lock /
unlock / deleteWebhook / deleteScene / factoryReset) are rejected at lint.

Exit codes (lint):
  0  valid
  1  one or more rules have errors
  2  policy file not found
  3  YAML parse error
  4  internal / schema validation failed
`,
    );
  registerLint(rules);
  registerList(rules);
  registerRun(rules);
  registerReload(rules);
  registerTail(rules);
  registerReplay(rules);
  registerWebhookRotateToken(rules);
  registerWebhookShowToken(rules);
}
