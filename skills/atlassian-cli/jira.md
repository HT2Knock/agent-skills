# Jira

`atlassian-cli jira <resource> <action> [flags]`.

Common resources: `issue`, `attachment`, `fields`, `api`. Project-administration resources live in [`jira-admin.md`](jira-admin.md).

**Read at the top of every section**: pass `--format json` to parse responses programmatically. The `table` default is for humans.

## Get a single issue

```bash
atlassian-cli jira issue get <ISSUE_KEY> --format json           # e.g. PROJ-1234
```

Returns the full record: summary, description, status, assignee, reporter, priority, labels, components, fixVersions, all custom fields, and an attachment section. Use this as the first call whenever the user names an issue key.

`--fields` returns exactly the fields you ask for and drops the description and attachment sections:

```bash
atlassian-cli jira issue get PROJ-1234 --fields summary,status --format json
atlassian-cli jira issue get PROJ-1234 --fields all --format json
```

## Search

Two equivalent entry points — pick by intent:

```bash
# JQL — for ad-hoc queries
atlassian-cli jira issue search --jql 'project = PROJ AND status = Open ORDER BY created DESC' --format json
atlassian-cli jira issue search --jql 'assignee = @me AND sprint in openSprints()' --format json

# structured filters — when the user gives a flat list of conditions
atlassian-cli jira issue search --project PROJ --status Open --status "In Progress" --format json
atlassian-cli jira issue search --assignee @me --priority High --format json
```

`--jql` and the filter flags conflict with each other; pick one. `--status` is repeatable for OR semantics. When the user asks "show me my open tickets" or "find issues assigned to X", default to JQL — it composes and the agent can read it back to the user.

`--limit` caps the result count; pass it explicitly whenever a query could be wide. For exhaustive runs, iterate with the cursor / page token the response exposes (or run JQL in chunks).

## Attachments

Read the attachment section from `issue get`, or list directly:

```bash
atlassian-cli jira attachment list <ISSUE_KEY> --format json
atlassian-cli jira attachment get <ATTACHMENT_ID> --format json
```

Download content by attachment ID, or every attachment on an issue at once:

```bash
atlassian-cli jira attachment download <ATTACHMENT_ID>                          # -> ./<server filename>
atlassian-cli jira attachment download <ATTACHMENT_ID> --output ./screenshot.png
atlassian-cli jira attachment download <ATTACHMENT_ID> --output - | file -      # inspect type first
atlassian-cli jira attachment download --issue <ISSUE_KEY> --dir ./attachments  # bulk
```

The default output name is the server-supplied filename in the current directory. Upload one or more files:

```bash
atlassian-cli jira attachment upload <ISSUE_KEY> --file ./report.pdf --file ./a.png
```

Completion criterion: the file exists on disk and `file` reports the expected type. To view an image, download it and read the saved path.

## Create an issue

```bash
atlassian-cli jira issue create \
  --project <KEY> \
  --issue-type <Task|Bug|Story|...> \
  --summary "<title>" \
  --description "<text>" \
  --assignee <email|accountId> \
  --priority <Name> \
  --label <label> --label <label> \
  --field 'customfield_10001={"value":"Alpha"}' \
  --format json
```

**Custom fields** use `--field 'id=<json>'`. Find the IDs first:

```bash
atlassian-cli jira fields list --format json | jq '.[] | {id, name}'
atlassian-cli jira fields get <id> --format json
```

The CLI rejects `--field` keys that collide with reserved names (`project`, `issuetype`, `summary`) or with typed flags. For multi-value fields (arrays, option lists), pass a JSON array; for single values, a single object — see the CLI's own `--help` examples when in doubt.

Completion criterion: the response contains a new issue key (e.g. `PROJ-1234`); if the user gave a summary, the returned `summary` matches it exactly.

## Update an issue

```bash
# mutate specific fields
atlassian-cli jira issue update <KEY> --summary "<new>" --priority High --format json
atlassian-cli jira issue update <KEY> --assignee <email> --format json
atlassian-cli jira issue update <KEY> --field 'customfield_10001={"value":"Beta"}' --format json
atlassian-cli jira issue update <KEY> --add-label <label> --format json
```

**Always re-read with `issue get` after an update** when the user is depending on the new value — updates can return 200 with stale state if Jira indexed lazily.

## Transition status

```bash
# discover valid transitions
atlassian-cli jira issue transition <KEY> --list --format json

# execute one
atlassian-cli jira issue transition <KEY> --to "In Progress" --format json
atlassian-cli jira issue transition <KEY> --to "Done" --comment "Closing per <reason>" --format json
```

Statuses are workflow-specific strings. Do **not** guess — run `--list` first, then transition by exact name. The CLI returns the available `to` names in the `--list` response; copy them verbatim.

## Comments

Read the comment thread to understand a ticket:

```bash
atlassian-cli jira issue comments <KEY> --format json
```

## Escape hatch

`jira api` calls any Jira REST endpoint with the profile's credentials. Use it for fields the typed commands drop:

```bash
atlassian-cli jira api /rest/api/3/myself --format json
```
