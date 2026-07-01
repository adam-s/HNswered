# CLAUDE.md

@AGENTS.md

Claude Code specifics on top of the shared instructions:

- Skills are canonical at `.agents/skills/` and auto-discovered through the `.claude/skills` symlink. Add new skills under `.agents/skills/` — never as real directories inside `.claude/`.
- Skill/format conventions: [.agents/reference/anthropic-conventions.md](.agents/reference/anthropic-conventions.md).
