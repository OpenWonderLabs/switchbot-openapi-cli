import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const commandsDir = resolve(__dirname, '../commands/switchbot');
const tomlFiles = readdirSync(commandsDir).filter((f) => f.endsWith('.toml'));

describe('commands/switchbot/ TOML files', () => {
  it('has exactly 23 command files (matches README)', () => {
    assert.equal(tomlFiles.length, 23, `expected 23 commands, found ${tomlFiles.length}`);
  });

  for (const file of tomlFiles) {
    describe(file, () => {
      const content = readFileSync(resolve(commandsDir, file), 'utf8');

      it('has a non-empty description field', () => {
        const match = content.match(/^description\s*=\s*"(.+)"/m);
        assert.ok(match, `${file} must have a description field`);
        assert.ok(match[1].trim().length > 0, `${file} description must not be empty`);
      });

      it('has a non-empty prompt field', () => {
        const hasPrompt = content.includes('prompt = """') || content.includes("prompt = '''");
        assert.ok(hasPrompt, `${file} must have a multi-line prompt field`);
      });

      it('includes {{args}} for user input', () => {
        assert.ok(content.includes('{{args}}'), `${file} must include {{args}} placeholder`);
      });
    });
  }
});
