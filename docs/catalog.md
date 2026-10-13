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

The defaults accept a JSON object through MCP/Pi, `--input-file`, or a JSON
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
executable/argv arrays with no implicit shell. They run in `workspace` in the
given order, every one of them even after a failure, so that one repair round
sees each failing gate; each has a default 60-second timeout (maximum 10 minutes
per check) and a 1 MiB output buffer. Timeouts, missing executables, and excessive output are
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
receipt at `.machine-runs/machine-shop/<id>/result.json`. The output includes
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
wait for a person: stuck work stops in a Human state rather than ending.

```json
{
  "ticket": { "id": "PROJ-12", "title": "Add the empty state", "body": "## Goal\nShow an empty state.\n## Scope\n- src/widgets/**\n## Acceptance\n- An empty list shows No widgets.\n## Forbidden\n- nothing beyond the scope above" },
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

The input is an object or JSON string, validated at construction with no
filesystem or subprocess effects; ticket body sections are checked by the first
Operation, `shape`. Unknown fields are rejected at every level
except inside `ticket`, where tracker fields such as `source` or `metadata` are
ignored. `ticket.id` and `ticket.title` are required. `ticket.body` must contain
four level-two Markdown headings, case-insensitively and in any order:

```markdown
## Goal
Describe the goal.
## Scope
- path/or/glob
## Acceptance
- Testable criterion
## Forbidden
- nothing beyond the scope above
```

Goal is free text. Scope lists allowed paths or globs, Acceptance lists testable
criteria, and Forbidden lists things the change must not do. Each list needs at
least one non-empty bullet. Indented continuation lines and nested bullets join
their parent bullet with single spaces; nested bullets do not add criteria.
Thematic breaks are not bullets. Subheadings (`###` and deeper) remain text of
the current section and do not introduce required sections or count as bullets.
The optional first `# ` heading is the ticket title
when Dispatch reads a `.tickets/<id>.md` file. The exported pure
`ticketSections(body)` returns `{ goal, scope, acceptance, forbidden, missing }`;
`missing` names absent sections and empty required lists. `shape` opens evidence
and blocks an invalid body before any Agent or worktree, naming the missing
sections and showing the template. It applies to resumed runs too; the result
has `worktreeCreated: false` and a hold summary starting `Blocked: `.

