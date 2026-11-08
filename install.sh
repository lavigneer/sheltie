#!/usr/bin/env bash
# Installs sheltie into a Herdr app home. Safe to run again (to
# update): it only replaces its own mods and layout.
#
#   ./install.sh [--home DIR] [--claude-commands] [--force-commands]
#
#   --home DIR          the Herdr app home (default: $HERDR_APP_HOME, else
#                       ~/.config/herdr-app). Start Herdr once first: this adds
#                       to the keys.json it writes.
#   --claude-commands   also copy the Claude Code commands (/draft-pr,
#                       /address-comments, /fix-ci, /resolve-conflicts) into
#                       ~/.claude/commands,
#                       keeping any that you changed (--force-commands: replace)
#
# What it does:
#   mods/*                  copied to <home>/mods/ (replacing earlier versions)
#   keys.json               ctrl-shift-j (tickets), ctrl-shift-f (projects) and
#                           the Work sidebar's alt-shift keys (in the sheltie
#                           layout only) added to
#                           <home>/keys.json, unless you use those keys
#   layouts/sheltie.*       copied to <home>/layouts/ (Herdr with the Work sidebar)
#   sheltie.json        a starter settings file if there is none
# Needs bash and jq.

set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
claude=0
force_commands=0

while [ $# -gt 0 ]; do
  case "$1" in
  --home)
    home="${2:?--home needs a folder}"
    shift
    ;;
  --claude-commands) claude=1 ;;
  --force-commands) claude=1 force_commands=1 ;;
  -h | --help)
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "install.sh: unknown option $1 (see --help)" >&2
    exit 2
    ;;
  esac
  shift
done

command -v jq >/dev/null || {
  echo "install.sh: needs jq" >&2
  exit 1
}
if [ ! -f "$home/keys.json" ]; then
  echo "install.sh: $home has no keys.json yet: start Herdr once, then run this again." >&2
  exit 1
fi

# Mods.
mkdir -p "$home/mods"
for mod in "$here"/mods/*/; do
  name="$(basename "$mod")"
  rm -rf "${home:?}/mods/$name"
  cp -R "$mod" "$home/mods/$name"
  echo "mod: $name"
done

# Keys: ours only where the key is free in that section.
taken="$(jq -r --slurpfile ours "$here/keys.json" '
  [$ours[0] | to_entries[] | .key as $s | .value | to_entries[] | {s: $s, k: .key, a: .value}] as $want
  | . as $mine
  | $want[] | select(($mine[.s] // {})[.k] != null and ($mine[.s] // {})[.k] != .a)
  | "\(.s) \(.k) is \($mine[.s][.k]); not binding it to \(.a)"' "$home/keys.json")"
[ -z "$taken" ] || echo "$taken"
tmp="$(mktemp "$home/keys.json.XXXXXX")"
jq --slurpfile ours "$here/keys.json" '
  reduce ($ours[0] | to_entries[]) as $sec (.;
    .[$sec.key] = ($sec.value + (.[$sec.key] // {})))' "$home/keys.json" >"$tmp"
mv "$tmp" "$home/keys.json"
echo "keys: $(jq -r 'to_entries | map(.value | to_entries[] | "\(.key) → \(.value)") | join(", ")' "$here/keys.json")"

# Layout.
mkdir -p "$home/layouts"
cp "$here/layouts/sheltie.json" "$here/layouts/sheltie.svg" "$home/layouts/"
echo "layout: sheltie (switch with: herdr-app do layout.switch --name sheltie)"

# Settings.
if [ -f "$home/sheltie.json" ]; then
  echo "settings: $home/sheltie.json (kept)"
else
  # Only what you'll want to change first; everything else keeps the defaults
  # (config.example.json shows them all).
  printf '{\n  "roots": ["~/workspace"],\n  "tracker": "jira"\n}\n' >"$home/sheltie.json"
  echo "settings: $home/sheltie.json (new: edit it; config.example.json has every setting)"
fi

# Claude Code commands.
if [ "$claude" = 1 ]; then
  mkdir -p "$HOME/.claude/commands"
  for f in "$here"/agents/claude/*.md; do
    dest="$HOME/.claude/commands/$(basename "$f")"
    if [ -e "$dest" ] && ! cmp -s "$f" "$dest" && [ "$force_commands" = 0 ]; then
      echo "claude: kept your $(basename "$f") (differs; --force-commands replaces it)"
    else
      cp "$f" "$dest"
      echo "claude: /$(basename "$f" .md)"
    fi
  done
fi
