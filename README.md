# agent-skills

One shared directory of skills for local coding agents. OpenCode reads
`~/.agents/skills` by default, so every machine that clones this repo gets the
same set.

## Install

```bash
git clone git@github.com:HT2Knock/agent-skills.git ~/.agents
```

The clone must land at `~/.agents`. OpenCode does not read skills from another
path unless you configure it.

## Layout

Each skill is one directory with a `SKILL.md`:

```
skills/
  diagnosing-bugs/
    SKILL.md
  technical-writing/
    SKILL.md
```

`SKILL.md` starts with frontmatter:

```markdown
---
name: skill-name
description: When to use this skill, in one or two sentences.
---
```

The agent reads `name` and `description` when it decides which skill to load, so
the description must name the trigger, not summarise the content. Keep both
short.

## Skills

### Code work

| Skill                       | Use it when                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `code-review`               | Reviewing a branch, a PR, or work in progress.                      |
| `fix-pr`                    | CI is red, the branch conflicts, or review comments need an answer. |
| `diagnosing-bugs`           | Something is broken, failing, or slow.                              |
| `blast-radius`              | A change may break code that the diff does not touch.               |
| `codebase-design`           | Designing a module interface or finding a deeper seam.              |
| `create-verification-skill` | A repo has no scripted way to prove behaviour.                      |

### Writing

| Skill                | Use it when                                             |
| -------------------- | ------------------------------------------------------- |
| `technical-writing`  | Writing or reviewing docs, RFCs, READMEs, or PR bodies. |
| `unslop`             | Cutting AI tells from any text.                         |
| `writing-for-agents` | Writing skills, `AGENTS.md`, or `CLAUDE.md`.            |
| `pr`                 | Writing or improving a pull request body.               |

### Workflow

| Skill               | Use it when                                           |
| ------------------- | ----------------------------------------------------- |
| `autonomous-run`    | One long task must finish without a human.            |
| `catch-up`          | Summarising what changed since the last check-in.     |
| `handoff`           | Compacting a session into a handoff document.         |
| `wip-handoff`       | Moving work to knockon before the Mac sleeps.         |
| `show-me-your-work` | Keeping a decision trail for long or unattended work. |
| `grilling`          | Stress-testing a plan or a decision.                  |

### Tools

| Skill            | Use it when                                          |
| ---------------- | ---------------------------------------------------- |
| `atlassian-cli`  | Reading or writing Jira issues and Confluence pages. |
| `gcx`            | Querying the on-prem Grafana instance.               |
| `rex`            | Driving Rex sessions, tabs, and terminal output.     |
| `security-audit` | Reviewing code or a service for security problems.   |

## Add a skill

1. Create `skills/<name>/SKILL.md`.
2. Add the frontmatter, then the instructions.
3. Keep the file small. Move long reference material into files beside it and
   point to them from `SKILL.md`.
4. Commit and push. Run `git pull` on the other machines.
