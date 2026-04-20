import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';

describe('--no-color flag and NO_COLOR env', () => {
  let originalArgv: string[];
  let originalNoColor: string | undefined;
  let originalChalkLevel: number;

  beforeEach(() => {
    originalArgv = process.argv;
    originalNoColor = process.env.NO_COLOR;
    originalChalkLevel = chalk.level;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env.NO_COLOR = originalNoColor;
    chalk.level = originalChalkLevel;
  });

  describe('chalk.level = 0 when --no-color is present', () => {
    it('disables chalk colors when --no-color flag is set', () => {
      process.argv = ['node', 'cli', 'devices', 'list', '--no-color'];
      // Simulate the early initialization in src/index.ts
      if (process.argv.includes('--no-color') || Boolean(process.env.NO_COLOR)) {
        chalk.level = 0;
      }
      expect(chalk.level).toBe(0);
      // With level 0, chalk should return plain strings
      expect(chalk.red('error')).toBe('error');
      expect(chalk.green('success')).toBe('success');
    });

    it('disables chalk colors when NO_COLOR env var is set (non-empty)', () => {
      process.argv = ['node', 'cli', 'devices', 'list'];
      process.env.NO_COLOR = '1';
      // Simulate the early initialization
      if (process.argv.includes('--no-color') || Boolean(process.env.NO_COLOR)) {
        chalk.level = 0;
      }
      expect(chalk.level).toBe(0);
      expect(chalk.cyan('test')).toBe('test');
    });

    it('respects empty NO_COLOR env var (no effect)', () => {
      chalk.level = 3; // Reset to default color support
      process.argv = ['node', 'cli', 'devices', 'list'];
      process.env.NO_COLOR = '';
      // Empty string should not trigger disabling
      if (process.argv.includes('--no-color') || Boolean(process.env.NO_COLOR)) {
        chalk.level = 0;
      }
      // chalk.level should still be 3 (colors enabled)
      expect(chalk.level).toBe(3);
    });

    it('respects unset NO_COLOR env var (no effect)', () => {
      chalk.level = 3;
      delete process.env.NO_COLOR;
      process.argv = ['node', 'cli', 'devices', 'list'];
      // No NO_COLOR or --no-color should leave chalk enabled
      if (process.argv.includes('--no-color') || Boolean(process.env.NO_COLOR)) {
        chalk.level = 0;
      }
      expect(chalk.level).toBe(3);
    });

    it('produces plain text output (no ANSI escape sequences) with chalk.level = 0', () => {
      chalk.level = 0;
      const output = chalk.red('error') + chalk.green(' success ') + chalk.cyan('info');
      // Should contain no ANSI escape sequences
      expect(output).not.toMatch(/\u001b\[/);
      expect(output).toBe('error success info');
    });

    it('produces ANSI-colored output with chalk.level = 3', () => {
      chalk.level = 3;
      const redText = chalk.red('error');
      const greenText = chalk.green('success');
      // Should contain ANSI escape sequences
      expect(redText).toMatch(/\u001b\[/);
      expect(greenText).toMatch(/\u001b\[/);
    });
  });

  describe('priority: --no-color takes precedence', () => {
    it('--no-color disables colors even if NO_COLOR is empty', () => {
      process.argv = ['node', 'cli', '--no-color'];
      process.env.NO_COLOR = '';
      if (process.argv.includes('--no-color') || Boolean(process.env.NO_COLOR)) {
        chalk.level = 0;
      }
      expect(chalk.level).toBe(0);
    });
  });
});
