import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SKILL_1 = path.join(__dirname, '../skills/switchbot/SKILL.md');
const SKILL_2 = path.join(__dirname, '../plugins/switchbot/skills/switchbot/SKILL.md');
// claude-code-plugin copy — intentionally different content at line 37 (plugin-specific network setup),
// but must still exist on disk and carry a MAINTENANCE comment.
const SKILL_3 = path.join(__dirname, '../../claude-code-plugin/plugins/switchbot/skills/switchbot/SKILL.md');

test('SKILL.md files have maintenance comments and identical content', async (t) => {
  await t.test('all SKILL.md files exist', () => {
    assert.ok(fs.existsSync(SKILL_1), `${SKILL_1} should exist`);
    assert.ok(fs.existsSync(SKILL_2), `${SKILL_2} should exist`);
    assert.ok(fs.existsSync(SKILL_3), `${SKILL_3} should exist`);
  });

  await t.test('all SKILL.md files contain MAINTENANCE comment', () => {
    const content1 = fs.readFileSync(SKILL_1, 'utf8');
    const content2 = fs.readFileSync(SKILL_2, 'utf8');
    const content3 = fs.readFileSync(SKILL_3, 'utf8');

    assert.ok(
      content1.includes('<!-- MAINTENANCE:'),
      `${SKILL_1} should contain <!-- MAINTENANCE: comment`
    );
    assert.ok(
      content2.includes('<!-- MAINTENANCE:'),
      `${SKILL_2} should contain <!-- MAINTENANCE: comment`
    );
    assert.ok(
      content3.includes('<!-- MAINTENANCE:'),
      `${SKILL_3} should contain <!-- MAINTENANCE: comment`
    );
  });

  await t.test('codex-plugin SKILL.md files have identical content except maintenance comments', () => {
    const content1 = fs.readFileSync(SKILL_1, 'utf8');
    const content2 = fs.readFileSync(SKILL_2, 'utf8');

    const removeMaintenanceComment = (content) => {
      return content.replace(/\n<!-- MAINTENANCE:[\s\S]*?-->\s*$/, '');
    };

    const normalized1 = removeMaintenanceComment(content1);
    const normalized2 = removeMaintenanceComment(content2);

    assert.equal(
      normalized1,
      normalized2,
      'SKILL.md files (1 and 2) should have identical content except for maintenance comments'
    );
  });
});
