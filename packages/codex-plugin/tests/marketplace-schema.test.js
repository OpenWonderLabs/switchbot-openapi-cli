import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('marketplace.json $schema field', () => {
  const codexPluginMarketplacePath = resolve(__dirname, '../.claude-plugin/marketplace.json');
  const claudeCodePluginMarketplacePath = resolve(__dirname, '../../claude-code-plugin/.claude-plugin/marketplace.json');

  it('codex-plugin marketplace.json contains $schema field', () => {
    const content = JSON.parse(readFileSync(codexPluginMarketplacePath, 'utf8'));
    assert.ok(content.$schema, 'codex-plugin marketplace.json missing $schema field');
  });

  it('claude-code-plugin marketplace.json contains $schema field', () => {
    const content = JSON.parse(readFileSync(claudeCodePluginMarketplacePath, 'utf8'));
    assert.ok(content.$schema, 'claude-code-plugin marketplace.json missing $schema field');
  });

  it('both marketplace.json files have identical $schema values', () => {
    const codexPluginContent = JSON.parse(readFileSync(codexPluginMarketplacePath, 'utf8'));
    const claudeCodePluginContent = JSON.parse(readFileSync(claudeCodePluginMarketplacePath, 'utf8'));
    assert.equal(
      codexPluginContent.$schema,
      claudeCodePluginContent.$schema,
      'marketplace.json $schema values do not match'
    );
    assert.equal(
      codexPluginContent.$schema,
      'https://anthropic.com/claude-code/marketplace.schema.json',
      'unexpected $schema value'
    );
  });

  it('$schema is the first field in codex-plugin marketplace.json', () => {
    const rawContent = readFileSync(codexPluginMarketplacePath, 'utf8');
    assert.ok(
      rawContent.indexOf('"$schema"') < rawContent.indexOf('"name"'),
      '$schema should appear before "name" in the raw JSON text',
    );
  });
});
