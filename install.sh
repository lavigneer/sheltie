#!/usr/bin/env bash
# Installs sheltie into a Herdr app home. Safe to run again (to
# update): it only replaces its own mods and layout.
#
#   ./install.sh [--home DIR] [--skills] [--force-skills]
#
#   --home DIR          the Herdr app home (default: $HERDR_APP_HOME, else
#                       ~/.config/herdr-app). Start Herdr once first: this adds
#                       to the keys.json it writes.
#   --skills            also copy the agent skills (draft-pr, address-comments,
#                       fix-ci, resolve-conflicts) into ~/.agents/skills and
#                       ~/.claude/skills, keeping any that you changed
#                       (--force-skills: replace)
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
skills=0
force_skills=0

while [ $# -gt 0 ]; do
  case "$1" in
  --home)
    home="${2:?--home needs a folder}"
    shift
    ;;
  --skills | --claude-commands) skills=1 ;;
  --force-skills | --force-commands) skills=1 force_skills=1 ;;
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

# Copies from a read-only source (the Nix store) keep its modes: make them
# writable, so the next install can replace them.
writable() { [ ! -e "$1" ] || chmod -R u+w "$1"; }

# Mods.
mkdir -p "$home/mods"
for mod in "$here"/mods/*/; do
  name="$(basename "$mod")"
  writable "$home/mods/$name"
  rm -rf "${home:?}/mods/$name"
  cp -R "$mod" "$home/mods/$name"
  writable "$home/mods/$name"
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
writable "$home/layouts/sheltie.json"
writable "$home/layouts/sheltie.svg"
cp "$here/layouts/sheltie.json" "$here/layouts/sheltie.svg" "$home/layouts/"
writable "$home/layouts/sheltie.json"
writable "$home/layouts/sheltie.svg"
echo "layout: sheltie (switch with: herdr-app do layout.switch --name sheltie)"

# Settings.
if [ -f "$home/sheltie.json" ]; then
  echo "settings: $home/sheltie.json (kept)"
else
  # Only what you'll want to change first; everything else keeps the defaults
  # (config.example.json shows them all).
  printf '{\n  "$schema": "https://raw.githubusercontent.com/lavigneer/sheltie/main/sheltie.schema.json",\n  "roots": ["~/workspace"],\n  "tracker": "jira"\n}\n' >"$home/sheltie.json"
  echo "settings: $home/sheltie.json (new: edit it; config.example.json has every setting)"
fi

# Agent skills (agentskills.io format): ~/.agents/skills is read by most
# agents (Codex, Gemini CLI, ...), ~/.claude/skills by Claude Code.
if [ "$skills" = 1 ]; then
  for dir in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    for src in "$here"/skills/*/; do
      name="$(basename "$src")"
      dest="$dir/$name"
      if [ -e "$dest" ] && ! diff -rq "$src" "$dest" >/dev/null && [ "$force_skills" = 0 ]; then
        echo "skills: kept your $dest (differs; --force-skills replaces it)"
      else
        writable "$dest"
        mkdir -p "$dest"
        cp -R "$src". "$dest"/
        writable "$dest"
        echo "skills: $dest"
      fi
    done
  done
fi
