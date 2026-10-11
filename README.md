# agent-skills

One shared skills directory for the local coding agents. Both read `skills/`
directly, so a new skill lands in both.

- Layout: `skills/<name>/SKILL.md`, with `name` and `description` in the
  frontmatter.
- OpenCode reads `~/.agents/skills` by default.
- Hermes reads it through `skills.external_dirs` in `~/.hermes/config.yaml`.
- Clone this repo to `~/.agents` on each machine.
