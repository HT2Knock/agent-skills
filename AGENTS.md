# AGENTS.md — agent-skills

One shared skills directory for the local agents.

## Layout

`skills/<name>/SKILL.md`, with `name` and `description` in the frontmatter.
Both Hermes and OpenCode read `skills/` directly.

## Rules

- One skill per directory. Keep `SKILL.md` short. Put long reference material
  in sibling files and link to them.
- Write in Simplified Technical English. Do not use metaphors.
- Scripts live beside the skill in `scripts/`, and must run without a TTY.
- After adding or changing a skill, restart `hermes-gateway` on knockon. The
  gateway reads the skill index at start.
- Commit and push. Pull on the other host.
