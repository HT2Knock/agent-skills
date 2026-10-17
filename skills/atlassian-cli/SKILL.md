---
name: atlassian-cli
description: Use the atlassian-cli tool to read, search, create, and update Confluence pages and Jira issues. Triggers on requests to sync a Confluence page to a local file, pull down a PRD, look up or open a Jira ticket, create or file a Jira issue, transition issue status, search with JQL or CQL, post a page update, or any task that names a Confluence page ID or Jira issue key. Prefer this skill over ad-hoc curl/Atlassian REST calls.
allowed-tools: Bash(atlassian-cli:*)
---

# atlassian-cli

Single CLI for Atlassian Cloud: `atlassian-cli <service> <resource> <action> [flags]`. Services: `confluence`, `jira`, `bitbucket`, `jsm`, `opsgenie`, `bamboo`, `auth`. This skill covers **Confluence** and **Jira** only.

- **Auth**: profile-based. First-time setup in [`auth.md`](auth.md). Run `atlassian-cli auth status` before any command; if it fails, load `auth.md`.
- **Output format**: always pass `--format json` (or `--format markdown` for human-readable bodies) when parsing results programmatically. The default `table` is for humans and breaks JSON parsing.
- **Progressive disclosure**: load the matching branch file only when needed:
  - Jira issues, JQL, attachments, custom fields → [`jira.md`](jira.md)
  - Jira administration: projects, components, versions, roles, workflows, bulk, automation, webhooks, audit, links, watchers → [`jira-admin.md`](jira-admin.md)
  - Confluence pages, attachments, read/write/pull → [`confluence.md`](confluence.md)
  - Auth, profiles, troubleshooting → [`auth.md`](auth.md)

## Quick start

```bash
atlassian-cli auth status                                    # confirm a working profile exists
atlassian-cli confluence page get <PAGE_ID> --format json    # read a page (metadata + body)
atlassian-cli confluence page get <PAGE_ID> --body-only --format markdown  # body only, markdown
atlassian-cli jira issue get JIRA-123 --format json          # read a Jira issue
atlassian-cli jira issue search --jql 'project = PROJ AND status = Open' --format json
atlassian-cli jira attachment download --issue JIRA-123 --dir ./attachments  # fetch issue attachments
```

For anything beyond a single read — **page sync to local files**, **page creation/updates**, **issue creation with custom fields**, **status transitions** — load the relevant branch file. Do not guess flag names; the CLI changes them across versions and the branch files pin the working invocation.
