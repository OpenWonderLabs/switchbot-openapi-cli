import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const SKILL_1 = path.join(import.meta.dirname, '../skills/switchbot/SKILL.md');
const SKILL_2 = path.join(import.meta.dirname, '../plugins/switchbot/skills/switchbot/SKILL.md');

test('SKILL.md files have maintenance comments and identical content', async (t) => {
  await t.test('both SKILL.md files exist', () => {
    assert.ok(fs.existsSync(SKILL_1), `${SKILL_1} should exist`);
    assert.ok(fs.existsSync(SKILL_2), `${SKILL_2} should exist`);
  });

  await t.test('both SKILL.md files contain MAINTENANCE comment', () => {
    const content1 = fs.readFileSync(SKILL_1, 'utf8');
    const content2 = fs.readFileSync(SKILL_2, 'utf8');

    assert.ok(
      content1.includes('<!-- MAINTENANCE:'),
      `${SKILL_1} should contain <!-- MAINTENANCE: comment`
    );
    assert.ok(
      content2.includes('<!-- MAINTENANCE:'),
      `${SKILL_2} should contain <!-- MAINTENANCE: comment`
    );
  });

  await t.test('SKILL.md files have identical content except maintenance comments', () => {
    const content1 = fs.readFileSync(SKILL_1, 'utf8');
    const content2 = fs.readFileSync(SKILL_2, 'utf8');

    // Remove maintenance comments for comparison
    const removeMaintenanceComment = (content) => {
      return content.replace(/\n<!-- MAINTENANCE:.*-->\s*$/, '');
    };

    const normalized1 = removeMaintenanceComment(content1);
    const normalized2 = removeMaintenanceComment(content2);

    assert.equal(
      normalized1,
      normalized2,
      'SKILL.md files should have identical content except for maintenance comments'
    );
  });
});
