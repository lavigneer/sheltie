# Sheltie

A herding dog for your [Herdr](https://herdr.dev) desktop app, named for
Hopper, a Sheltie. These mods take a ticket from your tracker to a merged pull
request without leaving Herdr:

1. **Pick a ticket** (Ctrl+Shift+J). Sheltie creates a branch and worktree,
   opens a space there and starts your agent (Claude Code by default) on the
   ticket.
2. **Drive the PR from the Work sidebar.** Each worktree shows its ticket, PR
   status and a button for the next step:
   - **Draft PR**, **Fix CI**, **Address comments**, **Resolve conflicts**:
     sent to the agent (`/draft-pr`, `/fix-ci`, `/address-comments`,
     `/resolve-conflicts`). Conflicts are fixed by merging the base, never by
     rebasing or force-pushing.
   - **Ready**: marks the PR ready and, if reviews are required, turns on
     auto-merge. Offered once CI is green, nothing conflicts and nothing is
     unresolved.
   - **Merge**: once approved (or no review is required) and green.
   - **Finish**: closes the space, removes the worktree and branch, and
     resolves the ticket.
   Click a row to go to its space; its ↗ menu opens the PR or ticket in
   the browser.

   Each repo also has a **hub** row: the main checkout, with its own space for
   longer-running agents.
3. **Get notified** when CI finishes, reviews arrive, the PR starts
   conflicting, or it merges.

See [docs/workflow.md](docs/workflow.md) for exactly when each step is
offered, the safety checks and how repos are suggested.

Trackers: **Jira** (via jira-cli) and **GitHub issues**. Code hosting: GitHub.
A third mod, **projects** (Ctrl+Shift+F), is a plain project switcher, and
**usage**, at the bottom of the sidebar, shows what your agents (Claude Code,
Codex) cost: today, the last 7 and 30 days, and by model, from their session
logs and [LiteLLM's prices](https://github.com/BerriAI/litellm). The Work
sidebar shows each row's cost too, so you can see what each PR cost.

> **What it runs.** The mods run `git`, `gh`, `jira` and `hc` as you, to
> create branches and worktrees, mark PRs ready, merge, clean up and move
> tickets. Auto-merge is only enabled while a review is still required, and
> Finish refuses if the worktree has uncommitted or unpushed work.

## Requirements

- Herdr desktop (tested with herdr-app 0.1.10, herdr-core 0.1.15)
- git, [gh](https://cli.github.com) (logged in), jq
- For Jira: [jira-cli](https://github.com/ankitpokhrel/jira-cli), set up with
  `jira init`
- An agent; the defaults expect [Claude Code](https://claude.com/claude-code)

## Install

Start Herdr once, then:

```sh
git clone https://github.com/lavigneer/sheltie
cd sheltie
./install.sh --skills
herdr-app do layout.switch --name sheltie
```

This copies the mods into Herdr's app home (`$HERDR_APP_HOME`, else
`~/.config/herdr-app`), binds the keys below, adds a `sheltie` layout and a
starter `sheltie.json`. `--skills` also installs the agent skills in
`skills/` (draft-pr, fix-ci, address-comments, resolve-conflicts) into
`~/.agents/skills` and `~/.claude/skills`. Re-run after pulling to update.

With Nix, `packages.default` provides the same files plus `sheltie-install`
and `herdr-demo`.

## Keys

| Key | Command | |
|---|---|---|
| Ctrl+Shift+J | `mod.open:tickets` | pick a ticket |
| Ctrl+Shift+F | `mod.open:projects` | switch project |
| Alt+Shift+Down / Up | `work.next` / `work.prev` | select next / previous row |
| Alt+Shift+Right / Left | `work.step-next` / `work.step-prev` | pick next / previous step |
| Alt+Shift+Enter | `work.step` | run the picked step |
| Alt+Shift+O | `work.open` | open the row's space |
| Alt+Shift+P | `work.open-pr` | open the row's PR |
| Alt+Shift+T | `work.open-ticket` | open the row's ticket |

Rebind them in `<Herdr app home>/keys.json`. They also work from the command
line (`herdr-app do work.step`), as do `work.refresh` and `work.report`
(writes the sidebar state to `<Herdr app home>/work-report.json`). More in
[docs/workflow.md](docs/workflow.md#keyboard).

## Settings

`<Herdr app home>/sheltie.json` is merged over the defaults; set only what you
change. [`config.example.json`](config.example.json) lists every setting with
its default, and [docs/settings.md](docs/settings.md) has the full table and how a repo picks its own tracker (`.sheltie.json`).
The main ones:

| Setting | Default | |
|---|---|---|
| `roots`, `depth` | `["~/workspace"]`, `1` | where your repos are |
| `tracker` | `"jira"` | or `"github"` |
| `jira.jql` | your unresolved tickets | which tickets to list |
| `github.repos` | `[]` (anywhere) | where to look for issues |
| `repoRules` | `[]` | map a component, label or project to a repo |
| `branch` | `"{ref}"` | branch name, e.g. `"me/{ref}"` |
| `agent.argv` | `["claude"]` | the agent command |
| `workflow.readyWhen` | `"green"` | `"agent"`: also wait for `hc label "$HC_TERMINAL_ID" pr=ready` |
| `workflow.mergeWithoutReview` | `true` | `false`: Merge only once approved |

## Demo

`demo/herdr-demo` runs a separate Herdr window over fake repos, tickets, PRs,
CI and agent, leaving your own setup untouched:

```sh
demo/herdr-demo                    # Jira; --tracker github for GitHub issues
demo/herdr-demo approve WEB-105    # also: comment, request-changes, fail-ci, conflict, status
demo/herdr-demo --stop             # --reset to start over
```

## Development

```sh
npm run build      # src/ -> mods/ (commit the result)
npm test           # unit tests against throwaway demos
npm run e2e        # drive real Herdr on the demo (Linux, Xvfb)
npm run e2e:shots  # screenshots in e2e-results/shots/
```

See [docs/development.md](docs/development.md) for the code layout, adding a
tracker, the end-to-end tests and CI.

## License

MIT. See [LICENSE](LICENSE).
