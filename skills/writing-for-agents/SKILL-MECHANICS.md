# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (frontmatter, invocation, and router skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Frontmatter

OpenCode reads `name` and `description`, and accepts `license`, `compatibility`, and `metadata`. It ignores every other field. A skill copied from another harness usually carries `disable-model-invocation`, `allowed-tools`, `argument-hint`, or an `agents/openai.yaml` file. Remove them; they do nothing here and they hide the real mechanism.

Put the upstream source and version in `metadata`, so a later check can show how far the copy has drifted from its source.

## Invocation

OpenCode lists the `description` of every skill in the `skill` tool, and the agent can load any of them. The description is the skill's top-level context pointer, forced to stay loaded at all times. You pay that context in every session in exchange for the agent finding the skill on its own.

To keep a skill out of automatic reach, use a permission rule in `opencode.json`:

```jsonc
{ "action": "skill", "resource": "<name>", "effect": "ask" }
```

`ask` prompts the human before the load. `deny` refuses it. Both keep the description, so the context cost stays. The only zero-context option is to remove the skill from the skills directory.

## Splitting by invocation

Split off a skill when you have a distinct word that should trigger it on its own (a word you actually use in your prompts), or when another skill must reach it. You pay context for the new description, so that independent reach has to be worth it.

Shared reference that two gated skills both need should live in a plain file outside the skill system. A gated skill cannot be reached by another skill, but a plain file can be read by anything.

## Router skills

When the skill list grows past what you can remember, a router skill names the others and when to reach for each. The human remembers one skill instead of many. A router only points; it still loads the skill it names.
