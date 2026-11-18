#!/usr/bin/env bash
# Collects what helps with a sheltie bug report into one Markdown file, to
# attach to an issue (https://github.com/lavigneer/sheltie/issues).
#
#   ./diagnostics.sh [--home DIR] [--out FILE] [--log-lines N]
#
#   --home DIR       the Herdr app home (default: $HERDR_APP_HOME, else
#                    ~/.config/herdr-app)
#   --out FILE       where to write it (default: ./sheltie-diagnostics-<time>.md;
#                    - for stdout)
#   --log-lines N    how much of the end of the app log (default: 300)
#
# What it has: versions (sheltie, Herdr, git, gh, jira, jq, OS), whether the
# installed mods match this checkout, sheltie.json with anything that looks
# like a secret replaced, the recent failures the mods recorded in
# <home>/sheltie-diagnostics/, the Work sidebar's report (if Herdr is running)
# and the end of the app log. Those can name your repos, branches, tickets and
# paths: read it before you share it.

set -uo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
out="sheltie-diagnostics-$(date +%Y%m%d-%H%M%S).md"
log_lines=300

while [ $# -gt 0 ]; do
  case "$1" in
  --home)
    home="${2:?--home needs a folder}"
    shift
    ;;
  --out)
    out="${2:?--out needs a file}"
    shift
    ;;
  --log-lines)
    log_lines="${2:?--log-lines needs a number}"
    shift
    ;;
  -h | --help)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "diagnostics.sh: unknown option $1 (see --help)" >&2
    exit 2
    ;;
  esac
  shift
done

fence() { printf '\n```%s\n' "${1:-}"; cat; printf '```\n'; }
# The first line of `<program> <args>`, or why not.
version() {
  if command -v "$1" >/dev/null 2>&1; then
    "$@" 2>&1 | head -n 1
  else
    echo "not found"
  fi
}
# Settings with the values of secret-looking keys replaced (strings, numbers
# and every string in arrays under them).
redact() {
  jq 'walk(if type == "object" then
        with_entries(if (.key | test("token|secret|password|passwd|apikey|api_key|auth|cookie|credential|bearer|private|pat$|key$"; "i"))
                       and (.value | type) != "object"
                     then .value = "<redacted>" else . end)
      else . end)' "$1" 2>&1
}
# Secret-shaped text anywhere (the whole report: settings, failures, the app
# log): GitHub/Slack/AWS tokens, JWTs, Bearer/Basic/token credentials and
# passwords in URLs. src/diagnostics.js scrubs the same when recording.
scrub() {
  perl -pe '
    s/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/<redacted>/g;
    s/\b((?:bearer|basic|token)\s+)[\w.~+\/=-]{8,}/$1<redacted>/gi;
    s/(:\/\/[^\/\s:\@]+:)[^\@\s\/]+\@/$1<redacted>\@/g;
  '
}

report() {
  echo "# sheltie diagnostics"
  echo
  echo "Made $(date -u +%Y-%m-%dT%H:%M:%SZ) by diagnostics.sh. App home: \`$home\`."

  echo
  echo "## Versions"
  {
    echo "sheltie:      $(git -C "$here" describe --always --dirty --tags 2>/dev/null || echo unknown) ($(git -C "$here" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "not a git checkout"))"
    echo "os:           $(uname -srm)"
    echo "shell:        ${SHELL:-unknown}"
    echo "herdr-app:    $(version herdr-app --version)"
    echo "herdr:        $(version herdr --version)"
    echo "hc:           $(version hc --version)"
    echo "git:          $(version git --version)"
    echo "gh:           $(version gh --version)"
    echo "jira:         $(version jira version)"
    echo "jq:           $(version jq --version)"
    echo "curl:         $(version curl --version)"
    echo "sqlite3:      $(version sqlite3 --version)"
    echo "claude:       $(version claude --version)"
  } | fence

  echo
  echo "## Installed mods"
  {
    for mod in "$here"/mods/*/; do
      name="$(basename "$mod")"
      if [ ! -d "$home/mods/$name" ]; then
        echo "$name: not installed"
      elif diff -rq -x gpui-kit.d.ts -x jsconfig.json "$mod" "$home/mods/$name" >/dev/null 2>&1; then
        echo "$name: matches this checkout"
      else
        echo "$name: differs from this checkout (run ./install.sh to update)"
      fi
    done
  } | fence

  echo
  echo "## Settings"
  if [ -f "$home/sheltie.json" ]; then
    echo
    echo "\`$home/sheltie.json\`, secret-looking values replaced:"
    redact "$home/sheltie.json" | fence json
  else
    echo
    echo "No \`$home/sheltie.json\`: the defaults."
  fi

  echo
  echo "## Recorded failures"
  dir="$home/sheltie-diagnostics"
  if compgen -G "$dir/*.json" >/dev/null; then
    echo
    echo "The newest 20 of \`$dir\`:"
    for f in $(find "$dir" -maxdepth 1 -name '*.json' | sort | tail -n 20); do
      echo
      echo "### $(basename "$f" .json)"
      fence json <"$f"
    done
  else
    echo
    echo "None."
  fi

  echo
  echo "## Herdr"
  if command -v herdr-app >/dev/null 2>&1 && herdr-app status >/dev/null 2>&1; then
    herdr-app status 2>&1 | fence
    rm -f "$home/work-report.json"
    herdr-app "do" work.report >/dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -f "$home/work-report.json" ] && break
      sleep 0.5
    done
    if [ -f "$home/work-report.json" ]; then
      echo
      echo "Work sidebar (work.report):"
      fence json <"$home/work-report.json"
    else
      echo
      echo "No Work sidebar report (is the work layout on?)."
    fi
  else
    echo
    echo "Herdr isn't running (or herdr-app isn't on PATH)."
  fi

  echo
  echo "## App log"
  if [ -f "$home/app.log" ]; then
    echo
    echo "The last $log_lines lines of \`$home/app.log\`:"
    tail -n "$log_lines" "$home/app.log" | fence
  else
    echo
    echo "No \`$home/app.log\`."
  fi
}

command -v jq >/dev/null || {
  echo "diagnostics.sh: needs jq" >&2
  exit 1
}
if [ "$out" = "-" ]; then
  report | scrub
else
  report | scrub >"$out"
  echo "Wrote $out. Read it before sharing: it can name your repos, branches, tickets and paths." >&2
fi
