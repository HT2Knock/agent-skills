# AGENTS.md — agent-skills

Shared skills for the local agents.

## Layout

- `skills/<name>/SKILL.md` — read by both Hermes and OpenCode.
- `hermes-skills/<name>/SKILL.md` — read by Hermes only, for skills that teach
  the Hermes gateway. `opencode-afk` lives here.
- OpenCode-only skills live in the dotfiles repo under
  `.config/opencode/skills/`, which OpenCode reads as its global skills dir.

## Rules

- One skill per directory. Keep `SKILL.md` short. Put long reference material
  in sibling files and link to them.
- Write in Simplified Technical English. Do not use metaphors.
- Scripts live beside the skill in `scripts/`, and must run without a TTY.
- After adding or changing a skill, restart `hermes-gateway` on knockon. The
  gateway reads the skill index at start.
- Commit and push. Pull on the other host.
