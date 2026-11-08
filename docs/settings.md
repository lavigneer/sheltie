# Settings

`<Herdr app home>/sheltie.json` is merged over the defaults, so set only what
you change. Changes apply when a mod next loads (reopen the popup; the sidebar
reloads with the layout). [`config.example.json`](../config.example.json)
shows every setting with its default, and `src/config.js` documents each one.
[`sheltie.schema.json`](../sheltie.schema.json) is a JSON schema for both
`sheltie.json` and `.sheltie.json`: point `"$schema"` at
`https://raw.githubusercontent.com/lavigneer/sheltie/main/sheltie.schema.json`
(as `install.sh`'s starter file does) for completion and checking in your editor.

| Setting | Default | |
|---|---|---|
| `roots`, `depth` | `["~/workspace"]`, `1` | where your repos are: `depth` levels below each root |
| `programs` | `git`, `gh`, `jira`, `hc`, `jq`, `curl`, `sqlite3`, `claude` | found on your login shell's PATH; absolute paths win. Each is needed only by what uses it (`jira` by the Jira tracker, `sqlite3` by opencode's usage, `claude` by the plan limits) |
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
| `agent.adhocTask` | see example | first message for ad-hoc work (no ticket); `{description}`, `{branch}` |
| `agent.steps` | `/draft-pr` etc. (the skills in `skills/`) | what each sidebar step sends; change for agents that invoke skills differently |
| `usage.agents` | Claude Code in `~/.claude`, Codex in `~/.codex`, opencode in `~/.local/share/opencode` | `{type: "claude-code" \| "codex" \| "opencode", home}`: whose session logs the Usage and Work sidebars' costs count |
| `usage.prices` | LiteLLM's model price list | URL of a LiteLLM-format price list (`file://` works) |
| `workflow.autoMerge` | `"when-reviews-required"` | or `"never"` |
| `workflow.readyWhen` | `"green"` | when Ready is offered: CI passed, no conflicts and nothing unresolved; `"agent"`: also once the agent runs `hc label "$HC_TERMINAL_ID" pr=ready` |
| `workflow.mergeWithoutReview` | `true` | offer Merge for a ready, green PR needing no review; `false`: only once approved |
| `workflow.confirmMerge` | `true` | Merge needs a second click |
| `workflow.confirmFinish` | `true` | Finish and Clean up need a second click |

## A repo's own settings

A repo can pick where its tickets come from with a `.sheltie.json` in its main
checkout, merged over `sheltie.json` the same way. Only `tracker`, `jira`,
`github`, `branch` and `workflow` apply there (other settings are reported and
ignored). E.g. in a repo that uses GitHub issues while everything else uses
Jira:

```json
{ "tracker": "github", "github": { "repos": ["acme/storage"] } }
```

or one with its own Jira filter:

```json
{ "jira": { "jql": "project = STOR AND assignee = currentUser() AND resolution = Unresolved" } }
```

The tickets popup lists your tickets from `sheltie.json`'s tracker and from
each repo's own one, and suggests that repo for the tickets its tracker lists.
The repo's branches are matched to tickets, and its work moves tickets, with its
own tracker. Its `branch` names the branches started there, and its
`workflow` decides its Work rows' Ready and Merge steps. Repos with the same settings share one list. A repo's tracker that
can't be reached leaves its tickets out instead of failing the list.

For Jira Server/Data Center, set up jira-cli with
`jira init --installation local --auth-type bearer` and a personal access
token.