`repository.name` is one path segment and `repository.path` is the absolute
checkout root. `base` is a branch or ref and defaults to the checkout's current
HEAD commit. `setup` is optional and `checks` needs 1–20 entries; both use the
check shape and limits under [Common input](#common-input). `output` is `pr`,
`branch`, or `patch`. `remote` (default `origin`) and `draft` (default `true`)
matter only for `pr`. `worktreeRoot` and `evidenceRoot` are absolute and must be
outside `repository.path`, and `evidenceRoot` must also be outside the worktree,
so run files never appear in the source checkout or the commit. `maxRepairs`
(0-3, default 3) and the boolean `resume` (default `false`) are optional.

The id slug is the lowercased ticket id with every character outside
`[a-z0-9._-]` replaced by `-`; an id that leaves no letter or digit, or a name
Git cannot use, is rejected. The title slug is the ticket title lowercased, with
every run of characters outside `[a-z0-9]` replaced by one `-`, without a leading
or trailing `-`, and cut to at most 48 characters at a `-`: a cut that would fall
inside a word goes back to the `-` before it, and a first word longer than 48
characters has no such `-` and leaves nothing. The branch is
`ticket/<id-slug>-<title-slug>`, for example
`ticket/org-1-gate-github-issue-intake-on-a-trusted-author`, or `ticket/<id-slug>`
when the title leaves no title slug. The worktree is
`<worktreeRoot>/<repository.name>--<id-slug>`, without the title.

A local branch is named for a ticket when its name is exactly `ticket/<id-slug>`
or starts with `ticket/<id-slug>-`: after the id slug comes either the end of the
name or the `-` that starts a title slug. A `ticket/org-10-...` branch is
therefore not named for `org-1`, nor is `ticket/org-1.5-...` or `ticket/org-1x`.
A name cannot tell a title from the rest of a longer id, though: with ids `org`
and `org-1`, `ticket/org-1-fix` is named for both, as `org` titled "1 fix" and as
`org-1` titled "fix". So when `prepare` creates a branch it records the id slug
with it, in the repository's own Git configuration as `branch.<branch>.ticket`,
which Git carries through a branch rename and removes with the branch.

A branch belongs to a ticket when it is named for it and was made for it. A run
reads what a branch was made for from the first of these that says:

1. The record: a branch recorded for `org-1` never belongs to `org`, whatever
   its name.
2. The ticket commit at its tip: this workflow's commit has the ticket title as
   subject and a `Ticket: <id>` line, and it counts only when that id and title
   give exactly the branch's name, as `ticket/<id-slug>` or
   `ticket/<id-slug>-<title-slug>`. That tells a delivered branch made before
   branches carried a record, or fetched into a clone the record did not reach.
   A branch cut from a base that happens to end in another ticket's commit is
   not taken for that ticket's, because its name differs.
3. The name being exactly the running ticket's `ticket/<id-slug>`: every branch
   was named so before branches carried a title. This settles the branch for
   that ticket only. For a ticket with a shorter id, such as `org` looking at
   `ticket/org-1`, the same name may be its own under the title "1".

A branch named for the ticket that none of these settles has unresolved
ownership: an unrecorded `ticket/org-1-fix` without a ticket commit may be the
branch of `org-1` under an earlier title, or of `org` titled "1 fix". The
workflow does not guess. It treats such a branch as possibly the ticket's, so it
neither starts a run beside it nor resumes on it, and the message asks for the
record: `git config branch.<branch>.ticket <id-slug>`, with the id slug of the
ticket the branch is for. Recorded for another ticket, the branch no longer
concerns this one.

`prepare` blocks, changing nothing and naming the branch found, in three cases:

- A branch that belongs to the ticket exists, whichever naming or title produced
  it, so a retitled ticket cannot start a second branch.
- A branch named for the ticket has unresolved ownership. This is how an
  unrecorded branch under an earlier title still blocks, and it also holds a
  ticket back while an unrecorded branch of a longer id, such as an undelivered
  `ticket/org-1` seen from ticket `org`, has not been recorded.
- The name this run would take belongs to another ticket whose id and title
  spell the same name; that branch is left alone.

Two tickets whose ids differ by a `-` extension therefore never share a branch:
their recorded and delivered branches do not block each other, and no run
starts beside or resumes on an unresolved one until its record says whose it
is.

| State | Work |
| --- | --- |
| `shape` | Validate the checkout and root paths; open evidence and block missing ticket sections or empty required lists before any Agent or worktree |
| `prepare` | Resolve the base commit; for `pr`, check with the remote that the base is already published; `git worktree add -b` the branch, record the id slug with it, and run `setup` in the worktree; with `resume`, adopt the existing worktree and its branch instead and go straight to `verify` |
| `start` | Open the helper's run on the worktree, which must be clean |
| `triage` | The investigator returns `ready` with a short plan or `blocked` with what is missing; an unchanged-worktree guard follows |
| `change` | The implementer edits the worktree and leaves the changes uncommitted |
| `verify` | The required checks; a failure goes to the repair budget |
| `review`, `reviewResult` | Capture the structured report; the Operation preserves the unchanged-checkout guard and judges criteria, finding severity, and progress to approve, revise, or ask for a decision |
| `commit` | One commit of everything except `.machine-runs`, even if an Agent staged it: subject is the ticket title, body is `Ticket: <id>` |
| `deliver` | `branch`: nothing more. `patch`: `git format-patch` for base..HEAD into the evidence directory. `pr`: `git push --no-follow-tags <remote URL>` of the approved commit to the ticket branch alone, then `gh pr create --repo <host/owner/repository>` |
| `decide` | Human: stuck work waits for one of `more rounds`, `hand off`, `archive`, or `discard` |
| `confirmDiscard` | Human: `confirm discard` or `go back`, asked before a discard removes anything |
| `archive`, `remove` | Commit the candidate and keep that commit as the branch `archive/<slug>`; `git worktree remove --force` and `git branch -D` for this run's own worktree and ticket branch |

The implementer receives the parsed acceptance and forbidden lists. The reviewer
receives numbered acceptance criteria and must end with this structured event:

```text
MACHINES_EVENT {"type":"approved"|"revise"|"blocked","summary":"<one paragraph>","criteria":[{"text":"<criterion as given>","met":true|false,"evidence":"<file:line or command>"}],"findings":[{"severity":"blocker"|"discussion"|"minor","text":"<finding>","where":"<file:line>"}],"newSinceLastRound":"none"|"<what changed in this round's findings>"}
```

There must be one criterion entry per acceptance bullet, in order. `blocker`
means a change required before delivery; `discussion` is a question only the
ticket owner can settle; `minor` is worth noting but not worth another round.
On later reviews the reviewer reads previous `review-<n>.json` reports in the
evidence directory and describes what is new.

`reviewResult` judges the report, preserving the read-only guard:

1. For `approved` and `revise`, missing or wrongly typed fields, invalid entries, or a criteria count that
   differs from the acceptance list block with the field named and go to
   `decide`. Entries are matched to criteria by position, so a reworded
   criterion is not malformed. Feedback uses the ticket's criterion text at that
   position, not the reviewer's wording.
2. A reviewer `blocked` event goes to `decide` with its summary; it does not
   require `criteria`, `findings`, or `newSinceLastRound`.
3. Any unmet criterion or blocker requires repair, regardless of the event's
   approval verdict. Feedback lists each unmet criterion, blocker, and discussion
   with its evidence or location.
4. Before retrying an unresolved criterion or blocker on a later review,
   `newSinceLastRound: "none"` with the same set of blocker texts blocks as
   not converging and goes to `decide`, naming the unchanged blockers. Empty or
   whitespace-only text also means none, as does `none` after trimming,
   lower-casing, and dropping a trailing period. With no blockers, the reason
   names the unmet ticket criteria instead.
5. A discussion gets one repair round to resolve it or explain why it needs
   the owner. Repeating the question in the next review, compared after trimming
   and lower-casing, blocks with the question quoted for `decide` only when
   no criteria or blockers need repair. A question absent from the immediately
   preceding review gets a fresh repair round if it returns.
6. All criteria met with no blockers or discussions approves, including a
   reviewer `revise` event containing only minors. Minor notes accumulate across
   review rounds, deduplicated by text and location after trimming and
   lower-casing. The pull request renders each note on one line and omits
   parentheses when its location is empty.

After a Machine block for non-convergence, repeated discussion, or a malformed
report, `more rounds` restores the latest review's available findings as the
implementer's feedback, including their locations, rather than the stop reason.

Operations do all Git, command, and publishing work. Machine-judged `revise` and failed checks
return to `change` within `maxRepairs`, and every retry passes through the real
checks and the review again. The commit happens only for an approved candidate
that still matches its passing checks. Commit hooks run, and the result is then
compared with that candidate: the commit must have the approved tree, the base
as its only parent, the ticket's subject and exact `Ticket:` line, and a clean
worktree, and the ticket branch must still point at it. The push sends that
commit to the ticket branch only and ignores `push.followTags`, so no tag is
published. The push goes to the remote's configured URL, not its name, and the
pull request is opened in the repository that URL names, regardless of `GH_REPO`,
a separate `pushurl`, or other remotes (Git `insteadOf` aliases still apply). In
`pr` mode that URL is read once, in `prepare`, for the published-base check
below, and the push and `gh` use the value read then: a remote that is given
another URL while the run is under way, as an Agent can do, receives neither.
A URL that does not name a hosted owner/repository blocks before anything is pushed. `--draft` is passed unless `draft` is
false, and `--base` always: the branch `repository.base` names, a local branch
or the branch behind `<remote>/<branch>`, or else the remote's default branch
by name, as the remote reported it. That branch is also decided once, in
`prepare`, and `gh` gets the base that was compared with the remote there.
`gh` is never left to choose one, since it would read
`branch.<name>.gh-merge-base` from Git configuration before the default branch;
neither that setting nor deleting or adding a local ref during the run can turn
the pull request toward a branch that was never checked. Push and `gh` each
have a two-minute timeout.

The Operation writes the pull request body, in this order: the ticket title on
the first line; `## Summary` with the first paragraph of the ticket body below
its leading headings, ended by a blank line or the next heading, a section left
out when the body has no such text;
`## Checks` with one `- <name>: passed` line per required check; `## Review`
with the approving review's summary; `## Review notes` listing accumulated minor
findings and their locations, omitted when none exist; and `Ticket: <id>` as the last line. The commit
message is separate and unchanged. A reviewer whose report arrives as a JSON
object, as a capturing runner can return it, contributes that object's
non-empty string `summary`: the shared helper unwraps it for every workflow, so
the stage report, the blocking reason, and the next prompt carry prose too,
while a summary that is not such an object is kept exactly as written. A review
that is still a JSON object after that is never written to the body; a fixed
sentence stands in for it and the report stays in the run evidence.

A push carries every commit the remote lacks, so a base that is ahead of the
remote would put commits nobody asked to publish into the pull request. For
`output: "pr"` only, `prepare` therefore asks the remote itself, with
`git ls-remote` on the URL the push will use, for the pull request's base
branch: the branch `repository.base` names, or the remote's default branch
(`ls-remote --symref` gives its name) when the base is a commit, a tag, or
left out. Local remote-tracking refs are not trusted, since they
only record the last fetch. The resolved base commit must be that remote commit
or an ancestor of it. When the remote's tip is not in the local repository, it
is fetched by URL with `--no-tags --no-write-fetch-head`, which stores the
commits and moves no local ref. The run ends `blocked` before any worktree,
branch, or Agent when the base has commits the remote branch lacks (the message
gives their number and says the base must be pushed first), when the base
branch does not exist on the remote, when the base names no branch and the
remote does not say which branch is its default, or when the remote cannot be
reached or its tip fetched (the Git output is saved as a log). The check, like the push,
has a two-minute timeout and also runs for a resumed `pr` run. `branch` and
`patch` runs make no network call.

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
| `archive` | What delivery would have committed, tracked and untracked files without ignored files or `.machine-runs`, is committed and kept as the branch `archive/<slug>`; then the worktree is removed and the ticket branch deleted | `abandoned` |
| `discard` | After confirmation, the worktree is removed and the branch deleted without saving the candidate | `abandoned` |

`archive` saves exactly what delivery would have committed, as a commit Git
already knows how to store. `<slug>` is whatever follows `ticket/` in this run's
branch name, so `ticket/proj-12-add-a-greeting` is archived as
`archive/proj-12-add-a-greeting`. If that branch already exists the run ends
`blocked` before anything is staged. Otherwise the candidate is staged as
`commit` stages it, `git add --all` and then `.machine-runs` unstaged, and
committed in the worktree with `--no-verify`, subject `Archive: <ticket title>`
and body `Ticket: <id>`, so a commit hook that refuses the commit does not
prevent the archive. The archive branch is created at that commit, on top of
the base commit and of anything an Agent committed on the ticket branch itself;
when nothing is left to stage above such a commit, the archive branch points at
it. Only then is the worktree removed and the ticket branch deleted. The
workflow never deletes an archive branch, and never pushes one.

Ignored files are not archived, exactly as they are not delivered: removing the
worktree deletes them, so copy out an ignored file you want before choosing
`archive`. The same holds for anything else `git add --all` does not record as
it is on disk: a file the index marks assume-unchanged or skip-worktree keeps
its committed content, a nested Git repository is recorded by its commit id
without its files, and line-ending conversion and clean filters apply as in any
commit. Nothing is removed, and the run ends `blocked`, when the candidate does
not differ from its base commit, so that there is nothing to archive and
`discard` is the choice that removes it; when the candidate cannot be staged or
committed or the branch cannot be created; when `HEAD` is not a commit of the
staged tree on top of what `HEAD` was before, as after a `post-commit` hook
that resets or amends it, which `--no-verify` does not skip; when the commit's
subject is not `Archive: <ticket title>` or its body has no `Ticket: <id>`
line, as after a `prepare-commit-msg` hook that rewrites them, which
`--no-verify` does not skip either, though a hook may add lines of its own; or
when the worktree is not clean after the archive commit, ignoring
`.machine-runs`. In the last three cases no archive branch is made: the archive
commit is on the ticket branch, or in the worktree's reflog if a hook moved
`HEAD` off it.
`discard` first enters a second Human state,
`confirmDiscard`, whose prompt names the worktree and branch that will be
deleted and says that the candidate will not be saved. Its restricted choices
are `confirm discard` and `go back`; `go back` returns to `decide` with nothing
changed, and no other path removes a candidate without an archive. Removal runs
`git worktree remove --force` and `git branch -D` from `repository.path`, only
on this run's own worktree and ticket branch; if either fails the run ends
`blocked` with the saved log. The workflow builds these steps from the public
Human primitive with restricted choices. How they are presented, and how long a
run may wait, belongs to whichever surface runs the Machine.

With `"resume": true`, `prepare` adopts the existing worktree instead of
creating one, for the candidate a `hand off` left. It requires all of: the
worktree directory exists and is a Git worktree of `repository.path`; its `HEAD`
is a symbolic ref to a branch that belongs to this ticket by the rule above; and
that branch points at the resolved base commit or at an ancestor of it, so
nothing was committed on it. The base branch may therefore have moved forward
while the ticket was stuck: the commit the ticket branch points at is this
run's base commit for the commit guard, the delivered commit's parent, the
patch range, `delivery.json`, and, in `pr` mode, the check that the base is
published. Nothing is rebased, so the delivered branch starts from that older
commit. A branch that holds commits the base does not, or that shares no
history with it, is not adopted. The run continues on the branch the worktree
is on and does not compute a name from the current title, so a candidate
started under an earlier title, or
as `ticket/<id-slug>` before branches carried one, is delivered on that branch.
A worktree on a branch whose ownership is unresolved, or that belongs to another
ticket, is not adopted; for the first the message gives the `git config` command
that records it. If any of these fails
the run ends `blocked` with a message naming the condition, changing nothing.
Setup commands are not run again and triage is skipped: a resumed run goes
straight to `verify`, then review, commit, and deliver as usual, with a fresh
repair budget and the normal repair loop if review asks for changes. The base
must resolve to the commit the first run started from or to a descendant of it,
so name `repository.base` explicitly, or leave the source checkout on the branch
it was on. Without `resume`,
an existing branch or worktree directory still blocks.

A run ends `blocked` without asking, changing nothing further, when: required
ticket sections or list entries are missing; the base
does not resolve; in `pr` mode the base is not published or the remote cannot be
asked; a branch of the ticket or the worktree directory already exists; a resume
precondition fails; a setup command fails or leaves tracked or unignored files
behind; there is nothing to commit; an Agent committed or moved HEAD or the
branch itself; a commit hook rejects the commit or changes its content or
message; the commit, patch, push, or `gh` step fails; the worktree cannot be
removed after delivery; or, after a decision, the candidate cannot be archived
or the worktree or branch cannot be removed. A failed Git or `gh` step
saves its output as a log in the evidence directory.

Final states are `delivered`, `handedOff`, `abandoned`, and `blocked`. In every
case the Machine output is exactly `{ "action": "hold", "summary": "<text>" }`
with no other field, the strict shape Machines Dispatch accepts for a ticket
that must stay open until a person merges or closes it. The workflow never
relaunches itself, launches another Machine, or edits or closes a ticket file.
The one-line summary names the branch, commit, and pull request URL or patch
path on success, or the reason otherwise; then the decision if one was made, the
archive branch and its commit after `archive`, the worktree if it was kept
(always for `handedOff`, and for `blocked` once it exists), and the evidence
directory. Read
the final state, not the action, to tell the endings apart. `delivered` means
the worktree was removed and the branch kept; `handedOff` and `blocked` keep the
worktree and branch for inspection or further work; `abandoned` means both are
gone, with the candidate on its archive branch after `archive`. A worktree that
cannot be removed, for example because it holds unignored nested `.machine-runs`
evidence, ends `blocked` with a reason naming the branch, commit, and pull
request or patch already produced. Invalid input, a `repository.path` that is
not a checkout root, a worktree or evidence root that resolves into the
repository through a symlink, and unexpected exceptions are runtime failures.

Evidence is written to `<evidenceRoot>/.machine-runs/machine-shop/<id>/`, outside
the repository and the commit: the helper's `started.json`, check and setup
logs, Agent summaries, full structured reviews as `review-<n>.json`, each Human
answer as `human-<n>.json`, and `result.json`,
plus `delivery.json` with the ticket id, repository name and path, branch, base
commit, commit hash, output mode, pull request URL or patch paths, worktree
path, whether the worktree was removed, and `reviewNotes: [{text, where}]` in
every output mode (an empty list when there are no minors). Its `outcome` is `delivered`,
`handed-off`, `abandoned`, or `blocked`. It records `decision` when one was made
(the last choice at `decide`, so `discard` for a confirmed discard and
`more rounds` for a run that went on to deliver), `archive` as
`{ "branch", "commit" }` when the archive branch was created, and `resumed` for
a resumed run, whose `worktreeCreated` is false and whose `baseCommit` is the
commit its branch was on.
`result.json` keeps the helper's vocabulary: its `outcome` is `blocked` for
`handedOff` and `abandoned`, its `repairs` counts every round across budgets,
and its `decisions` list every Human answer.

Limits: a run waiting in a Human state keeps its worktree and branch until it is
answered. `resume` adopts only an uncommitted candidate on the ticket's own
worktree and branch; it does not restore an archive branch, continue a branch
that already holds a commit, or rebase a candidate onto a base that moved.
Without `resume`, a second run of the same ticket is blocked while any branch
of that ticket exists; resume it, or delete
the branch and any kept worktree to retry from scratch.
Two ids that differ only in case or punctuation share an id slug. The ticket
record is local Git configuration: it does not travel with a push or a clone,
so a ticket branch checked out in another clone has no record there. One that
holds its ticket commit is still told by that commit; one without it, unless it
is named exactly `ticket/<id-slug>`, has unresolved ownership, which blocks a new
run of the ticket and cannot be resumed until it is recorded. The
published-base check reads the remote once, in `prepare`; it does not see a base
branch that moves on the remote while the run is under way. A `gh` failure
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
