# Confluence

`atlassian-cli confluence <resource> <action> [flags]`. Resources: `space`, `page`, `folder`, `blog`, `attachment`, `search`, `bulk`, `analytics`, `api`.

**Read at the top of every section**: pass `--format json` for parseable output, `--format markdown` for human-readable page bodies, `table` (default) only when displaying to the user.

## Read a page inline

Use this when you only need to inspect content (no need to persist):

```bash
# full record (metadata + body in one call)
atlassian-cli confluence page get <PAGE_ID> --format json

# body only — pick the format that matches the consumer
atlassian-cli confluence page get <PAGE_ID> --body-only --format markdown   # agent-readable
atlassian-cli confluence page get <PAGE_ID> --body-only                      # raw HTML (storage format)
```

If `--body-only --format markdown` loses structure (tables, macros, code blocks), re-fetch with no `--format` flag to get raw HTML.

## Pull a page to local (PRDs, design docs, ADRs)

Save the body next to its metadata:

```bash
atlassian-cli confluence page get <PAGE_ID> --format json > <PAGE_ID>.meta.json
atlassian-cli confluence page get <PAGE_ID> --body-only --format markdown > <PAGE_ID>.md
```

Write into the reference area the user asked for. **Report the saved path, title, and version.** Completion criterion: the file exists on disk and its content matches the page the user named.

## Search

```bash
# CQL — preferred for precise queries
atlassian-cli confluence search cql 'space = TEAM AND type = page' --format json
atlassian-cli confluence search cql 'label = prd AND space = TEAM' --limit 50 --format json

# free text — for exploratory "find anything matching X"
atlassian-cli confluence search text "<query>" --format json

# within a single space
atlassian-cli confluence search in-space <SPACE_KEY> --query "<query>" --format json
```

When the user asks "find the PRD about X" or "what pages exist in TEAM space", prefer CQL with explicit filters over `search text`. CQL returns richer metadata (space, version, last-updated) that the agent needs to disambiguate.

## Create or update a page

Page bodies are passed via `--body <file>` (HTML storage format). Write the body to a temp file first; do not pass bodies inline — escaping will break.

```bash
# create
atlassian-cli confluence page create \
  --space <SPACE_ID> \
  --title "<title>" \
  --body /tmp/page.html \
  --parent <PARENT_PAGE_ID>            # optional: nest under a parent
  --format json

# update (requires version increment — see warning)
atlassian-cli confluence page update <PAGE_ID> --body /tmp/page.html --format json
```

Write the prose with the `humanizer` skill: draft it, run that process, then pass the final text as the page body. Keep code blocks, commands, paths, and link targets unchanged.

**Warning — update versioning**: Confluence rejects updates whose `--version` is not exactly `current_version + 1`. The CLI does not always auto-increment on retries after 409s. Workflow:

1. `atlassian-cli confluence page get <PAGE_ID> --format json` → read `version.number`
2. If the response includes a version-collision error, re-read and retry with the new current version + 1.

Completion criterion: the new `version.number` in the response is greater than the old one, and the body written to the page matches what the user asked for (re-read with `page get --body-only` to verify if uncertain).

## Attachments

```bash
atlassian-cli confluence attachment list <PAGE_ID> --format json
atlassian-cli confluence attachment get <ATTACHMENT_ID> --format json

# download requires an explicit output path
atlassian-cli confluence attachment download <ATTACHMENT_ID> --output ./diagram.png

atlassian-cli confluence attachment upload <PAGE_ID> --file ./diagram.png
```

## Lists, labels, comments

```bash
atlassian-cli confluence page list --space <SPACE_KEY> --format json
atlassian-cli confluence page versions <PAGE_ID> --format json
atlassian-cli confluence page add-label <PAGE_ID> --label <LABEL>
atlassian-cli confluence page add-comment <PAGE_ID> --body "<text>"
```

`page list` is paginated; pass `--limit` (and `--cursor` if the response surfaces one) when the space has many pages.

## Escape hatch

`confluence api` calls any Confluence REST endpoint with the profile's credentials. Paths are relative to the site root, so they carry their own `/wiki` prefix:

```bash
atlassian-cli confluence api /wiki/api/v2/pages --format json
atlassian-cli confluence api /wiki/rest/api/user/current --format json
```
