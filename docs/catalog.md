# Software workflow catalog

These are selectable starting points, not a mandatory process for every project.
The project orchestrator chooses and adapts the useful subset, supplies actual
acceptance criteria and commands, and validates the results. Do not run all ten
for one task. Small direct changes can remain direct.

## Defaults

Names below are source names in `defaults/`. Installation adds the `dev-` prefix
so these do not replace project-specific names such as `verify`.

| Machine | State sequence | Required Agent roles | Maximum Agent calls, default repair budget |
| --- | --- | --- | --- |
| [verify-checks](../defaults/verify-checks.ts) | local checks -> receipt | none | 0 |
| [implement-task](../defaults/implement-task.ts) | implement -> checks -> review; bounded repair -> checks -> review | implementer, reviewer | 4 |
| [fix-bug](../defaults/fix-bug.ts) | regression test -> prove red -> fix -> prove green -> checks -> review; bounded repair | tester, implementer, reviewer | 5 |
| [refactor](../defaults/refactor.ts) | green baseline -> behavior-preserving change -> checks -> review; bounded repair | implementer, reviewer | 4 |
| [add-tests](../defaults/add-tests.ts) | green baseline -> focused tests -> checks -> review; bounded repair | tester, reviewer | 4 |
| [review-code](../defaults/review-code.ts) | read-only review -> unchanged-checkout guard -> findings receipt | reviewer | 1 |
| [investigate](../defaults/investigate.ts) | investigate -> unchanged guard -> challenge evidence; bounded research revision | investigator, reviewer | 4 |
| [update-docs](../defaults/update-docs.ts) | docs/examples change -> explicit validation -> source-consistency review; bounded repair | writer, reviewer | 4 |
| [upgrade-dependency](../defaults/upgrade-dependency.ts) | green baseline -> compatibility proposal -> Human approval -> upgrade -> checks -> review; bounded repair | analyst, implementer, reviewer | 5 |
| [prepare-release](../defaults/prepare-release.ts) | checks -> readiness assessment/release-note draft -> Human sign-off -> receipt | reviewer | 1 |

With no repairs, most editing tasks use two Agent calls, bugfix and dependency
upgrade use three, and investigation uses two. `maxRepairs` defaults to 1 and can
be 0–3. Each retry returns through the real checks and review, rather than accepting
an Agent's claim. These are invocation ceilings, not token/dollar limits. A harness
can make multiple model/tool calls inside one invocation; its own limits still apply.
Use `maxRepairs: 0` for the cheapest one-pass behavior. Model selection is never
hardcoded; resolve the role bindings from the target project's `machine agents`.

`investigate` covers diagnosis, codebase/architecture questions, technical research,
and tradeoff analysis. `review-code` can cover a change, an API, or a focused
security concern; it is not a security certification. For UI, performance, database,
or domain-specific work, adapt the selected workflow with real project checks.
Production migrations and publishing are deliberately not generic defaults.

## Common input

The new defaults accept a JSON object through MCP/Pi, `--input-file`, or a JSON
string as CLI positional input. They do not accept an unstructured task string.

```json
{
  "task": "Implement the empty state. Cover loading, empty, and populated results. Do not change the API.",
  "workspace": "/absolute/project",
  "checks": [
    { "name": "types", "command": ["npm", "run", "typecheck"], "timeoutMs": 60000 },
    { "name": "tests", "command": ["npm", "test"], "timeoutMs": 120000 }
  ],
  "maxRepairs": 1
}
```

`task` and absolute `workspace` are required. Give the worker enough context to
act without inheriting the coordinator's conversation: scope, allowed changes,
references, and acceptance criteria. The selected workspace must be the intended
launch project's Git checkout root, not an umbrella with independent submodules.
The explicit workspace is authoritative for all Agent and command execution;
MCP/CLI `cwd` selects discovery/presets and must be set to that same project.

All editing defaults and release preparation require a clean checkout with a
commit before execution. Commit or otherwise preserve setup changes deliberately,
and use an isolated worktree for concurrent edits. These defaults do not create
worktrees or commit their results. Read-only review and investigation allow a
dirty checkout and verify its tracked/nonignored contents stay unchanged.
`verify-checks` also works outside Git and accepts existing directories.

