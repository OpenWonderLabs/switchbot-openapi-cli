/**
 * Install-orchestrator step runner (Phase 3A · F5).
 *
 * Each step has a deterministic `execute` and a matching `undo`. The
 * runner executes steps in order; on any failure it walks the
 * already-completed steps in reverse and invokes their `undo`. If an
 * `undo` itself fails, the error is captured and surfaced — the
 * runner does NOT abort the rollback. The caller gets a full report
 * and can decide how to surface partial cleanup failures.
 *
 * The module is intentionally agnostic of what steps do; consumers
 * (future `openclaw plugins install`) plug in concrete steps like
 * "npm i -g the CLI" or "write the credential to the keychain".
 */

export interface InstallStep<Ctx = unknown> {
  name: string;
  description?: string;
  execute: (ctx: Ctx) => Promise<void> | void;
  undo: (ctx: Ctx) => Promise<void> | void;
}

export type StepOutcome =
  | { step: string; status: 'succeeded' }
  | { step: string; status: 'failed'; error: string }
  | { step: string; status: 'rolled-back' }
  | { step: string; status: 'rollback-failed'; error: string }
  | { step: string; status: 'skipped' };

export interface InstallReport {
  ok: boolean;
  /** Outcome entries in execution order (execution first, then rollback). */
  outcomes: StepOutcome[];
  /** Name of the step that caused the rollback, if any. */
  failedAt?: string;
}

export interface RunInstallOptions<Ctx> {
  /** Context object passed to every step. Defaults to `{}`. */
  context?: Ctx;
  /**
   * When set, the runner stops immediately after executing this step
   * (even on success). Useful for tests that want to exercise partial
   * state without needing every step to succeed.
   */
  stopAfter?: string;
}

/**
 * Run the given steps in order. On the first failure, the runner
 * walks already-executed steps in reverse and invokes each step's
 * undo. Returns a report describing every step's fate.
 */
export async function runInstall<Ctx = Record<string, unknown>>(
  steps: InstallStep<Ctx>[],
  options: RunInstallOptions<Ctx> = {},
): Promise<InstallReport> {
  const ctx = (options.context ?? ({} as Ctx)) as Ctx;
  const outcomes: StepOutcome[] = [];
  const executed: InstallStep<Ctx>[] = [];

  let failedAt: string | undefined;

  for (const step of steps) {
    try {
      await step.execute(ctx);
      outcomes.push({ step: step.name, status: 'succeeded' });
      executed.push(step);
    } catch (err) {
      outcomes.push({
        step: step.name,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      failedAt = step.name;
      break;
    }
    if (options.stopAfter === step.name) break;
  }

  if (failedAt !== undefined) {
    // Roll back completed steps in reverse. Undo failures are captured
    // but do not abort further rollback attempts — the goal is to
    // leave as little residue as possible.
    for (let i = executed.length - 1; i >= 0; i--) {
      const step = executed[i];
      try {
        await step.undo(ctx);
        outcomes.push({ step: step.name, status: 'rolled-back' });
      } catch (err) {
        outcomes.push({
          step: step.name,
          status: 'rollback-failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    ok: failedAt === undefined,
    outcomes,
    ...(failedAt !== undefined ? { failedAt } : {}),
  };
}
