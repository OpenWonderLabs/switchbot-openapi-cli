import { describe, it, expect, vi } from 'vitest';
import { runInstall, InstallStep } from '../../src/install/steps.js';

interface Ctx {
  log: string[];
}

function makeStep(name: string, opts: {
  fail?: boolean;
  undoFail?: boolean;
  executeDelayMs?: number;
} = {}): InstallStep<Ctx> {
  return {
    name,
    execute: async (ctx) => {
      if (opts.executeDelayMs) {
        await new Promise((r) => setTimeout(r, opts.executeDelayMs));
      }
      ctx.log.push(`execute:${name}`);
      if (opts.fail) throw new Error(`boom:${name}`);
    },
    undo: async (ctx) => {
      ctx.log.push(`undo:${name}`);
      if (opts.undoFail) throw new Error(`undo-boom:${name}`);
    },
  };
}

describe('runInstall', () => {
  it('executes every step in order when all succeed', async () => {
    const ctx: Ctx = { log: [] };
    const report = await runInstall(
      [makeStep('a'), makeStep('b'), makeStep('c')],
      { context: ctx },
    );
    expect(report.ok).toBe(true);
    expect(report.failedAt).toBeUndefined();
    expect(report.outcomes.map((o) => o.step)).toEqual(['a', 'b', 'c']);
    expect(report.outcomes.every((o) => o.status === 'succeeded')).toBe(true);
    expect(ctx.log).toEqual(['execute:a', 'execute:b', 'execute:c']);
  });

  it('rolls back completed steps in reverse when one fails', async () => {
    const ctx: Ctx = { log: [] };
    const report = await runInstall(
      [makeStep('a'), makeStep('b'), makeStep('c', { fail: true }), makeStep('d')],
      { context: ctx },
    );
    expect(report.ok).toBe(false);
    expect(report.failedAt).toBe('c');
    // a & b executed; c failed; d never ran; rollback undoes b then a.
    expect(ctx.log).toEqual([
      'execute:a',
      'execute:b',
      'execute:c',
      'undo:b',
      'undo:a',
    ]);
  });

  it('records rollback-failed but keeps unwinding remaining undos', async () => {
    const ctx: Ctx = { log: [] };
    const report = await runInstall(
      [
        makeStep('a'),
        makeStep('b', { undoFail: true }),
        makeStep('c', { fail: true }),
      ],
      { context: ctx },
    );
    expect(report.ok).toBe(false);
    const byStep = Object.fromEntries(report.outcomes.map((o) => [o.step + ':' + o.status, o]));
    expect(byStep['b:rollback-failed']).toBeDefined();
    expect(byStep['a:rolled-back']).toBeDefined();
    // Even though b's undo threw, a's undo still ran afterwards.
    expect(ctx.log).toEqual(['execute:a', 'execute:b', 'execute:c', 'undo:b', 'undo:a']);
  });

  it('does not execute later steps after a failure', async () => {
    const executeD = vi.fn();
    const ctx: Ctx = { log: [] };
    const stepD: InstallStep<Ctx> = {
      name: 'd',
      execute: (c) => { executeD(); c.log.push('execute:d'); },
      undo: () => {},
    };
    await runInstall(
      [makeStep('a', { fail: true }), stepD],
      { context: ctx },
    );
    expect(executeD).not.toHaveBeenCalled();
  });

  it('honors stopAfter and skips the remainder without rollback', async () => {
    const ctx: Ctx = { log: [] };
    const report = await runInstall(
      [makeStep('a'), makeStep('b'), makeStep('c')],
      { context: ctx, stopAfter: 'a' },
    );
    expect(report.ok).toBe(true);
    expect(report.outcomes.map((o) => o.step)).toEqual(['a']);
    expect(ctx.log).toEqual(['execute:a']);
  });

  it('failure in the first step still produces a well-formed report (no undos)', async () => {
    const ctx: Ctx = { log: [] };
    const report = await runInstall(
      [makeStep('a', { fail: true }), makeStep('b')],
      { context: ctx },
    );
    expect(report.ok).toBe(false);
    expect(report.failedAt).toBe('a');
    // Only the failed execute outcome — no rollbacks because nothing
    // completed before 'a' threw.
    expect(report.outcomes).toEqual([
      { step: 'a', status: 'failed', error: 'boom:a' },
    ]);
  });

  it('uses a provided context object for every step', async () => {
    interface MyCtx { counter: number }
    const steps: InstallStep<MyCtx>[] = [
      { name: 'inc1', execute: (c) => { c.counter += 1; }, undo: () => {} },
      { name: 'inc2', execute: (c) => { c.counter += 10; }, undo: () => {} },
    ];
    const ctx: MyCtx = { counter: 0 };
    await runInstall(steps, { context: ctx });
    expect(ctx.counter).toBe(11);
  });

  it('accepts synchronous execute/undo functions', async () => {
    const ctx: Ctx = { log: [] };
    const syncStep: InstallStep<Ctx> = {
      name: 'sync',
      execute: (c) => { c.log.push('execute:sync'); },
      undo: (c) => { c.log.push('undo:sync'); },
    };
    const report = await runInstall([syncStep, makeStep('fail', { fail: true })], { context: ctx });
    expect(report.ok).toBe(false);
    expect(ctx.log).toEqual(['execute:sync', 'execute:fail', 'undo:sync']);
  });
});