`checks` must contain 1–20 uniquely named checks for editing, verification, and
release workflows. Omit it (or use `[]`) for review/investigation; those workflows
reject nonempty checks rather than silently ignoring them. Check commands are
executable/argv arrays with no implicit shell. They run in `workspace`, stop at
the first failure, have a default 60-second timeout (maximum 10 minutes per check),
and a 1 MiB output buffer. Timeouts, missing executables, and excessive output are
failures, not passes. The direct process is killed on timeout; do not use commands
that detach work or leave daemons/descendants behind.

Choose non-mutating validation commands. Git-based defaults detect a check that
changes tracked or nonignored source and block that verification. Put regenerable
build outputs in the project's ignore rules. Commands are trusted executable work,
not a sandbox or permission boundary; do not put secrets in their arguments.
Language is not fixed: commands can invoke the project's existing Python, Go,
Rust, .NET, frontend, or other toolchain. No project command is guessed for you.

## Bug reproduction

`fix-bug` additionally requires a `regression` command, the expected failing exit
code (1–125), and a literal diagnostic substring. Both must match before repair
is allowed. This prevents an arbitrary test-runner failure or an already-green
command from being accepted as reproduction.

```json
{
  "name": "empty-input-regression",
  "command": ["node", "--test", "tests/empty-input.test.js"],
  "timeoutMs": 60000,
  "failureExitCode": 1,
  "failureIncludes": "empty input returns an empty collection"
}
```

Use this object as the `regression` field of the common input. The initial tester
writes the targeted test before production changes. The same command must later
exit 0, followed by all required checks. The reviewer inspects the red/green logs
and whether the test remained meaningful. Matching a diagnostic is not a proof
that a test is semantically correct; select a precise assertion and inspect it.

## Human decisions and results

Dependency upgrades ask `approve`/`reject` before implementation. A changed checkout
while that proposal waits invalidates the approval path. Release preparation asks
for sign-off only after checks and assessment; candidate changes while waiting
invalidate its passing verification. Approval never triggers a push, publish, tag,
deploy, or production migration. `prepare-release` returns its draft/checklist in
the report rather than editing version files. Native-session conversational
continuity is not added by this library; adapt Human states through the owning
Machine when a richer discussion is needed.

Every normally terminated default returns JSON Machine output and saves a unique
receipt at `.machine-runs/dev-machines/<id>/result.json`. The output includes
`outcome`, `checksPassed`, repairs, invocation count, check exit codes/log paths,
stage summaries, explicit Human decisions, and its own `report` path. Workers
receive the exact evidence directory, so reviews need not guess which run to inspect.
Keep `.machine-runs/` ignored and local; logs can contain private project data.

| Result | Meaning |
| --- | --- |
| final `done`, `outcome: completed` | The workflow's gates passed. For review/investigation, the report is delivered, not a claim of defect-free code or experimental proof. |
| final `blocked`, `outcome: blocked` | A baseline, reproduction, integrity check, Agent blocker, or retry ceiling prevented completion. Inspect `reason` and the retained evidence. |
| final `rejected`, `outcome: rejected` | The Human rejected the proposal/candidate. No approval is inferred. |
| runtime failure | An unexpected exception, malformed Agent event, invalid input, missing binding, or failed verification-only run. Inspect partial effects before retrying. |

A completed runtime run can end in `blocked` or `rejected`: inspect its final state
and JSON outcome, not just the CLI exit code or MCP run status. `verify-checks`
specifically throws after saving failed-check evidence, giving CI a nonzero exit.
A baseline alone leaves `checksPassed: null`; only final verification establishes
it. A later source change invalidates it. Never interpret `checksPassed: true`
as proof that review or Human approval was accepted; also inspect `outcome`.
Unexpected failures can leave `started.json`, Agent summaries, and check logs
without a final receipt. These workflows do not resume, undo, or roll back work.

## Ticket delivery

