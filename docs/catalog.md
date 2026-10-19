# Software workflow catalog

These are selectable starting points, not a mandatory process for every project.
The project orchestrator chooses and adapts the useful subset, supplies actual
acceptance criteria and commands, and validates the results. Do not run all eleven
for one task. Small direct changes can remain direct.

## Defaults

Each workflow also has [its own page](workflows/README.md) with its input and a
diagram of its states.
Names below are source names in `defaults/`. Installation adds the `dev-` prefix
so these do not replace project-specific names such as `verify`.

| Machine | State sequence | Required Agent roles | Maximum Agent calls, default repair budget |
| --- | --- | --- | --- |
| [verify-checks](../defaults/verify-checks.ts) | local checks -> receipt | none | 0 |
| [implement-task](../defaults/implement-task.ts) | implement -> checks -> review; bounded repair -> checks -> review | implementer, reviewer | 8 |
| [fix-bug](../defaults/fix-bug.ts) | regression test -> prove red -> fix -> prove green -> checks -> review; bounded repair | tester, implementer, reviewer | 10 |
| [refactor](../defaults/refactor.ts) | green baseline -> behavior-preserving change -> checks -> review; bounded repair | implementer, reviewer | 8 |
| [add-tests](../defaults/add-tests.ts) | green baseline -> focused tests -> checks -> review; bounded repair | tester, reviewer | 8 |
| [review-code](../defaults/review-code.ts) | read-only review -> unchanged-checkout guard -> findings receipt | reviewer | 2 |
| [retrospective](../defaults/retrospective.ts) | read evidence -> classify stops -> validate and report; one malformed-report retry | analyst | 2 |
| [investigate](../defaults/investigate.ts) | investigate -> unchanged guard -> challenge evidence; bounded research revision | investigator, reviewer | 8 |
| [update-docs](../defaults/update-docs.ts) | docs/examples change -> explicit validation -> source-consistency review; bounded repair | writer, reviewer | 8 |
| [upgrade-dependency](../defaults/upgrade-dependency.ts) | green baseline -> compatibility proposal -> Human approval -> upgrade -> checks -> review; bounded repair | analyst, implementer, reviewer | 10 |
| [prepare-release](../defaults/prepare-release.ts) | checks -> readiness assessment/release-note draft -> Human sign-off -> receipt | reviewer | 2 |

With no repairs, most editing tasks use two Agent calls, bugfix and dependency
upgrade use three, and investigation uses two. `maxRepairs` defaults to 1 and can
be 0–3. Each retry returns through the real checks and review, rather than accepting
an Agent's claim. The table includes one malformed-report send-back per stage entry. These are invocation ceilings, not token/dollar limits. A harness
can make multiple model/tool calls inside one invocation; its own limits still apply.
Use `maxRepairs: 0` for the cheapest one-pass behavior. Model selection is never
hardcoded; resolve the role bindings from the target project's `machine agents`.

`investigate` covers diagnosis, codebase/architecture questions, technical research,
and tradeoff analysis. `review-code` can cover a change, an API, or a focused
security concern; it is not a security certification. For UI, performance, database,
or domain-specific work, adapt the selected workflow with real project checks.
Production migrations and publishing are deliberately not generic defaults.

## Recovery

