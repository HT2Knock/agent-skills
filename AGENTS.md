# AGENTS.md — agent-skills

Shared skills for the local coding agents.

## Layout

- `skills/<name>/SKILL.md` — read by OpenCode.
- OpenCode-only skills live in the dotfiles repo under
  `.config/opencode/skills/`, which OpenCode reads as its global skills dir.

## Rules

- One skill per directory. Keep `SKILL.md` short. Put long reference material
  in sibling files and link to them.
- Write in Simplified Technical English. Do not use metaphors.
- Scripts live beside the skill in `scripts/`, and must run without a TTY.
- Commit and push. Pull on the other host.