[ticket-task](../ticket-task.ts) is a separate root workflow, not one of the ten
defaults: it is not in `defaults/`, the installer does not copy it, and it is the
only workflow here built on the shared helper that commits or publishes. It
reuses the helper for evidence, checks, fingerprints, review, and the repair
budget. Required Agent roles are `investigator`, `implementer`, and `reviewer`;
`maxRepairs` defaults to 3 here, not the helper's 1, and still accepts 0-3. The
default allows at most 9 Agent calls before a person is asked, and
`maxRepairs: 0` at most 3; each `more rounds` decision allows one more
implementer pass and review plus `maxRepairs` further repairs. A ticket run can
now wait for a person: stuck work stops in a Human state rather than ending.

```json
{
  "ticket": { "id": "PROJ-12", "title": "Add the empty state", "body": "Scope and acceptance criteria." },
  "repository": {
    "name": "widgets",
    "path": "/absolute/widgets",
    "base": "main",
    "setup": [{ "name": "install", "command": ["npm", "ci"], "timeoutMs": 300000 }],
    "checks": [{ "name": "tests", "command": ["npm", "test"], "timeoutMs": 120000 }],
    "output": "pr",
    "remote": "origin",
    "draft": true
  },
  "worktreeRoot": "/absolute/worktrees",
  "evidenceRoot": "/absolute/project",
  "maxRepairs": 3,
  "resume": false
}
```

