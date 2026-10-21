#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/claim-task.sh claim <Txx> <agent> <model> <branch> [worktree]
  scripts/claim-task.sh status <Txx> <status>
  scripts/claim-task.sh show <Txx>
  scripts/claim-task.sh release <Txx>
  scripts/claim-task.sh list
EOF
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not inside a git worktree" >&2
  exit 2
fi

# Store claims in the common git dir so task worktrees share one lock board.
COMMON_DIR="$(git rev-parse --git-common-dir)"
CLAIMS_DIR="$(cd "$COMMON_DIR" && pwd)/agent-claims"
mkdir -p "$CLAIMS_DIR"

cmd="${1:-}"
case "$cmd" in
  claim)
    id="${2:-}"; agent="${3:-}"; model="${4:-}"; branch="${5:-}"; worktree="${6:-$PWD}"
    [[ "$id" =~ ^T[0-9]{2}$ ]] || { echo "invalid task id: $id" >&2; exit 2; }
    [[ -n "$agent" && -n "$model" && -n "$branch" ]] || { usage; exit 2; }
    dir="$CLAIMS_DIR/$id"
    if ! mkdir "$dir" 2>/dev/null; then
      echo "task $id already claimed" >&2
      cat "$dir/status" 2>/dev/null || true
      exit 1
    fi
    printf '%s\n' "$agent" > "$dir/agent"
    printf '%s\n' "$model" > "$dir/model"
    printf '%s\n' "$branch" > "$dir/branch"
    printf '%s\n' "$worktree" > "$dir/worktree"
    printf '%s\n' "claimed" > "$dir/status"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/claimed_at"
    echo "claimed $id -> $dir"
    ;;
  status)
    id="${2:-}"; value="${3:-}"
    [[ "$id" =~ ^T[0-9]{2}$ ]] || { echo "invalid task id: $id" >&2; exit 2; }
    dir="$CLAIMS_DIR/$id"
    [[ -d "$dir" ]] || { echo "task $id is not claimed" >&2; exit 1; }
    [[ -n "$value" ]] || { usage; exit 2; }
    printf '%s\n' "$value" > "$dir/status"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/updated_at"
    echo "status $id -> $value"
    ;;
  show)
    id="${2:-}"
    [[ "$id" =~ ^T[0-9]{2}$ ]] || { echo "invalid task id: $id" >&2; exit 2; }
    dir="$CLAIMS_DIR/$id"
    [[ -d "$dir" ]] || { echo "task $id is not claimed" >&2; exit 1; }
    for key in status agent model branch worktree claimed_at updated_at; do
      if [[ -f "$dir/$key" ]]; then
        printf '%-10s %s\n' "$key" "$(cat "$dir/$key")"
      fi
    done
    ;;
  release)
    id="${2:-}"
    [[ "$id" =~ ^T[0-9]{2}$ ]] || { echo "invalid task id: $id" >&2; exit 2; }
    dir="$CLAIMS_DIR/$id"
    [[ -d "$dir" ]] || { echo "task $id is not claimed" >&2; exit 1; }
    rm -rf -- "$dir"
    echo "released $id"
    ;;
  list)
    found=0
    for dir in "$CLAIMS_DIR"/*; do
      [[ -d "$dir" ]] || continue
      id="$(basename "$dir")"
      [[ "$id" =~ ^T[0-9]{2}$ ]] || continue
      found=1
      printf '%s\t%s\t%s\t%s\n' \
        "$id" \
        "$(cat "$dir/status" 2>/dev/null || echo '?')" \
        "$(cat "$dir/agent" 2>/dev/null || echo '?')" \
        "$(cat "$dir/model" 2>/dev/null || echo '?')"
    done
    [[ "$found" == 1 ]] || echo "no active claims"
    ;;
  *)
    usage
    exit 2
    ;;
esac
