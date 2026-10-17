# Auth

`atlassian-cli` is profile-based. Profiles live in `~/.atlassian-cli/config.yaml`; credentials (the API token) are stored encrypted in `~/.atlassian-cli/credentials.enc` and never appear in the config file in plain text.

## First-time setup

```bash
atlassian-cli auth login --profile <name>
```

The wizard prompts for the Atlassian site URL (e.g. `https://acme.atlassian.net`), email, and an **API token** — not a password. Generate the token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

Use a separate profile per Atlassian site (work vs personal) and pass `--profile <name>` per command, or set `default_profile` in `config.yaml`.

## Verify before every session

```bash
atlassian-cli auth status              # shows each profile + which services are reachable
atlassian-cli auth whoami              # who the default profile authenticates as
atlassian-cli auth test --profile <n>  # round-trip check
```

If `auth status` reports any service as **unauthenticated**, the next CLI call will fail with a 401. Do not retry; load this file and walk the user through `auth login` (or have them re-enter the API token — they may have rotated it).

## Common failures

- **`unauthorized` / `401`** — token expired or revoked. Re-run `atlassian-cli auth login --profile <name>` to re-enter the token.
- **`profile "X" not found`** — typo, or the profile was never created. Run `atlassian-cli auth list` to see what exists.
- **`credentials.enc corrupt` / keychain prompts** — the encrypted blob depends on a system keychain entry. If it was deleted (or you're in a fresh sandbox), re-run `auth login` to regenerate.
- **`base_url` is wrong** — the config has `https://acme.atlassian.net/` (with trailing slash). Don't hand-edit to drop the slash; the CLI expects it.

## Multi-profile shorthand

```bash
# one-off override
atlassian-cli --profile personal jira issue get HOME-1 --format json

# persist the default
# in ~/.atlassian-cli/config.yaml:
#   default_profile: work
```

The user's setup in this workspace: `default_profile: work`, `base_url: https://airrlabs.atlassian.net/`, `email: ngoc.hts@airrlabs.com`. Credentials decrypt via the system keychain — never echo the token or the encrypted file contents back to the user or into logs.