Ticket operations use [recovery by step](workflows/ticket-task.md#recovery-by-step),
including bounded Operation retries and questions specific to each failed step.

### Failed checks

After every gate has run, the shared check Operation runs each failed gate
once more by itself. A gate that passes then counts as passed: both attempts
are marked `flaky` in the stage evidence and receipt, with both output logs
kept. A gate that fails again follows the normal failure route; the repair
prompt names both logs. The rerun costs no repair round or extra Agent call.
Passed gates are never rerun in that round.

This handles failures observed under load outside a ticket's changes: a status
line test comparing clock readings, Drip's remote UI test that passed only
after rerunning, and Drip checks failing in steps the ticket did not touch.
The flaky mark preserves evidence of the intermittent failure.

Reruns default to enabled. Set `rerunFailedChecks: false` beside `checks` in
a default's input when a repository requires checks to pass first time.
For ticket-task, set `repository.rerunFailedChecks` to `false` instead.
Ticket pull requests list a recovered gate as
"passed (flaky: failed once, passed when run again alone)".
Setup commands, red checks, and regression checks are unchanged.

### Malformed Agent reports

`sendBack`, exported by [`defaults/_machine-shop/task.ts`](../defaults/_machine-shop/task.ts),
validates an Agent report and returns either its valid value, `sendBack` on the
first fault, or `invalid` on a second fault. About eight ticket runs stopped on
report shape alone: questions that were not an array of 1–10 entries, criteria
that were not an array, or a missing plan summary. The work did not need repair;
the Agent needed to return the expected shape. org-25 and org-28 handled two
cases separately. This helper applies the same recovery to every validated report.

A report goes back once to the same role with the validator's exact fault:
“Your last report was malformed: criteria must be an array. Return it again in the required shape.”
`work.sendBack` also keeps the raw report, stage, fault, and feedback in
`report-fault-<n>.json`. Validators and review rules are unchanged. A second
malformed report follows the existing stop or failure route.

The caller owns the allowance. Keep it across the send-back; reset it when a
new stage entry begins. Ticket falsify deliberately keeps its allowance spent
even after Human `more rounds`. Retrospective keeps its existing single retry
through the repair budget, with the fault in its existing feedback. All other
send-backs spend neither repair nor review budget, nor a plan revision.

A custom Machine can validate in an Operation and choose its own transitions:

```ts
import { taskRun } from "./_machine-shop/task.ts";

const work = taskRun("custom", input, { git: "snapshot" });
const allowance = p.data({ returned: false, feedback: "" });
// In the Operation receiving the review Agent's event:
const result = work.sendBack("review", event, () => {
  work.summary("review", event); // Preserve the normal summary validator.
  if (!Array.isArray(event.criteria)) throw new Error("criteria must be an array");
  return event;
}, allowance);
if (result.type === "sendBack") return { type: "reask" };
if (result.type === "invalid") return work.block(result.fault);
work.capture("review", result.report);
return result.report;
```

Route `reask` straight to that Agent and append `allowance.feedback` to its
prompt. Reset `allowance.returned` and `allowance.feedback` on a fresh stage
entry, never on `reask`. For summary-only reports, the defaults use
`work.receive(event)` then an Operation calling `work.reported(stage)`;
they route `sendBack` back to the same Agent and call
`work.prompt(instruction, stage)` to include its exact feedback.
The helper performs validation and evidence recording; the Machine owns routing.

## Retrospective

[retrospective](workflows/retrospective.md) accepts its own input: `workspaces`,
an array of 1–20 absolute directories, and optional `since`, a `YYYY-MM-DD` UTC
start date. With no date it covers the last seven days. It needs no Git checkout
and runs no checks or other Machines.

Operations read only `.machine-runs/machine-shop/<run>/` in the named
workspaces: `started.json`, `result.json`, `question-<n>.txt`, Human answers and
JSON stage reports. Only `ticket-task` runs are classified. Questions use their
file modification time; endings use `finishedAt`. Only `decide` answers are
matched, in numeric order, to question files. Older runs without question text
use the ending reason and answers as one stop. A missing result is reported as
not ended; it does not hide an in-window question. Completed runs with no stops
are omitted. Unreadable evidence is named without preventing the other reports.
Symlinked run directories are skipped and evidence-file symlinks are refused.

One analyst, given only extracted stops, supplies causes, automation marks and
one suggested change with its repository per group. Bind a read-only preset;
the analyst is instructed to use no tools or files. Operations group by workflow,
stopped stage and normalized first sentence of the reason, and validate complete
classification coverage. A malformed reply gets one retry, then a blocked result.
Only a falsify question's own recommended option counts as a recommendation;
hand off, archive and discard always need a person. Continue/fix-reviewer and
mechanical retry answers are also automation candidates.

The Markdown output is also `report.md` in the first workspace's new evidence
folder. It lists stops needing no person first, repeated causes by descending
count with suggestions and repositories, then single stops, runs not ended and
unreadable runs. Each stop includes the ticket, workflow, stage, cause, owner
answer and supplied blocker locations. These locations are not claimed to be
the decision to stop. Unknown metadata stays unknown. The Machine changes
nothing outside its own evidence folder, writes no tickets, changes no Machine,
and never starts, resumes or answers another run.

## Common input

Except for retrospective’s separate input above, the defaults accept a JSON object through MCP/Pi, `--input-file`, or a JSON
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
For ticket delivery, undoing the workflow's commit reopens that drift check;
a failed post-rebase setup or `reverify` also makes `checksPassed` false.
Resuming a delivered commit runs the gates as `verify` on the tree delivered
in this run, including after an equal-patch replay; it never inherits passing
checks from the earlier delivery.
Unexpected failures can leave `started.json`, Agent summaries, and check logs
without a final receipt. These workflows do not resume, undo, or roll back work.

## Ticket delivery

[ticket-task](../ticket-task.ts) is a separate root workflow, not one of the eleven
defaults: it is not in `defaults/`, the installer does not copy it, and it is the
only workflow here built on the shared helper that commits or publishes. It
reuses the helper for evidence, checks, fingerprints, review, and separate
budgets. Required Agent roles are `investigator`, `tester`, `implementer`, and
`reviewer`. Failed red, scope, and green gates use `maxRepairs` (0–3, default 3
here); review revisions use
`maxReviewRounds` (0–5, default 2). Neither consumes the other's budget. With a
stable base this allows at most 42 Agent calls before the stuck policy applies, including malformed-report send-backs (up to two falsify calls,
up to four calls each for planning and plan review, two initial tester calls, up to eighteen implementation calls, and twelve implementation review calls;
tester retries share the repair budget with implementation retries). Setting
both budgets to zero allows at most 20 calls, or 18 with `redGreen: false`.
The extra review round is available only once per run, even after an owner answer.
Its triggering blockers stay in the implementer's prompt. Scope is checked for
every finding with `outsideScope`, after removing a leading `./` and trailing
`:line` or `:line-range`. A pathless or outside-Scope finding, any discussion,
or no blocker asks the owner at the first spent budget; a `blocked` review still
stops immediately. Every stuck question after the extra round begins says it
was used and gives the latest well-formed review's `newSinceLastRound` from
that point, or says no review has finished in it yet.
The single permitted plan revision and [malformed-report recovery](#recovery) consume neither budget. A moved base that
changes the approved patch adds a fresh review outside these budgets.
Each `more rounds` decision renews both budgets and returns to the planning or editing stage that stopped,
including the tester or implementer when that Agent returned `blocked`;
after a second plan revision it grants one more plan and review with the reviewer's
feedback. After a `tooBroad` verdict it returns to `plan` with the suggested split,
without consuming the reviewer's revision allowance. A free-form answer also
renews both budgets. `stuck` no longer changes anything:
`"park"` (the default) and `"ask"` both use the same Human question.

```json
{
  "ticket": { "id": "PROJ-12", "title": "Add the empty state", "body": "## Goal\nShow an empty state.\n## Scope\n- src/widgets/**\n## Acceptance\n- An empty list shows No widgets.\n## Forbidden\n- nothing beyond the scope above" },
  "repository": {
    "name": "widgets",
    "path": "/absolute/widgets",
    "base": "main",
    "setup": [{ "name": "install", "command": ["npm", "ci"], "timeoutMs": 300000 }],
    "checks": [{ "name": "tests", "command": ["npm", "test"], "timeoutMs": 120000 }],
    "redCheck": "tests",
    "output": "pr",
    "remote": "origin",
    "draft": true
  },
  "worktreeRoot": "/absolute/worktrees",
  "evidenceRoot": "/absolute/project",
  "maxRepairs": 3,
  "maxReviewRounds": 2,
  "stuck": "park",
  "resume": false,
  "redGreen": true
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
least one non-empty bullet. A Scope bullet is the pattern itself, or its first
backticked span when the bullet annotates one, as in `` - `src/**` (the runtime) ``. Indented continuation lines and nested bullets join
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
(0–3, default 3), `maxReviewRounds` (0–5, default 2), `stuck` (`"park"` or
`"ask"`, default `"park"`), and the booleans `assume` (default `false`), `resume` (default `false`), and
`redGreen` (default `true`) are optional. `repository.redCheck` defaults to
`"tests"`; with red/green enabled, construction rejects a name absent from
`repository.checks`.

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
| `shape` | Validate the checkout and root paths; open evidence and refuse missing ticket sections or empty required lists before any Agent or worktree |
| `prepare` | Resolve the base commit; for `pr`, check that the base is published and the remote names a hosted repository; `git worktree add -b` the branch, then go to `setup` to record the id slug and run setup commands; with `resume`, adopt the existing worktree and its branch, save any candidate and move onto a newer base before setup and checks: conflicts go to `change`, a cleanly applied candidate to `scopeAfterChange`, then `verify`, and no uncommitted change through `start` to `falsify`; with no worktree, a recorded delivered commit is recreated and set up, then continues at `rebase` |
| `setup` | Record branch ownership and run new-worktree setup; failures ask `retry`, `hand off`, or confirmed `discard` |
| `start` | Open the helper's run on the worktree, which must be clean |
| `falsify` | Read-only investigator tries to show the ticket is wrong, already done, impossible here, or underspecified; returns `sound` with a one-paragraph summary or `questions` with 1–10 entries containing text, options, recommended, assumable, and why in the report's `questions` field, not its summary or message; a return for malformed questions includes the validation reason and repeats where the questions go |
| `falsifyResult` | Capture the falsify report before guarding the unchanged worktree and validating `questions`; missing or malformed questions return to `falsify` once per run, then go through the stuck policy with the reason and report's evidence file; a sound ticket goes to `plan`, as does an entirely assumable report with `assume: true`; remaining questions go through the stuck policy with their count in the first sentence and each question once in numbered needs, flattened with question text, each option, and why capped separately at 600 characters plus an ellipsis |
| `plan` | Read-only investigator returns `planned` with the complete plan as a summary, recorded as stage `plan`; asks for a concise plan naming files and tests without restating the ticket |
| `planResult` | Capture the report before guarding the unchanged worktree, then pass the plan to `planReview` |
| `planReview` | Read-only reviewer returns `approved` or `revise` with a summary, preferring concise plans without restated ticket text or detail the implementer does not need; returns `tooBroad` with a suggested split into smaller tickets when the ticket is too broad for one run; the prompt includes the plan verbatim |
| `planReviewResult` | Capture the report before guarding the unchanged worktree; first `revise` returns to `plan`, second `revise` goes through the stuck policy with the reviewer's summary as the reason and the usual capped blocker needs; `tooBroad` goes through the stuck policy with the suggested split in the question, without consuming a revision; `approved` continues to `test` or, with `redGreen: false`, `change` |
| `test` | With `redGreen: true`, the tester writes only tests for every acceptance criterion inside Scope, leaving them uncommitted; its summary is recorded as stage `test` |
| `scopeAfterTest`, `red` | Check changed paths against Scope, then run the named red check; failures consume the repair budget and return to `test` |
| `change` | The implementer edits the worktree and leaves the changes uncommitted, making the tester's tests pass without weakening or deleting them |
| `scopeAfterChange` | Check changed paths against Scope; violations consume the repair budget and return to `change`, otherwise continue to `verify` |
| `verify` | The required checks; a failure goes to the repair budget |
| `review`, `reviewResult` | Capture the structured report; the Operation preserves the unchanged-checkout guard and judges criteria, finding severity, and progress to approve, revise, or apply the stuck policy |
| `commit` | One commit of everything except `.machine-runs`, even if an Agent staged it: subject is the ticket title, body is `Ticket: <id>` |
| `rebase` | Resolve the current base; replay exactly the approved ticket commit onto a forward tip. Rerun setup, then `reverify` for an equal patch (`verify` on a resumed delivered commit) or `verify` and fresh review for a changed patch. An unchanged-base delivered resume runs `verify` without replay. Undo the replayed commit before any new stop, repair, or re-review; if ignore rules on the tip would drop added files, restore the candidate on its original base through `stuck` |
| `deliver` | `branch`: keep the branch. `patch`: `git format-patch` for base..HEAD into the evidence directory. `pr`: `git push --no-follow-tags <remote URL>` of the approved commit to the ticket branch alone, then `gh pr create --repo <host/owner/repository>`. After these succeed, every mode records `branch.<name>.ticketDelivered` in local Git configuration |
| `success` | Remove the worktree and write the delivery receipts once; branch and patch end `delivered`, pull requests go to `checkMerge`; a kept worktree ends `delivered` immediately with its path and cleanup log |
| `checkMerge`, `awaitMerge` | Ask `gh pr view <url>` for the pull request state every 10 minutes; an open request or fewer than three consecutive failures waits again |
| `cleanUp` | Only after `MERGED`, delete the remote ticket branch and then the local one; an already absent remote branch counts as deleted, other failures retry three times at one-minute intervals, then ask `mergeRetryDecide` |
| `mergeDecide`, `confirmMergeDiscard` | Human, regardless of `stuck`: a closed pull request or three consecutive check failures offers only `hand off` and `discard`; discard needs a second confirmation, and `go back` returns to `mergeDecide` |
| `dropLocal`, `mergeHandOff`, `mergeAbandon` | Confirmed discard deletes only the local branch and ends `abandoned`; hand off keeps it and ends `handedOff`; cleanup failure retries then asks `mergeRetryDecide`; each ending writes `merge.json` with `hold` output |
| `stepFailed`, `stepDecide`, `keepDecide`, `deliverDecide`, `confirmStepDiscard` | Save a question naming the failed step and error; offer only available choices; discard needs confirmation and retry reruns only the failed step |
| `mergeFailed`, `mergeRetryDecide` | After cleanup retries are exhausted, save a question offering `retry`, `hand off`, or confirmed local `discard` |
| `refuse` | Write a reason and end in the declared failed ending `refused` |
| `repairBudget`, `repairTarget`, `reviewBudget` | Count gate retries and review revisions separately; gate retries route to the responsible editing stage, review retries to `change`. Once per run, a spent review budget returns to `change` with a fresh review budget if the last verdict is `revise`, every finding names an in-Scope path, at least one is a blocker, and none is a discussion. Repair counts carry over. Other exhaustion goes to `stuck` |
| `stuck` | Go to `decide` for both accepted input values |
| `decide` | Human: sleep on one question with what is needed first, then the stopped stage and budgets, the remaining reason or questions once, and evidence; suggest `more rounds`, `hand off`, `archive`, and `discard`, accepting any other reply as an answer |
| `confirmDiscard` | Human: `confirm discard` or `go back`, asked before a discard removes anything |
| `archive`, `remove` | Commit the candidate and keep that commit as the branch `archive/<slug>`; `git worktree remove --force` and `git branch -D` for this run's own worktree and ticket branch |

New runs begin with `falsify` → `plan` → `planReview`, capturing each report before
its unchanged-worktree guard or validation. A missing or empty summary in any
planning state goes back once with the exact fault, then through the stuck policy, with the state and missing summary
named in the reason. A plan sent back once by the reviewer is re-planned with the
reviewer's feedback and reviewed again; a second revision stops before editing.
The planner names files and tests concisely without restating the ticket. The
reviewer sends back restated ticket text or detail the implementer does not need
as an ordinary revision. If the ticket is too broad for one run, the reviewer
returns `tooBroad` with a suggested split into smaller tickets, one per line in
the summary. This stops before editing and carries the split into the Human
question and its saved file; it does not consume the reviewer's revision.
An empty plan or one over the general stage-report capture limit of 16000
characters is still refused and gets one send-back. Missing or malformed falsify questions return to `falsify`
once per run with the validation reason and instructions to put the questions
in the report's `questions` field, not its summary or message. The field is the
only source of questions. This allowance is separate from the reviewer's
revision and consumes neither budget. A second malformed
report goes through the stuck policy, asking a Human question saying
the questions were missing or malformed twice, giving the validation reason
and naming the `falsify-<n>.json` evidence file holding that report.
Each question has the shape
`{ text, options: string[], recommended: string, assumable: boolean, why }`.
Text and why must be non-empty strings; options must be a non-empty array of
non-empty strings, and recommended must copy one of those options exactly.
A malformed entry's reason names its field, such as `questions[0].options`,
both on the return and on a second malformed report's stop;
plain strings are no longer valid entries.

The `assume` switch is off by default and applies only in `falsify`; enabling it
for a ticket or repository remains the owner's decision. `assumable` means a
gap whose conservative answer loses nothing if wrong: it stops, refuses, or keeps
more. A product decision, a change of scope, or anything irreversible is never
assumable. With `assume: false`, all questions go to the owner. With `assume: true`,
an entirely assumable report records the recommended answers and continues to
`plan`; a report with any question that is not assumable asks only those
questions and sleeps on the Human request, listing the others as answers it
would have assumed, without recording them as assumptions. An answer returns
to `falsify` and remains in the planner's prompt when the ticket is found sound.

When the run continues, its evidence directory gets `assumptions.json`, an array
of `{ question, answer, options, why }` copied from the questions and recommended
answers. The file's exact text is passed under `Assumptions:` to `plan`,
`planReview`, `test`, `change`, and `review`, before `Plan:` wherever that heading
exists. A reviewer who disagrees with an assumption reports a `discussion`
finding; the report shape and existing escalation rule are unchanged.
At the same time, `falsify` writes `ticket-task-assumptions.json` inside the
worktree's own Git directory, resolved by
`git rev-parse --path-format=absolute --git-dir`. This saved copy survives a
sleep or hand off, outside the working tree and never staged or committed.

After plan approval, new runs go through `test` → `scopeAfterTest` → `red` →
`change` → `scopeAfterChange` → `verify`. With `redGreen: false`, they skip
`test`, `scopeAfterTest`, and `red`. Resumed runs with a candidate skip them too,
since red cannot be proved again once the change exists, but are held to the Scope
at `scopeAfterChange` before `verify`. If its base moved, preparation saves and
re-applies the candidate first; conflicts go to `change` for the implementer
to settle before the scope check, checks, and review. A resumed worktree with no
uncommitted change
starts again at `falsify` with the current ticket, then plans and tests afresh.
The reviewer, tester, and implementer receive the captured prose plan verbatim under a `Plan:`
heading. The tester receives the acceptance and Scope lists and must write one or more
tests per criterion without implementing behavior or editing non-test files.
Red requires a non-empty Git status excluding `.machine-runs` and a nonzero
exit from the named check, without a signal, timeout, or spawn error. A passing
check or a tester that changed nothing returns to the tester with that reason.
The check also must not change the candidate. Red evidence records phase `red`
and `expected: "nonzero exit"`; normal gates prove green.

Both scope Operations read NUL-delimited Git status with all untracked files,
count both names of a rename, and exclude `.machine-runs`. They write
`scope-<n>.json` containing `{ stage, changed, outside }`. Violations name the
paths and allowed Scope list in the next Agent prompt. An empty implementation
change passes scope; the existing verification and commit guards still apply.
Patterns use `/` separators: `**` matches zero or more segments, `*` matches
within a segment, and `?` matches one character. Other characters are literal.
A literal path matches exactly or as a directory prefix (`src` and `src/` both
allow `src/a.ts`); a leading `./` is ignored.

The implementer receives the parsed acceptance and forbidden lists. With
red/green enabled, the tester's tests are the contract: incorrect tests must be
explained in the summary rather than weakened or deleted. On a new red/green
run the reviewer is told the Machine saw the tests fail and must check that they
pass for the right reason without weakening. The reviewer
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
   differs from the acceptance list go back once with the exact fault, then block with the field named and go to
   `stuck`. Entries are matched to criteria by position, so a reworded
   criterion is not malformed. Feedback uses the ticket's criterion text at that
   position, not the reviewer's wording.
2. A reviewer `blocked` event goes to `stuck` with its summary; it does not
   require `criteria`, `findings`, or `newSinceLastRound`.
3. Any unmet criterion or blocker requires repair, regardless of the event's
   approval verdict. Feedback lists each unmet criterion, blocker, and discussion
   with its evidence or location.
4. Before retrying an unresolved criterion or blocker on a later review,
   `newSinceLastRound: "none"` with the same set of blocker texts blocks as
   not converging and goes to `stuck`, naming the unchanged blockers. Empty or
   whitespace-only text also means none, as does `none` after trimming,
   lower-casing, and dropping a trailing period. With no blockers, the reason
   names the unmet ticket criteria instead. The first-review rule below defines
   when comparisons restart after rebase.
5. Discussions get one repair round to resolve them or explain why they need
   the owner. If the previous review also had discussions, every discussion in
   the next review goes to the owner together through `stuck`, whatever its
   wording, only when no criteria or blockers need repair. This depends on review
   position, not matching text. Discussions after a review without any get a
   fresh repair round; the first-review rule below also applies after rebase.
6. All criteria met with no blockers or discussions approves, including a
   reviewer `revise` event containing only minors. Minor notes accumulate across
   review rounds, deduplicated by text and location after trimming and
   lower-casing. The pull request renders each note on one line and omits
   parentheses when its location is empty.

The first review of a new patch is the review after a differing patch id on
rebase, after repairing a failed `reverify`, or after `more rounds` following a
setup failure or tracked/unignored leftovers on the new tip. For convergence
and discussion escalation, these reviews are not compared with reports from
before the rebase; only subsequent reviews of that patch are compared.

After a Machine block for non-convergence, open owner questions, or a malformed
report, `more rounds` restores the latest review's available findings as the
implementer's feedback, including their locations, rather than the stop reason.

Operations do all Git, command, and publishing work. Machine-judged `revise`
returns to `change` within `maxReviewRounds`; failed checks use `maxRepairs`.
Every retry passes through the real
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

Between `commit` and `deliver`, `rebase` resolves
`${repository.base ?? "HEAD"}^{commit}` in the source checkout, just as
`prepare` does. For a commit approved in this run, an unchanged tip or a base
that no longer resolves continues to delivery unchanged, with no `reverify`
phase. A resumed delivered commit instead requires its own `verify` gates on
an unchanged base and refuses if the base no longer resolves. Otherwise the tip must descend
from the current `baseCommit`. A base that was rewritten or moved back is not
replayed onto: `git reset --mixed <baseCommit>` undoes the ticket commit, and
`keepDecide` asks `hand off` or confirmed `discard`, with both commits named
and instructions to deliver by hand. Resume is not promised here: `adopt` continues to refuse a branch
whose base is not in the new tip.

For a forward move, the approved commit and its `git patch-id --stable` are
kept, then `git rebase --no-autostash --no-update-refs --onto <tip> <baseCommit>`
replays exactly the ticket commit. No rebase or push is forced, and no other
branch is moved. The result must be exactly one commit above the tip, with
the tip as its only parent, the ticket title and `Ticket:` line intact, a
clean worktree, and HEAD still on the ticket branch. In `pr` mode, before
replay, the new tip must also be on the remote pull request base. This repeats
the published check with `ls-remote` and a fetch by URL if necessary, using
only the URL and branch name recorded in `prepare`; configuration is not read
again. An unpublished tip, missing remote base, or unreachable remote restores
the uncommitted candidate on the original base and goes through `stuck`, saying
the base must be pushed first.

Every stop added here obeys one invariant: a run never stops with the workflow's
commit on the ticket branch. Before a stop, repair, or re-review, the commit is
undone with a mixed reset, its recorded hash is cleared, and verification is
reopened. A conflict aborts the rebase and restores the approved candidate
uncommitted on its original base. The reason names the conflicting paths and
new tip: a resumed run saves the candidate, moves it onto the current base,
and sends conflicts to the implementer before checks and review. A replay leaving
no commit similarly restores
the candidate and stops through `stuck`, saying the base already holds the
change; resume alone repeats this stop too. A refusing hook, missing patch id,
unexpected commit count, changed parent or message, moved HEAD, or dirty tree
after replay conservatively restores the approved candidate on the original
base and stops through `stuck`. No new Human choices or resume instructions are
needed.

Before undoing onto the new tip, the step checks the replayed commit's added
paths against ignore rules with `git check-ignore --no-index`; if any would
be dropped by the next `git add --all`, it restores the approved candidate
uncommitted on its original base and stops through `stuck`.
The ignore stop names the affected files and each rule's file, the new tip,
and why the undo was needed; resume checks the current tip's rules in `prepare`
and stops there until the candidate or ignore rules are reconciled. Modified
and deleted paths stay tracked after
the undo, and re-included added paths are safe. Failure to inspect added paths
or ignore rules also restores the candidate and goes through `stuck`, with
failure logs retained. The added paths are saved as `rebase-<n>.paths`.

Restoring the original candidate first resets to the approved commit, then
runs `git clean -f -d -q -e /.machine-runs` before undoing that commit. This
removes later untracked files and directories under the approved tree's ignore
rules, including setup outputs only the tip ignored. Files those rules ignore,
`.machine-runs/`, and untracked nested Git repositories are kept. Git requires
a second `-f` to remove nested repositories; they may hold commits found nowhere
else, so cleanup keeps them. A clean failure still proceeds to undo the commit;
the stop reason names the failure and its numbered `rebase-<n>-clean.log`,
explaining why leftovers may reappear on resume.

After a valid replay, setup runs again as phase `setup` while the rebased tree
is still committed and clean, so its unignored outputs can be detected as in
`prepare`. A failed command or tracked/unignored leftovers undoes the commit
on the new tip, updates `baseCommit`, marks checks failed, and goes through
`stuck` naming the command, subject to the ignore guard above; this is not an
implementer repair. Choosing `more rounds` then follows the first-review rule
above. If patch ids differ and the ignore guard permits the undo on the new tip,
the run returns to `verify` and a fresh `review` under that same rule, which can
approve, revise, or block normally. This re-review uses neither budget and
repeats only if the base moves again.
If patch ids match, the gates run as phase `reverify`, or `verify` when resuming
a delivered commit so the helper records this run's checks. Passing delivers the
rebased commit with the new tip as `baseCommit`. Failing undoes the commit on
that tip if the ignore guard permits, marks checks failed, and goes to
`repairBudget`; the implementer sees the failed gates before the normal
verify/review/commit/rebase sequence, following the first-review rule above.
With no further base movement that second `rebase` needs no second `reverify`, since
`verify` checked the candidate on the new base.

A setup command that moves HEAD or switches branches also counts as failed
checks and conservatively restores the approved candidate on its original base
through `stuck`; recovery only resets this ticket's branch. The approved and
replayed diffs are retained as `rebase-<n>.patch`, with numbered Git failure logs
so repeated attempts in the same run keep distinct evidence.

The Operation writes the pull request body, in this order: the ticket title on
the first line; `## Summary` with the first paragraph of the ticket body below
its leading headings, ended by a blank line or the next heading, a section left
out when the body has no such text;
`## Assumptions` when the run assumed answers in falsify, with one flattened
`- <question> Assumed: <answer> (<why>)` line per answer;
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
commits and moves no local ref. The run ends `refused` before any worktree,
branch, or Agent when the base has commits the remote branch lacks (the message
gives their number and says the base must be pushed first), when the base
branch does not exist on the remote, when the base names no branch and the
remote does not say which branch is its default, or when the remote cannot be
reached or its tip fetched (the Git output is saved as a log). The check, like the push,
has a two-minute timeout and also runs for a resumed `pr` run. `branch` and
`patch` runs make no network call.

Stuck work goes to the `stuck` Operation. This covers falsify returning
questions that the run cannot assume, a second malformed falsify questions report,
other malformed planning reports (including missing or empty summaries), a plan review finding the ticket too broad, a second plan review revision, any read-only
planning stage having edited files, the tester or implementer returning `blocked`,
the reviewer returning `blocked` or having edited files, review non-convergence,
open owner questions, malformed review reports, either budget exhausting,
and the recoverable rebase stops described above.
Entering `test` or `change` marks the tester or implementer as the stage to
repair, so `more rounds` after that Agent returns `blocked` goes back to it;
the decision prompt names that same Agent.
A stuck run sleeps on one Human question in `decide`, keeping its worktree,
branch, and candidate. The prompt describes what stopped it, what is needed,
open questions, and evidence. Each question is written as `question-<n>.txt`
in the evidence directory, numbered from 1 across the run, including re-asks
and continuation after sleep. No final receipt is written while waiting.
Continue the sleeping run by answering its pending request; no new run or
`resume` input is needed.

Any nonblank reply that is not one of the four decisions is an answer and
works like `more rounds`: renew both budgets, clear owner questions, and go
back to the stage that stopped;
a blank reply repeats the question without restarting work. Answers remain under
`Answers from the ticket owner:` in every later Agent prompt and survive sleep
and continuation. Each reply is recorded in `human-<n>.json` and the receipt's
`decisions` list, preserving the raw reply. The four decisions match ignoring
case, surrounding whitespace and trailing punctuation (`. , ; : ! ? …`).
The canonical decision is recorded in `delivery.json`; `confirm discard` and
`go back` stay exact. Decision replies take the existing paths below.

All Human prompts use the same brief helper: decision first (at most 100 characters
including `…` when cut at a word boundary), a blank line, standing, needs when
non-empty, evidence locations, then options. A stuck question starts with what
is needed: a question count, report fault or spent budget. Standing includes
the ticket id without its title, stopped state, both budgets and any extra review
round. Needs give the remaining reason or numbered questions once. When the
opening is cut, Needs retain the full reason up to their usual limit. Discard
confirmation gives the stop reason once under Needs. `hand off` is recommended and
listed first in the prompt. The four decisions are suggestions, not restricted
choices:

| Choice | Effect | Final state |
| --- | --- | --- |
| `more rounds` | Both used budget counts return to zero and owner questions are cleared; return to the planning state that stopped, or to `plan` with the reviewer's feedback after a second revision. Otherwise return to the editing stage that stopped, the tester or implementer, with the standing findings. A plan must be approved before testing and implementation. It can be chosen again every time a budget runs out | continues |
| `hand off` | Nothing is touched: the worktree and the branch stay, uncommitted, for another workflow or a person to work in | `handedOff` |
| `archive` | What delivery would have committed, tracked and untracked files without ignored files or `.machine-runs`, is committed and kept as the branch `archive/<slug>`; then the worktree is removed and the ticket branch deleted | `abandoned` |
| `discard` | After confirmation, the worktree is removed and the branch deleted without saving the candidate | `abandoned` |

`archive` saves exactly what delivery would have committed, as a commit Git
already knows how to store. `<slug>` is whatever follows `ticket/` in this run's
branch name, so `ticket/proj-12-add-a-greeting` is archived as
`archive/proj-12-add-a-greeting`. If that branch already exists the Operation throws
before anything is staged. Otherwise the candidate is staged as
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
commit. Nothing is removed, and the Operation throws, when the candidate does
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
on this run's own worktree and ticket branch; if either fails the Operation
throws with the saved log. The workflow builds these steps from the public
Human primitive with suggestions for `decide` and restricted choices for
`confirmDiscard`. How they are presented, and how long a
run may wait, belongs to whichever surface runs the Machine.

With `"resume": true` and an existing worktree, `prepare` adopts it instead of
creating one, whether or not a hand off or block left a candidate. It requires all of: the
worktree directory exists and is a Git worktree of `repository.path`; its `HEAD`
is a symbolic ref to a branch that belongs to this ticket by the rule above; and
that branch points at the resolved base commit or at an ancestor of it, so
nothing was committed on it. The base branch may therefore have moved forward
while the ticket was stuck. Adoption validates the commit the ticket branch
points at and, in `pr` mode, checks that it is published. Once every refusal
check passes, `prepare` moves the worktree onto the current base before any
Agent, scope check, or verification runs. In `pr` mode it first checks that the
current tip is published too; otherwise it asks with nothing changed. Delivery's
replay still handles a base that moves again during the run. The final base
determines the delivered commit's parent, patch range, and `delivery.json`.
A branch that holds commits the base does not, or that shares no
history with it, is not adopted. The run continues on the branch the worktree
is on and does not compute a name from the current title, so a candidate
started under an earlier title, or
as `ticket/<id-slug>` before branches carried one, is delivered on that branch.
A worktree on a branch whose ownership is unresolved, or that belongs to another
ticket, is not adopted; for the first the message gives the `git config` command
that records it. If any of these fails
the run ends `refused` with a message naming the condition, changing nothing.
When the base has not moved, setup is not run again and resume behaves as
before. When it has moved, preparation first saves any uncommitted candidate
as `saved-candidate.patch` in the evidence directory and as a recovery ref at
`refs/machine-shop/saved/<id-slug>/<hash>`. The recovery commit object does not
move the ticket branch or run hooks; the candidate remains uncommitted there.
The worktree is reset onto the tip, added paths are checked against its ignore
rules, and setup runs on that clean tip before the saved candidate is re-applied.
A clean worktree moves and runs setup too, then plans afresh.

If the tip's ignore rules match an added file, preparation restores the candidate
on its old base and asks, naming the file and the rule's file. This check uses
the tip's rules even if the candidate would un-ignore that file. Failed setup,
setup moving HEAD or the branch, or tracked or unignored setup output also
restores the old candidate and asks, naming the command. A re-apply that leaves
no change asks because the base already holds it, again restoring the candidate.
Every later question names the saved ref and patch outside the Needs text limit.

With a candidate, resume skips `falsify`, `plan`, and `planReview`. A clean
re-apply goes to `scopeAfterChange`, then `verify`, review, commit, rebase, and
deliver. Conflicts go to `change`: its prompt names the files, old and new base,
saved candidate, and `resume-conflicts.diff`, which holds each side's changes.
The implementer must keep both sides' intent and remove markers without staging
or committing. The run stages each conflicted file with no markers left, including
a deleted file as a removal. For conflicts without markers, the prompt names each
file and the version left in the worktree; leaving it alone keeps that version.
An unmerged index or remaining opening, base,
or closing conflict marker counts as a failed repair through the existing
budget. Bare `=======` lines are allowed as Markdown underlines. Once settled,
the scope check, checks, and review run normally; review is told which bases
were involved and which conflicts were settled. Exhaustion asks the owner with
the files and saved copy named. A later resume with an unmerged index returns
to `change` without moving again; `ticket-task-move.json` in the worktree's Git
directory preserves the original saved-copy locations. Archiving unresolved
conflicts can commit their markers, but the saved ref still holds the candidate
as it stood before the move. The repair budget and review rules are unchanged.

A resume uses fresh budgets and the normal repair loop if review asks for changes.
A candidate resume reads `ticket-task-assumptions.json`
from its worktree's Git directory, if present, validates it, and writes this run's
evidence `assumptions.json`. It passes those answers under `Assumptions:` to its
reviewer, lists them under `## Assumptions` in the pull request, and records them
in `delivery.json`. Without a saved file it behaves as before, with no assumptions.
An unreadable file, invalid JSON, or anything other than an array of 1–10 objects
with non-empty `question`, `answer`, and `why` strings and a non-empty array of
non-empty `options` strings refuses resume with `Cannot resume` naming the file,
before adopting or asking the remote, changing nothing. Each `answer` must be one
of its entry's `options`. Extra fields are omitted from the validated answers.
Without a candidate, resume goes through `start` to `falsify` and plans and tests
the current ticket afresh. It never reads the saved file; when its own `falsify`
returns, even with a malformed report, it deletes the file or replaces it with
what that falsify assumed. A failed delete or write stops, naming the file.
A clean resume also includes a worktree left clean by a failed setup in `prepare`;
resolve the setup problem in the kept worktree before resuming. The base
must resolve to the commit the first run started from or to a descendant of it,
so name `repository.base` explicitly, or leave the source checkout on the branch
it was on. Even after a post-rebase setup failure, resume does not rerun setup
unless the base moves again; resolve the setup problem in the kept worktree
before resuming. Without `resume`,
an existing branch or worktree directory still blocks.

When the worktree path is absent, `resume: true` can adopt a delivered commit
and continue directly at `rebase`, with no Agent before that step. Exactly one
branch must belong to the ticket, with no sibling of unresolved ownership.
It must hold exactly one commit outside the current base's history, with one
parent that is an ancestor of the current base, the current ticket title as
subject, and an exact `Ticket: <id>` line. Its local
`branch.<name>.ticketDelivered` record must equal its tip: an absent or
mismatched delivery record refuses resume with `Cannot resume`, changing
nothing, including for deliveries made before this record existed.
Merge commits, already merged tips, branches at their base, multiple commits,
unrelated or moved-back history, a retitled ticket, and wrong or missing ticket
lines are refused. No branch, multiple owned branches, or an unresolved sibling
also refuses without changing anything. In `pr` mode a delivered resume is refused
because the pull request is brought up to date at its host; it makes no remote
request and changes nothing.

After those checks, `git worktree add <worktree> <branch>` recreates the worktree
on the existing branch and runs `repository.setup`. A stale worktree registration
or a branch checked out elsewhere that prevents recreation is refused, without
pruning registrations or forcing the add. Failed setup, leftovers, or changed
HEAD at adoption refuses resume and removes only the recreated worktree; a
removal failure reports the kept worktree instead. The delivered commit's parent
becomes `baseCommit`, and the delivered commit becomes the approved commit.
An unresolved base after recreation also refuses and removes that worktree.
If the base moved forward, the existing replay, conflict, setup-failure, repair,
and changed-patch review rules apply, with equal-patch gates run as `verify`.
If the base has not moved, setup and `verify` test the same commit before it is
delivered again, without replay or an Agent. Failed unchanged-base gates undo the commit and enter `repairBudget`, then
return to `change` as any red check does; they never offer `retry`. No prior run's checks are accepted as evidence for this run.

Shape and preparation refusals end `refused` with the reason. Setup, commit,
rebase, delivery, and merge cleanup use the [recovery table](workflows/ticket-task.md#recovery-by-step).
Push and `gh` creation failures retry three times with a fixed one-minute wait,
then ask `retry` or `hand off`; other delivery failures ask immediately.
A retry reuses any known pull request URL, avoiding duplicate creation.
Commit retries restore the index and recheck the verified candidate; failures
that cannot be retried offer only `hand off` or confirmed `discard`.
Archive and removal errors throw after the owner's choice. Failed Git or `gh`
commands save their output as a log in the evidence directory.

After pull request delivery removes the worktree, the run sleeps while waiting
for the merge when started with the sleep option, as Dispatch does. It saves its
state and checks again when due. A successful `OPEN` answer resets the failure
counter. Failed `gh` checks, including unexpected output, write numbered
`gh-pr-view-<n>.log` files; three consecutive failures go to `mergeDecide` with
the message. A `CLOSED` answer goes there immediately with the reason that the
pull request was closed without merging, regardless of `stuck`. Both decisions
keep the pushed remote branch. There is no worktree to archive or repair.
Remote deletion runs only after `MERGED` and uses the URL recorded at delivery.
If a failed delete is followed by a successful query showing the branch gone,
cleanup continues; other deletion failures retry three times, then ask `retry`,
`hand off`, or confirmed local `discard` in `mergeRetryDecide`. The same applies
to `dropLocal`. Retry reruns only the failed Operation, and `go back` from its
discard confirmation returns to that recovery question.

Final states are `delivered`, `merged`, `handedOff`, `abandoned`, and `refused`.
Their declared ending kinds are succeeded for delivery and merge, cancelled for
hand off and abandonment, and failed for refusal.
The `merged` final returns exactly `{ "action": "complete", "summary": "<text>" }`
after deleting the local and remote ticket branch, so Machines Dispatch closes
the ticket. All other finals return exactly `{ "action": "hold", "summary": "<text>" }`
with no other field, keeping the ticket open. The workflow never
relaunches itself, launches another Machine, or edits or closes a ticket file.
The one-line delivery summary names the branch, commit, and pull request URL or patch
path on success. A hand-off starts with a short sentence saying what is needed,
then the remaining reason; the branch follows the decision. Other stops begin
with their reason. Summaries also include the decision if one was made, the
archive branch and its commit after `archive`, the worktree if it was kept
(before delivery for `handedOff` and `refused` once it exists), and the evidence
directory. Read
the final state, not the action, to tell the endings apart. `delivered` means
the branch, patch, or pull request was delivered. Before delivery, `handedOff`
keeps the worktree and branch. A `refused` run keeps anything that already
existed, except that delivered-candidate withdrawal removes its recreated
worktree; `abandoned` means the worktree and ticket branch are gone, with the
candidate on its archive branch after `archive`.
A worktree that cannot be removed after delivery ends `delivered` immediately,
without the merge wait. Its summary names the kept path and `git-worktree.log`.
The delivery receipt has outcome `delivered`, `worktreeRemoved: false`, and no
`reason`; the result receipt has outcome `completed` and an empty reason.
If the helper cannot confirm passing verification at completion, it instead
records its reason and the Machine ends `refused`.
Invalid input, a `repository.path` that is not a checkout root, a worktree or
evidence root that resolves into the repository through a symlink, and
unexpected exceptions are runtime failures.

During the merge wait the worktree is already gone. `handedOff` keeps the
remaining branches; confirmed discard ends `abandoned` keeping the remote
branch. `merged` removes both branches and the local branch's ticket configuration.

Evidence is written to `<evidenceRoot>/.machine-runs/machine-shop/<id>/`, outside
the repository and the commit: the helper's `started.json`, check and setup
logs (including red), `scope-<n>.json` path checks, Agent summaries, full
planning events as `<stage>-<n>.json` (`falsify`, `plan`, `planReview`, numbered per
stage even on retries), structured reviews as `review-<n>.json`, each Human answer
as `human-<n>.json`, and `result.json`. A moved candidate also has
`saved-candidate.patch`, `resume-added.paths` for the ignore check, and
`resume-conflicts.diff` if it conflicted; its recovery ref is
`refs/machine-shop/saved/<id-slug>/<hash>`. Evidence includes
`delivery.json` with the ticket id, repository name and path, branch, base
commit, commit hash, output mode, pull request URL or patch paths, worktree
path, whether the worktree was removed, and `reviewNotes: [{text, where}]` in
every output mode (an empty list when there are no minors). When falsify assumed
answers or a candidate resume read them back, `delivery.json` also records
`assumptions`, the array written to `assumptions.json`, for every outcome in that
run; both are absent when no assumptions were made or restored. Its `outcome` is `delivered`,
`handed-off`, `abandoned`, or `refused`. It records `decision` when one was made
(the last ending choice, so `discard` for a confirmed discard and
`more rounds` for a run that went on to deliver), `archive` as
`{ "branch", "commit" }` when the archive branch was created, and `resumed` for
a resumed run. Its `worktreeCreated` is false for an existing worktree and true
for a recreated delivered-candidate worktree. A successful unchanged-base
redelivery also records `redelivered: true`; repeated runs deliver the same
commit and change only their evidence. Its `baseCommit` is the final
base used by the run. Once a valid replay changes the base, every receipt includes
`rebasedFrom`, shaped as `{ baseCommit, commit }`: the base the run started from and its
first approved ticket commit. This also survives re-review, repaired `reverify`,
and later stops in that run; it is not carried between separate resumed runs.
For a delivered-candidate resume, the successful hold retains its usual
`Delivered <branch> at <commit>` first sentence and adds one sentence saying
the delivered commit was replayed onto the new base, or delivered again
unchanged, before the final `Evidence: <directory>`.
The stuck question opens with the count of open review or falsification
questions. Needs list each question once on its own numbered line with its
location. Needs cap each question's flattened text separately at 600 characters
plus an ellipsis, keeping its
location; the list itself is not capped. Empty locations omit the parentheses.
Falsification questions follow the same limits as review
questions: each numbered line then lists the options with the recommended
answer first and marked, followed by why. Under Needs, each option and why is
flattened and capped separately at 600 characters plus an ellipsis. In a mixed
report with `assume: true`, Needs also list the answers the run would
have assumed, outside the numbered questions; Needs flatten and cap each such
question and answer separately at 600 characters plus an ellipsis. Other stops
put their first sentence above standing and their remaining reason under Needs,
flattened and capped at 600 characters plus an ellipsis when truncated. The full
stop reason remains in the receipt, and raw planning events preserve even malformed reports.
For pull requests, `delivery.json` and `result.json` describe delivery before
the merge wait and are never rewritten. The later `merge.json` records
`schemaVersion`, `outcome`, `prUrl`, `branch`, `checks`, `ghFailures`,
`localDeleted`, `remoteDeleted`, and any `reason` or `decision`. It and the
Machine output carry the final merge outcome even when `result.json` says
`completed` but cleanup later needs a decision. Human answers after delivery are still
recorded separately as `human-<n>.json`.

`result.json` keeps the helper's vocabulary: before the merge wait, its `outcome` is `blocked` for
`handedOff`, `abandoned`, and `refused`; `repairs` counts red, scope, and green
gate retries and `reviewRounds` counts review revisions, each cumulative across renewals;
`decisions` lists every Human answer before delivery. Later answers are in
`human-<n>.json`.

Limits: a run waiting in a Human state before delivery keeps its worktree and
branch until it is answered. `resume` adopts only the ticket's own worktree and branch, either clean
at its base or holding an uncommitted candidate, or recreates a missing worktree
for the recorded delivered commit under the conditions above; it does not
restore an archive branch, adopt any other committed candidate, or accept a
base rewritten away from its history. Delivery records are local configuration
and do not travel with a push or clone; without one, even a correctly shaped
commit cannot be resumed as delivered. Earlier assumptions and review notes
are not restored from the removed worktree on this path.
Without `resume`, a second run of the same ticket is refused while any branch
of that ticket exists; resume it, or delete
the branch and any kept worktree to retry from scratch.
Two ids that differ only in case or punctuation share an id slug. The ticket
record is local Git configuration: it does not travel with a push or a clone,
so a ticket branch checked out in another clone has no record there. One that
holds its ticket commit is still told by that commit; one without it, unless it
is named exactly `ticket/<id-slug>`, has unresolved ownership, which blocks a new
run of the ticket and cannot be resumed until it is recorded. The
published-base checks record configuration in `prepare`, including the new tip
on resume, and ask the recorded remote base again before delivery replay onto
a newer tip. It is not an atomic
lock against later remote movement. A `gh` failure
after a successful push leaves the pushed branch on the remote. A commit that a
hook altered stays on the local branch, undelivered. Like the defaults, this is not a sandbox: Agents and commands run with the
harness's and user's permissions, and `pr` mode publishes the change, so accept
tickets and repository settings only from a trusted source.

## ChatGPT thread

[chatgpt-thread](../chatgpt-thread.ts) is a separate root workflow, not one of
the eleven defaults: it is not in `defaults/`, the installer does not copy it, and
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
all eleven success paths, failure and rejection paths, red/green requirements,
repair budgets, stale verification, source-integrity guards, malformed inputs,
command errors, and result retrieval. `npm run smoke:install` covers selective
installation, conflicts, relocation, discovery, and the real CLI. Ticket delivery
is tested the same way for each output mode, with a local bare repository as the
remote and a recording `gh` stand-in; no network or real `gh` is used. The
ChatGPT thread is tested with a fake `chatgpt-web` runner and an injected
continue function; no browser, rig-bridge, or ChatGPT account is used. These tests
do not prove that a live model follows the instructions or solves a software task.
