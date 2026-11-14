#!/usr/bin/env bash
# Snapshot a dirty worktree into refs/heads/wip/<topic> without touching it.
set -euo pipefail

readonly MAX_FILE_BYTES=$((50 * 1024 * 1024))
readonly MAX_FILE_MIB=$((MAX_FILE_BYTES / 1024 / 1024))

TEMP_INDEX=""

cleanup() {
    if [[ -n "$TEMP_INDEX" && -f "$TEMP_INDEX" ]]; then
        rm -f "$TEMP_INDEX"
    fi
}

trap cleanup EXIT

usage() {
    cat <<'EOF'
Usage: push-wip.sh [options] <topic>

Snapshot the working tree, including untracked files that git does not ignore,
into a commit and push it to wip/<topic>. The working tree and the real index
are not changed.

Options:
  --repo <path>      Repository to snapshot (default: current directory)
  --remote <name>    Remote to push to (default: origin)
  --target <spec>    Push to this target instead of --remote. Use an SSH spec
                     such as knockon:/home/me/workspace/github.com/me/repo
  --dry-run          Create the snapshot and print it; do not push
  --allow-large      Allow new files larger than 50 MiB
  --allow-secret     Allow paths that look like secrets
  -h, --help         Show this help
EOF
}

log() {
    local level="$1"
    shift
    printf '[%s] %s\n' "$level" "$*" >&2
}

is_secret_path() {
    local path="$1"

    case "$path" in
        *.pem|*.key|*.p12|*.pfx|*id_rsa|*id_ed25519|*id_ecdsa|*.npmrc|*.pypirc|*credentials)
            return 0
            ;;
        *.env|*.envrc)
            case "$path" in
                *.example|*.sample|*.template|*.dist)
                    return 1
                    ;;
                *)
                    return 0
                    ;;
            esac
            ;;
    esac

    return 1
}

list_changes() {
    local repo="$1"
    local commit="$2"

    if git -C "$repo" rev-parse --verify -q HEAD >/dev/null; then
        git -C "$repo" diff --name-only -z --diff-filter=ACMR HEAD "$commit"
    else
        git -C "$repo" ls-tree -r -z --name-only "$commit"
    fi
}

check_secrets() {
    local repo="$1"
    local commit="$2"
    local path
    local found=0

    while IFS= read -r -d '' path; do
        if is_secret_path "$path"; then
            log warn "secret-like path: $path"
            found=1
        fi
    done < <(list_changes "$repo" "$commit")

    ((found == 0))
}

check_size() {
    local repo="$1"
    local commit="$2"
    local path record size found=0
    local -A changed=()

    while IFS= read -r -d '' path; do
        changed["$path"]=1
    done < <(list_changes "$repo" "$commit")

    while IFS= read -r -d '' record; do
        size="${record%% *}"
        path="${record#* }"
        [[ -n "${changed[$path]+set}" ]] || continue
        if [[ "$size" =~ ^[0-9]+$ ]] && ((size > MAX_FILE_BYTES)); then
            log warn "new file is larger than ${MAX_FILE_MIB} MiB: $path ($((size / 1024 / 1024)) MiB)"
            found=1
        fi
    done < <(git -C "$repo" ls-tree -r -z --format='%(objectsize) %(path)' "$commit")

    ((found == 0))
}

snapshot() {
    local repo="$1"
    local topic="$2"
    local git_dir real_index index tree commit parent

    git_dir="$(git -C "$repo" rev-parse --absolute-git-dir)"
    real_index="$git_dir/index"

    # The temporary index lives next to the real one so a split index can find
    # its shared index file.
    index="$(mktemp "$git_dir/wip-index.XXXXXX")"
    TEMP_INDEX="$index"

    # Reuse the real index so the scan can use its stat data, untracked cache,
    # and fsmonitor extension. Only the copy is modified.
    if [[ -f "$real_index" ]]; then
        cp "$real_index" "$index"
    else
        rm -f "$index"
        GIT_INDEX_FILE="$index" git -C "$repo" read-tree --empty
    fi

    GIT_INDEX_FILE="$index" git -C "$repo" add -A
    tree="$(GIT_INDEX_FILE="$index" git -C "$repo" write-tree)"
    rm -f "$index"
    TEMP_INDEX=""

    if git -C "$repo" rev-parse --verify -q "refs/wip/$topic" >/dev/null; then
        if [[ "$tree" == "$(git -C "$repo" rev-parse "refs/wip/$topic^{tree}")" ]]; then
            log info "no changes since wip/$topic was last pushed"
            return 1
        fi
    fi

    if git -C "$repo" rev-parse --verify -q HEAD >/dev/null; then
        if [[ "$tree" == "$(git -C "$repo" rev-parse 'HEAD^{tree}')" ]]; then
            log info "working tree matches HEAD; nothing to snapshot"
            return 1
        fi
        parent="$(git -C "$repo" rev-parse HEAD)"
        commit="$(git -C "$repo" commit-tree "$tree" -p "$parent" -m "wip: $topic")"
    else
        if [[ -z "$(git -C "$repo" ls-tree -r --name-only "$tree")" ]]; then
            log info "no tracked or untracked files; nothing to snapshot"
            return 1
        fi
        commit="$(git -C "$repo" commit-tree "$tree" -m "wip: $topic")"
    fi

    printf '%s\n' "$commit"
}

main() {
    local repo="." remote="origin" target="" topic=""
    local dry_run=0 allow_large=0 allow_secret=0
    local commit

    while (($# > 0)); do
        case "$1" in
            --repo)
                repo="$2"
                shift 2
                ;;
            --remote)
                remote="$2"
                shift 2
                ;;
            --target)
                target="$2"
                shift 2
                ;;
            --dry-run)
                dry_run=1
                shift
                ;;
            --allow-large)
                allow_large=1
                shift
                ;;
            --allow-secret)
                allow_secret=1
                shift
                ;;
            -h|--help)
                usage
                return 0
                ;;
            -*)
                log error "unknown option: $1"
                usage
                return 1
                ;;
            *)
                topic="$1"
                shift
                ;;
        esac
    done

    if [[ -z "$topic" || "$topic" == -* || "$topic" == *..* || "$topic" == */ || ! "$topic" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
        log error "invalid topic: $topic"
        usage
        return 1
    fi

    if ! repo="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)"; then
        log error "not a git repository: $repo"
        return 1
    fi

    if ! commit="$(snapshot "$repo" "$topic")"; then
        return 0
    fi

    if ((allow_secret == 0)) && ! check_secrets "$repo" "$commit"; then
        log error "refusing to push secret-like paths; pass --allow-secret to override"
        return 1
    fi

    if ((allow_large == 0)) && ! check_size "$repo" "$commit"; then
        log error "refusing to push large new files; pass --allow-large to override"
        return 1
    fi

    log ok "snapshot $commit for wip/$topic"
    git -C "$repo" diff --stat HEAD "$commit" 2>/dev/null || git -C "$repo" show --stat --oneline "$commit"

    if ((dry_run == 1)); then
        log info "dry run; not recorded, not pushed"
        return 0
    fi

    if [[ -z "$target" ]]; then
        if ! git -C "$repo" remote get-url "$remote" >/dev/null 2>&1; then
            log error "remote '$remote' not found; pass --target host:/path/to/repo"
            return 1
        fi
        target="$remote"
    fi

    git -C "$repo" push --force "$target" "$commit:refs/heads/wip/$topic"
    git -C "$repo" update-ref "refs/wip/$topic" "$commit"
    log ok "pushed wip/$topic to $target"
}

main "$@"
