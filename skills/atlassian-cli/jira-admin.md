# Jira administration

`jira` resources that change project configuration. Load this file only for these tasks.

Resources: `project`, `components`, `versions`, `roles`, `workflows`, `bulk`, `automation`, `webhooks`, `audit`. Issue-level links and watchers are here too.

**Read at the top of every section**: pass `--format json`.

## Projects, components, versions

```bash
atlassian-cli jira project list --format json
atlassian-cli jira project get <KEY> --format json
atlassian-cli jira components list --project <KEY> --format json
atlassian-cli jira versions list --project <KEY> --format json
atlassian-cli jira versions create --project <KEY> --name "<v>" --format json
```

Use these to resolve human names to keys/IDs when the user says "the PROJ project" but you only have a name, or to create a fix-version for a release.

`project`, `components`, and `versions` each add `create`, `update`, and `delete`; `versions` also has `merge`.

## Roles

Subcommands: `list`, `get`, `actors`, `add-actor`, `remove-actor`.

```bash
atlassian-cli jira roles list --format json
atlassian-cli jira roles actors <ROLE_ID> --format json
```

## Workflows

Subcommands: `list`, `get`, `export`.

```bash
atlassian-cli jira workflows list --format json
atlassian-cli jira workflows export <WORKFLOW_ID> --output workflow.json
```

## Issue links and watchers

```bash
atlassian-cli jira issue links <KEY> --format json
atlassian-cli jira issue links <KEY> --add --type "blocks" --to <OTHER_KEY> --format json
atlassian-cli jira issue watchers <KEY> --add <email> --format json
```

## Bulk operations

Subcommands: `transition`, `assign`, `label`, `export`, `import`. Run `atlassian-cli jira bulk <sub> --help` for the flags of each.

## Automation rules

Subcommands: `list`, `get`, `create`, `update`, `enable`, `disable`, `delete`, `export`.

```bash
atlassian-cli jira automation list --format json
atlassian-cli jira automation enable <RULE_ID>
```

## Webhooks

Subcommands: `list`, `get`, `create`, `update`, `enable`, `disable`, `delete`, `test`.

## Audit log

```bash
atlassian-cli jira audit list --format json
atlassian-cli jira audit export --output audit.json
```
