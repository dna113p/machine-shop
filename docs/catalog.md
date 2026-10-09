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
the default repair budget allows at most 5 Agent calls, and `maxRepairs: 0` uses 3.

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
  "maxRepairs": 1
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
so run files never appear in the source checkout or the commit.

The slug is the lowercased ticket id with every character outside `[a-z0-9._-]`
replaced by `-`; an id that leaves no letter or digit, or a name Git cannot use,
is rejected. The branch is `ticket/<slug>` and the worktree is
`<worktreeRoot>/<repository.name>--<slug>`.

| State | Work |
| --- | --- |
| `prepare` | Resolve the base commit, `git worktree add -b` the branch, and run `setup` in the worktree |
| `start` | Open the helper's run on the worktree, which must be clean |
| `triage` | The investigator returns `ready` with a short plan or `blocked` with what is missing; an unchanged-worktree guard follows |
| `change` | The implementer edits the worktree and leaves the changes uncommitted |
| `verify` | The required checks; a failure goes to the repair budget |
| `review` | The reviewer returns `approved`, `revise`, or `blocked`, sealed by the unchanged-checkout guard |
| `commit` | One commit of everything except `.machine-runs`, even if an Agent staged it: subject is the ticket title, body is `Ticket: <id>` |
| `deliver` | `branch`: nothing more. `patch`: `git format-patch` for base..HEAD into the evidence directory. `pr`: `git push --no-follow-tags <remote URL>` of the approved commit to `refs/heads/ticket/<slug>` alone, then `gh pr create --repo <host/owner/repository>` |

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

A run ends `blocked`, changing nothing further, when: the base does not resolve;
the branch or worktree directory already exists; a setup command fails or
leaves tracked or unignored files behind; triage or the implementer reports a
blocker; a read-only stage edits the worktree; the repair budget is exhausted;
there is nothing to commit; an Agent committed or moved HEAD or the branch
itself; a commit hook rejects the commit or changes its content or message; the
commit, patch, push, or `gh` step fails; or the worktree cannot be removed after
delivery. A failed Git or `gh` step saves its output as a log in the evidence
directory.

Final states are `delivered` and `blocked`. Either way the Machine output is
exactly `{ "action": "hold", "summary": "<text>" }` with no other field, the
strict shape Machines Dispatch accepts for a ticket that must stay open until a
person merges. The one-line summary names the branch, commit, and pull request
URL or patch path on success, or the reason when blocked, then the worktree if
it was kept and the evidence directory. Read the final state, not the action, to
tell success from a blocker. `delivered` means the worktree was removed and the
branch kept; `blocked` keeps a created worktree for inspection. A worktree that
cannot be removed, for example because it holds unignored nested `.machine-runs`
evidence, ends `blocked` with a reason naming the branch, commit, and pull
request or patch already produced. Invalid input, a `repository.path` that is
not a checkout root, a worktree or evidence root that resolves into the
repository through a symlink, and unexpected exceptions are runtime failures.

Evidence is written to `<evidenceRoot>/.machine-runs/dev-machines/<id>/`, outside
the repository and the commit: the helper's `started.json`, check and setup
logs, Agent reports, and `result.json`, plus `delivery.json` with the ticket id,
repository name and path, branch, base commit, commit hash, output mode, pull
request URL or patch paths, worktree path, and whether the worktree was removed.

Limits: there is no resume. A second run of the same ticket is blocked while its
`ticket/<slug>` branch exists; delete the branch and any kept worktree to retry.
Two ids that differ only in case or punctuation share a slug. A `gh` failure
after a successful push leaves the pushed branch on the remote. A commit that a
hook altered stays on the local branch, undelivered. Like the defaults, this is not a sandbox: Agents and commands run with the
harness's and user's permissions, and `pr` mode publishes the change, so accept
tickets and repository settings only from a trusted source.

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
remote and a recording `gh` stand-in; no network or real `gh` is used. These tests
do not prove that a live model follows the instructions or solves a software task.
