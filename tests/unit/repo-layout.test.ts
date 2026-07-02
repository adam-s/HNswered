/**
 * Tripwire for the cross-agent skills layout (see AGENTS.md "Skills").
 *
 * `.claude/skills` must be a SYMLINK to `.agents/skills` — it is the only
 * thing plugging the skills into Claude Code's filesystem-based auto-
 * discovery. If it breaks (Windows checkout without symlink support, ZIP
 * download, someone replacing it with a real directory), the failure is
 * SILENT: skills just vanish from the session with no error. This test
 * turns that into a red build instead.
 *
 * Recovery: ln -s ../.agents/skills .claude/skills
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('.claude/skills is a symlink resolving to .agents/skills', () => {
  const link = resolve(ROOT, '.claude', 'skills');
  const st = lstatSync(link); // throws loudly if the link is missing entirely
  assert.ok(
    st.isSymbolicLink(),
    '.claude/skills must be a symlink, not a real directory — a real dir forks the skill canon. See AGENTS.md "Skills".',
  );
  assert.equal(readlinkSync(link), '../.agents/skills', 'symlink must point at the canonical .agents/skills');
  assert.ok(existsSync(resolve(ROOT, '.agents', 'skills')), 'symlink target .agents/skills must exist');
});

test('every skill directory has a SKILL.md', () => {
  const skillsDir = resolve(ROOT, '.agents', 'skills');
  const entries = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(entries.length > 0, 'expected at least one skill under .agents/skills');
  for (const e of entries) {
    assert.ok(
      existsSync(resolve(skillsDir, e.name, 'SKILL.md')),
      `.agents/skills/${e.name}/ is missing SKILL.md — Claude Code discovery requires it`,
    );
  }
});