The input is an object or JSON string, fully validated at construction with no
filesystem or subprocess effects. Unknown fields are rejected at every level
except inside `ticket`, where tracker fields such as `source` or `metadata` are
ignored. `ticket.id` and `ticket.title` are required; `body` is optional.
`repository.name` is one path segment and `repository.path` is the absolute
checkout root. `base` is a branch or ref and defaults to the checkout's current
HEAD commit. `setup` is optional and `checks` needs 1–20 entries; both use the
check shape and limits under [Common input](#common-input). `output` is `pr`,
`branch`, or `patch`. `remote` (default `origin`) and `draft` (default `true`)
matter only for `pr`. `worktreeRoot` and `evidenceRoot` are absolute and must be
outside `repository.path`, and `evidenceRoot` must also be outside the worktree,
so run files never appear in the source checkout or the commit. `maxRepairs`
(0-3, default 3) and the boolean `resume` (default `false`) are optional.

The slug is the lowercased ticket id with every character outside `[a-z0-9._-]`
replaced by `-`; an id that leaves no letter or digit, or a name Git cannot use,
is rejected. The branch is `ticket/<slug>` and the worktree is
`<worktreeRoot>/<repository.name>--<slug>`.

| State | Work |
| --- | --- |
| `prepare` | Resolve the base commit, `git worktree add -b` the branch, and run `setup` in the worktree; with `resume`, adopt the existing worktree instead and go straight to `verify` |
| `start` | Open the helper's run on the worktree, which must be clean |
| `triage` | The investigator returns `ready` with a short plan or `blocked` with what is missing; an unchanged-worktree guard follows |
| `change` | The implementer edits the worktree and leaves the changes uncommitted |
| `verify` | The required checks; a failure goes to the repair budget |
| `review` | The reviewer returns `approved`, `revise`, or `blocked`, sealed by the unchanged-checkout guard |
| `commit` | One commit of everything except `.machine-runs`, even if an Agent staged it: subject is the ticket title, body is `Ticket: <id>` |
| `deliver` | `branch`: nothing more. `patch`: `git format-patch` for base..HEAD into the evidence directory. `pr`: `git push --no-follow-tags <remote URL>` of the approved commit to `refs/heads/ticket/<slug>` alone, then `gh pr create --repo <host/owner/repository>` |
| `decide` | Human: stuck work waits for one of `more rounds`, `hand off`, `archive`, or `discard` |
| `confirmDiscard` | Human: `confirm discard` or `go back`, asked before a discard removes anything |
| `archive`, `remove` | Write `candidate.patch`; `git worktree remove --force` and `git branch -D` for this run's own worktree and branch |

Operations do all Git, command, and publishing work. `revise` and failed checks
return to `change` within `maxRepairs`, and every retry passes through the real
checks and the review again. The commit happens only for an approved candidate
that still matches its passing checks. Commit hooks run, and the result is then
compared with that candidate: the commit must have the approved tree, the base
as its only parent, the ticket's subject and exact `Ticket:` line, and a clean
worktree, and the ticket branch must still point at it. The push sends that
commit to the ticket branch only and ignores `push.followTags`, so no tag is
published. The push goes to the remote's configured URL, not its name, and the
pull request is opened in the repository that URL names, regardless of `GH_REPO`,
a separate `pushurl`, or other remotes (Git `insteadOf` aliases still apply); a remote whose URL
does not name a hosted owner/repository blocks before anything is pushed. `--draft` is passed unless `draft` is
false, and `--base` only when `repository.base` names a branch. The Operation
writes the pull request body from the ticket id and title, the check results,
and the reviewer's summary. Push and `gh` each have a two-minute timeout.

Stuck work goes to the Human state `decide` instead of ending. That covers
triage returning `blocked`, triage having edited files, the implementer returning
`blocked`, the reviewer returning `blocked` or having edited files, and the
repair budget being exhausted after failed checks or after `revise`. The prompt
states the ticket id and title, the reason a blocked run would report, the
repair rounds used, the worktree path, the branch, and the evidence directory.
It offers exactly these restricted choices:

| Choice | Effect | Final state |
| --- | --- | --- |
| `more rounds` | The used repair count returns to zero and the run goes back to `change`; the implementer is briefed with the standing findings as in any repair. It can be chosen again every time the budget runs out | continues |
| `hand off` | Nothing is touched: the worktree and the branch stay, uncommitted, for another workflow or a person to work in | `handedOff` |
| `archive` | The whole candidate, including untracked and ignored files and excluding `.machine-runs`, is written as `candidate.patch` in the evidence directory; then the worktree is removed and the branch deleted | `abandoned` |
| `discard` | After confirmation, the worktree is removed and the branch deleted without saving a patch | `abandoned` |

`archive` builds the patch against the base commit in a scratch index, so the
worktree and its index are not modified, and it applies to the base commit with
`git apply`. Before anything is removed it checks out what it is about to save
into a scratch directory beside the evidence and compares that with the
worktree itself, byte for byte, then checks that the patch rebuilds exactly
that from the base commit. Git's line-ending conversion and clean filters change
a file on its way into a commit, and a checkout does not always give the same
bytes back. Where it does, the patch holds the file as Git would commit it;
where it does not, the patch holds the file's own bytes, unconverted and
unfiltered, so a filter that redacts content does not redact it here. If even
those do not check out identically, as with mixed or missing CRLF endings under
`eol=crlf`, or the path is neither a regular file nor a symbolic link, nothing
is removed and the run ends `blocked` naming the paths. A patch carries file
bytes, the executable bit, and link targets; empty directories, other
permissions, and timestamps are not part of a candidate. The comparison needs
room for a second copy of the candidate while it runs.

Unlike the commit, the patch also carries
ignored files, because removing the worktree deletes them; an ignored
dependency or build directory therefore makes it large, and the patch can hold
whatever local secrets such files contain. For the same reason it reads files
the worktree's index marks assume-unchanged or skip-worktree and files outside
a sparse checkout's patterns; a path a sparse checkout left out of the worktree
is not recorded as a deletion. If the patch cannot be written,
nothing is removed and the run ends `blocked`. That includes a candidate that
does not differ from the base commit, since `git apply` rejects an empty patch,
and a candidate holding a nested Git repository, whose files a patch cannot
carry. `discard` first enters a second Human state,
`confirmDiscard`, whose prompt names the worktree and branch that will be
deleted and says that the candidate will not be saved. Its restricted choices
are `confirm discard` and `go back`; `go back` returns to `decide` with nothing
changed, and no other path removes a candidate without a patch. Removal runs
`git worktree remove --force` and `git branch -D` from `repository.path`, only
on this run's own worktree and branch; if either fails the run ends `blocked`
with the saved log. The workflow builds these steps from the public Human
primitive with restricted choices. How they are presented, and how long a run
may wait, belongs to whichever surface runs the Machine.

With `"resume": true`, `prepare` adopts the existing worktree instead of
creating one, for the candidate a `hand off` left. It requires all of: the
worktree directory exists and is a Git worktree of `repository.path`; its `HEAD`
is the symbolic ref `refs/heads/ticket/<slug>`; and that branch still points at
the resolved base commit, so nothing was committed on it. If any of these fails
the run ends `blocked` with a message naming the condition, changing nothing.
Setup commands are not run again and triage is skipped: a resumed run goes
straight to `verify`, then review, commit, and deliver as usual, with a fresh
repair budget and the normal repair loop if review asks for changes. The base
must resolve to the same commit as in the first run, so name `repository.base`
explicitly, or leave the source checkout's HEAD where it was. Without `resume`,
an existing branch or worktree directory still blocks.

A run ends `blocked` without asking, changing nothing further, when: the base
does not resolve; the branch or worktree directory already exists; a resume
precondition fails; a setup command fails or leaves tracked or unignored files
behind; there is nothing to commit; an Agent committed or moved HEAD or the
branch itself; a commit hook rejects the commit or changes its content or
message; the commit, patch, push, or `gh` step fails; the worktree cannot be
removed after delivery; or, after a decision, the candidate patch cannot be
written or the worktree or branch cannot be removed. A failed Git or `gh` step
saves its output as a log in the evidence directory.

Final states are `delivered`, `handedOff`, `abandoned`, and `blocked`. In every
case the Machine output is exactly `{ "action": "hold", "summary": "<text>" }`
with no other field, the strict shape Machines Dispatch accepts for a ticket
that must stay open until a person merges or closes it. The workflow never
relaunches itself, launches another Machine, or edits or closes a ticket file.
The one-line summary names the branch, commit, and pull request URL or patch
path on success, or the reason otherwise; then the decision if one was made, the
`candidate.patch` path after `archive`, the worktree if it was kept (always for
`handedOff`, and for `blocked` once it exists), and the evidence directory. Read
the final state, not the action, to tell the endings apart. `delivered` means
the worktree was removed and the branch kept; `handedOff` and `blocked` keep the
worktree and branch for inspection or further work; `abandoned` means both are
gone. A worktree that
cannot be removed, for example because it holds unignored nested `.machine-runs`
evidence, ends `blocked` with a reason naming the branch, commit, and pull
request or patch already produced. Invalid input, a `repository.path` that is
not a checkout root, a worktree or evidence root that resolves into the
repository through a symlink, and unexpected exceptions are runtime failures.

Evidence is written to `<evidenceRoot>/.machine-runs/dev-machines/<id>/`, outside
the repository and the commit: the helper's `started.json`, check and setup
logs, Agent reports, each Human answer as `human-<n>.json`, and `result.json`,
plus `delivery.json` with the ticket id, repository name and path, branch, base
commit, commit hash, output mode, pull request URL or patch paths, worktree
path, and whether the worktree was removed. Its `outcome` is `delivered`,
`handed-off`, `abandoned`, or `blocked`. It records `decision` when one was made
(the last choice at `decide`, so `discard` for a confirmed discard and
`more rounds` for a run that went on to deliver), `patch` when `candidate.patch`
was written, and `resumed` for a resumed run, whose `worktreeCreated` is false.
`result.json` keeps the helper's vocabulary: its `outcome` is `blocked` for
`handedOff` and `abandoned`, its `repairs` counts every round across budgets,
and its `decisions` list every Human answer.

Limits: a run waiting in a Human state keeps its worktree and branch until it is
answered. `resume` adopts only an uncommitted candidate on the ticket's own
worktree and branch; it does not restore an archived patch or continue a
branch that already holds a commit. Without `resume`, a second run of the same
ticket is blocked while its `ticket/<slug>` branch exists; resume it, or delete
the branch and any kept worktree to retry from scratch.
Two ids that differ only in case or punctuation share a slug. A `gh` failure
after a successful push leaves the pushed branch on the remote. A commit that a
hook altered stays on the local branch, undelivered. Like the defaults, this is not a sandbox: Agents and commands run with the
harness's and user's permissions, and `pr` mode publishes the change, so accept
tickets and repository settings only from a trusted source.

## ChatGPT thread

[chatgpt-thread](../chatgpt-thread.ts) is a separate root workflow, not one of
the ten defaults: it is not in `defaults/`, the installer does not copy it, and
it does not use the shared helper, so it runs no checks and writes no
`.machine-runs` receipt. It keeps one ChatGPT web chat going by sending each
Human reply back to the same conversation.

Requirements: the `chatgpt-web` Agent (a built-in runner of the Machines
runtime, declared in `agentRoles`), a running rig-bridge, and a signed-in
automation browser profile. **It types into the user's own ChatGPT account**:
the task and every reply are submitted in a real browser as that user and count
against that account. Replies are sent with `chatGptWebContinue` from
`@dna113p/machines/chatgpt-web`, loaded on the first reply, so that package must
resolve from the definition's location.

The input is a string, and the launch directory is the chat's working directory:

- A `https://chatgpt.com/.../c/<id>` URL, alone and without credentials, adopts
  that conversation. No Agent runs and nothing is sent before the first reply.
- Any other non-empty text is a task for a fresh chat. Empty or non-text input
  is rejected before any state runs.

| State | Work |
| --- | --- |
| `start` | Fresh task only: the `chatgpt-web` Agent starts a chat in the launch directory and returns `completed`, `needs_input`, `blocked`, or `failed`. The event's `conversation` and `handoff.threadId` are kept; an event without a conversation URL fails the run |
| `reply` | Human: shows the latest handoff reason and summary, or that an adopted chat is paired and waiting for a message, and the conversation URL. Suggests `done`; any other text is a reply |
| `send` | Operation: one `chatGptWebContinue` call with the conversation, the reply text unchanged, the launch directory as `cwd`, and the saved rig-bridge thread id when there is one. The returned handoff becomes the latest; then back to `reply` |
| `done` | Final, after `done` (trimmed, any case) |

Every Agent outcome leads to `reply`, including `failed`: the handoff reason is
reported to the person, not acted on. The output is
`{ "conversation", "reason", "summary" }` with the last handoff's reason and
summary, both `null` for an adopted chat that received no handoff.

If a continuation throws, the run returns to `reply` showing the error text and
the unsent or uncertain reply quoted. It is never resent automatically: the
person checks the conversation and decides whether to type it again. An adopted
chat has no saved thread id, so its handoffs are matched by the launch
directory's rig-bridge workspace alone.

Limits: there is no bound on the number of replies, and a run waits in `reply`
until it is answered. Only rig-bridge handoffs are read, never the assistant's
messages. The workflow cannot tell whether the chat finished what was asked;
`reason` and `summary` are the chat's own report.

## Boundaries and validation

Fingerprint guards include HEAD, branch, index, and the contents/modes of tracked
and nonignored files, excluding `.machine-runs/`. They detect persistent changes;
they cannot prevent transient writes, external effects, ignored-file modifications,
or malicious behavior by a harness with broad permissions. Choose a read-only
preset for review/research when supported, and appropriate write permissions for
editing. Separate roles do not inherently mean separate providers/models.

`npm run check` type-checks the new definitions and runs real-runtime tests with
fake Agent runners, real commands, and temporary Git repositories. Tests exercise
all ten success paths, failure and rejection paths, red/green requirements,
repair budgets, stale verification, source-integrity guards, malformed inputs,
command errors, and result retrieval. `npm run smoke:install` covers selective
installation, conflicts, relocation, discovery, and the real CLI. Ticket delivery
is tested the same way for each output mode, with a local bare repository as the
remote and a recording `gh` stand-in; no network or real `gh` is used. The
ChatGPT thread is tested with a fake `chatgpt-web` runner and an injected
continue function; no browser, rig-bridge, or ChatGPT account is used. These tests
do not prove that a live model follows the instructions or solves a software task.
