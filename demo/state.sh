# shellcheck shell=bash
# Shared by the demo's fake jira, gh and agent (demo/bin) and herdr-demo: the
# demo's "Jira/GitHub" live in $HERDR_DEMO/state.json (a copy of a data-*.json
# fixture made by `herdr-demo`, then changed as you work). CI runs take
# $DEMO_CI_SECONDS and pass unless `herdr-demo fail-ci` said otherwise (none
# runs on a PR `herdr-demo conflict` made conflict with its base); PRs
# with auto-merge on merge once approved and green; GitHub then deletes their
# branch and closes the issues they close. Needs bash, jq and git.

: "${HERDR_DEMO:=${XDG_STATE_HOME:-$HOME/.local/state}/herdr-demo}"
state="$HERDR_DEMO/state.json"
DEMO_CI_SECONDS="${DEMO_CI_SECONDS:-20}"

need_state() {
  [ -e "$state" ] || {
    echo "herdr-demo: no demo in $HERDR_DEMO (run herdr-demo first)" >&2
    exit 1
  }
}

# state_jq [jq options...] <filter>: read the state.
state_jq() {
  need_state
  jq "$@" "$state"
}

# state_set [jq options...] <filter>: change the state, one writer at a time
# (a mkdir lock: flock isn't on macOS).
state_set() {
  local tmp lock="$state.lock" tries=0
  need_state
  until mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    # A lock older than a few seconds is left over from a killed writer.
    if [ "$tries" -gt 50 ]; then rmdir "$lock" 2>/dev/null || true; fi
    sleep 0.1
  done
  tmp="$(mktemp "$state.XXXXXX")"
  if jq "$@" "$state" >"$tmp"; then mv "$tmp" "$state"; else rm -f "$tmp"; fi
  rmdir "$lock"
}

# A new CI run for the PR(s) matching <select filter>.
ci_start() {
  state_set "(.prs[] | select($1)) |= (.checks = \"IN_PROGRESS\" | .checksDoneAt = (now + $DEMO_CI_SECONDS) | .checksResult = (if .failNext then \"FAILURE\" else \"SUCCESS\" end) | .failNext = false)"
}

# Time passes: finish CI runs that are due, then merge what auto-merge can.
state_tick() {
  state_set '
    .prs |= map(
      (if .checks == "IN_PROGRESS" and (.checksDoneAt // 0) <= now
       then .checks = .checksResult else . end)
      | (if (.state // "OPEN") == "OPEN" and .autoMerge and (.draft | not)
            and .review == "APPROVED" and .checks == "SUCCESS"
            and .mergeable != "CONFLICTING"
         then .state = "MERGED" | .justMerged = true else . end))'
  delete_merged_branches
}

# GitHub deletes a merged PR's branch (its refs/pull/<n>/head stays).
delete_merged_branches() {
  local merged remote name branch number
  merged="$(state_jq -r '.prs[] | select(.justMerged) | [(.repo | split("/")[1]), .branch, .number] | @tsv')"
  [ -n "$merged" ] || return 0
  while IFS=$'\t' read -r name branch number; do
    remote="$HERDR_DEMO/remotes/$name.git"
    pr_head "$name" "$branch" "$number" >/dev/null
    git -C "$remote" update-ref -d "refs/heads/$branch" 2>/dev/null || true
  done <<<"$merged"
  # Issues a merged PR closes ("Closes #12", "Fixes #12", ...) are closed.
  state_set '
    [.prs[] | select(.justMerged)
     | {repo, nums: [((.title // "") + " " + (.body // ""))
                     | scan("(?i)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #([0-9]+)")
                     | .[0] | tonumber]}] as $m
    | (if .issues then .issues |= map(. as $i
         | if any($m[]; .repo == $i.repo and (.nums | index($i.number)))
           then .state = "CLOSED" else . end) else . end)
    | .prs |= map(del(.justMerged))'
}

# The commit a PR's branch points at on the "GitHub" remote (its head).
# Like GitHub, refs/pull/<n>/head follows the branch while it exists.
pr_head() { # <repo name> <branch> <number>
  local remote="$HERDR_DEMO/remotes/$1.git" head
  if head="$(git -C "$remote" rev-parse --quiet --verify "refs/heads/$2" 2>/dev/null)"; then
    git -C "$remote" update-ref "refs/pull/$3/head" "$head"
    echo "$head"
  else
    git -C "$remote" rev-parse --quiet --verify "refs/pull/$3/head" 2>/dev/null || true
  fi
}
