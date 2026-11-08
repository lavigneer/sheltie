# herdr-ticket-flow

Mods for the [Herdr](https://herdr.dev) desktop app that take a ticket from
your tracker to a merged pull request without leaving Herdr:

1. **Pick a ticket** (Ctrl+Shift+J). Enter creates the ticket's branch and a
   git worktree for it, opens a space there and starts your coding agent
   (Claude Code by default) with the ticket as its first message.
2. **Drive the PR from the sidebar.** The Work sidebar lists every worktree by
   repo with its ticket, its pull request (review, checks, unresolved
   comments) and a button for the next step:
   - **Draft PR**, **Fix CI**, **Address comments**: sent to the agent in that
     worktree's space (as `/draft-pr`, `/fix-ci`, `/address-comments`)
   - **Ready**: marks the PR ready for review and, when the repo requires
     reviews, turns on auto-merge, so it merges on approval. Offered once CI
     is green and nothing is unresolved; with `workflow.readyWhen: "agent"`,
     also only once the agent says the PR is done, by running
     `hc label "$HC_TERMINAL_ID" pr=ready` (the Claude commands end with that;
     sending the agent another step clears it)
   - **Merge**: when it's approved and green without auto-merge
   - **Finish** (after the merge): closes the space, removes the worktree and
     local branch, and resolves the ticket
   Every step also runs from the keyboard (see [Keys](#keys)). Click a row's
   PR label to open the PR in the browser, its ticket key or status to open
   the ticket (anywhere else on the row: its space).
3. **Get told** when CI finishes, review comments or a review arrive, or the PR
   merges.

Trackers: **Jira** (Cloud or Server, through jira-cli) and **GitHub issues**.
Code hosting: GitHub. A third mod, **projects** (Ctrl+Shift+F), is a plain
project switcher over your repos.

> **What it runs and changes.** The mods run `git`, `gh`, `jira` and `hc` as
> you. Through them they create branches and worktrees, push (via the agent),
> mark PRs ready, turn on auto-merge, merge, delete local branches and
> worktrees, and move or close tickets. Safety checks: auto-merge is only
> turned on while a review is still required (so it can't merge at once);
> Finish refuses if the worktree has uncommitted changes or commits that
> aren't in the PR, asks for a second click, and leaves the ticket open while
> other work on it is still open; an existing branch or PR is never replaced
> by an empty look-alike branch.

## Requirements

- Herdr desktop (tested with herdr-app 0.1.10, herdr-core 0.1.15)
- git, [gh](https://cli.github.com) (logged in), jq (for install.sh and the demo)
- For Jira: [jira-cli](https://github.com/ankitpokhrel/jira-cli), set up with
  `jira init` (Server/Data Center: `--installation local --auth-type bearer`
  and a personal access token)
- An agent; the defaults expect [Claude Code](https://claude.com/claude-code)

## Install

Start Herdr once (it writes the keys and layouts the installer adds to), then:

```sh
git clone https://github.com/lavigneer/herdr-ticket-flow
cd herdr-ticket-flow
./install.sh --claude-commands
herdr-app do layout.switch --name work
```

`install.sh` copies the mods into Herdr's app home (`$HERDR_APP_HOME`, else
`~/.config/herdr-app`), binds Ctrl+Shift+J, Ctrl+Shift+F
and the Work sidebar's keys (see [Keys](#keys)) where they're free,
creates `layouts/work.json` (Herdr's main layout with the Work sidebar under
Spaces), and writes a starter `ticket-flow.json`. `--claude-commands` also
copies the Claude Code commands into `~/.claude/commands`. Run it again after
pulling to update.

With Nix, the flake's `packages.default` has the same files under
`share/herdr-ticket-flow`, plus `herdr-ticket-flow-install` and `herdr-demo`.

## Keys

`install.sh` binds these where they're free (Herdr's defaults leave them free):

| Key | Command | |
|---|---|---|
| Ctrl+Shift+J | `mod.open:tickets` | pick a ticket |
| Ctrl+Shift+F | `mod.open:projects` | switch project |
| Alt+Shift+Down / Up | `work.next` / `work.prev` | select the next / previous row in the Work sidebar |
| Alt+Shift+Right / Left | `work.step-next` / `work.step-prev` | pick the selected row's next / previous step button |
| Alt+Shift+Enter | `work.step` | run the picked step (Finish and Clean up: press twice) |
| Alt+Shift+O | `work.open` | open the selected row's space, like clicking it |
| Alt+Shift+P | `work.open-pr` | open the selected row's PR in the browser, like clicking its PR label |
| Alt+Shift+T | `work.open-ticket` | open the selected row's ticket in the browser, like clicking its key or status |

A row without a PR, or whose branch isn't a ticket, just says so (a
notification) for that key. The browser opens with `xdg-open` (Linux) or
`open` (macOS).

The selected row has an accent outline and its picked step an accent border.
It follows the focused space (its first step picked) until you move it, and
goes back to following when you focus another space. The commands also work
from the command line, e.g. `herdr-app do work.step`. Rebind them in
`<Herdr app home>/keys.json`.

Two more, for scripts (no key): `herdr-app do work.refresh` refreshes the
sidebar now, like its ↻, and `herdr-app do work.report` writes what it shows
(rows, their PRs and next steps, the selected row and step, and the PR and
ticket URLs `work.open-pr` / `work.open-ticket` would open) to
`<Herdr app home>/work-report.json`.

## Settings

`<Herdr app home>/ticket-flow.json`, merged over the defaults: set only what
you change. Changes apply when a mod next loads (reopen the popup; the sidebar
reloads with the layout). [`config.example.json`](config.example.json) shows
every setting with its default; `src/config.js` documents each one.

| Setting | Default | |
|---|---|---|
| `roots`, `depth` | `["~/workspace"]`, `1` | where your repos are: `depth` levels below each root |
| `programs` | `git`, `gh`, `jira`, `hc` | found on your login shell's PATH; absolute paths win |
| `tracker` | `"jira"` | or `"github"` |
| `jira.jql` | your unresolved tickets | which tickets to list |
| `jira.transitions` | `{start: null, review: null, done: "Resolved"}` | Jira transition at each step |
| `jira.resolution` | `null` | resolution for the `done` transition |
| `github.repos` | `[]` (anywhere) | where to look for issues |
| `github.assignee`, `github.search` | `"@me"`, `""` | which issues |
| `github.ref` | `"issue-{number}"` | an issue's part of a branch name |
| `github.closeOnFinish` | `true` | close the issue at Finish if merging didn't |
| `githubOwners` | `[]` | extra orgs searched for PRs mentioning a Jira key |
| `repoRules` | `[]` | `{component \| label \| project, repo}`: where new work goes |
| `branch` | `"{ref}"` | branch name; `{ref}` is `WEB-142` or `issue-12`, e.g. `"me/{ref}"` |
| `worktreeDir` | `".worktrees"` | relative to the repo's main checkout |
| `agent.argv` | `["claude"]` | the agent; its first message is the last argument |
| `agent.task`, `agent.extraBranchTask` | see example | first messages; `{key}`, `{summary}`, `{branch}`, `{viewCommand}` |
| `agent.steps` | the Claude commands | what each sidebar step sends |
| `workflow.autoMerge` | `"when-reviews-required"` | or `"never"` |
| `workflow.readyWhen` | `"green"` | when Ready is offered: CI green and nothing unresolved; `"agent"`: also once the agent says the PR is done (`hc label "$HC_TERMINAL_ID" pr=ready`) |
| `workflow.confirmFinish` | `true` | Finish and Clean up need a second click |

Repo suggestions for a ticket, best first: the repo you last used for it,
`repoRules` matching its component or label, the tracker's own (a GitHub issue's
repo), `repoRules` matching its project (only if no component/label rule
matched), and the repo you're in. With exactly one clear choice, Enter starts
right away; otherwise you pick (or pick any repo, cloning it if needed).

## The demo

`demo/herdr-demo` runs a separate Herdr window (its own app home and
herdr-core session, so your spaces and settings are untouched) over fake
repos, Jira or GitHub issues, PRs, CI and an agent that acts on the step
commands in fast-forward:

```sh
demo/herdr-demo                    # Jira; --tracker github for GitHub issues
demo/herdr-demo comment WEB-105    # play a reviewer: comment, request-changes,
demo/herdr-demo approve WEB-105    #   approve; fail-ci; status
demo/herdr-demo --stop             # --reset to start over
```

## Development

```sh
npm run build   # src/ -> mods/ (commit the result)
npm test        # node --test against throwaway demos
npm run e2e     # the real Herdr with the mods, on throwaway demos
```

`npm run e2e` launches Herdr on the demo, once per tracker, on its own Xvfb
display (with its own app home and herdr-core session, so your Herdr is
untouched), and drives it with the keyboard: the mods load without errors, a
fresh ticket starts from the tickets popup, and its whole flow runs from the
Work sidebar's keys through to Finish, opening the row's PR and ticket on the
way (with a stub `xdg-open` that records the URL; with CI failing once and Finish
refusing uncommitted changes, on Jira). It checks outcomes, not pixels:
`herdr-app status`, `work.report`, git, `hc read` and the demo's state. It
needs herdr-app, hc, Xvfb, xdotool, jq and git (Linux), takes under a minute,
and cleans up after itself; a failed step leaves a screenshot, the app log and
the state in `e2e-results/`. `nix develop .#e2e -c npm run e2e` brings all of
that, with Herdr from the nixpkgs pinned in `flake.lock`.

CI runs the end-to-end tests that way, on pull requests and pushes to main,
against **herdr-desktop 0.1.10 and herdr-core 0.1.15** (update `flake.lock` to
move on), and weekly against the newest Herdr in nixos-unstable. A failed run
uploads `e2e-results/` as an artifact.

`src/` holds the shared modules (`config.js`, `lib.js`, `data.js`, `flow.js`,
`tracker*.js`) and each mod's own `main.js` and `mod.json`. Herdr only resolves
imports inside a mod's folder, so the build copies the shared modules into each
`mods/<name>/`. CI checks that `mods/` is up to date, runs ShellCheck and the
tests. `herdr-app check mods/<name>` (with Herdr running) loads a mod once.

A new tracker is a `src/tracker-<name>.js` with the functions listed in
`src/tracker.js`, added to its `trackers` map.
