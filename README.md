# Machine Shop

A selective starter library of **ten software-task Machines**: implementation,
bug fixing, refactoring, tests, review, investigation, documentation, dependency
upgrades, release preparation, and model-free verification.

This is the independent `machine-shop` Git repository in Machines Org. It owns
reusable workflow policy, not the Machines runtime, Agent harnesses, scheduling,
or the global `~/.machines` directory. The defaults are portable TypeScript
definitions with explicit states, real check gates,
bounded repairs, and retrievable JSON evidence.

## Choose a workflow

| Default | Purpose |
| --- | --- |
| `verify-checks` | Run explicit project checks without a model |
| `implement-task` | Implement a feature, verify it, and review it |
| `fix-bug` | Prove a regression red, fix it, prove green, and review |
| `refactor` | Preserve behavior against a passing baseline |
| `add-tests` | Add meaningful tests without changing production behavior |
| `review-code` | Return evidence-backed review findings without edits |
| `investigate` | Investigate and challenge a diagnosis or technical choice |
| `update-docs` | Update docs/examples and validate against the source |
| `upgrade-dependency` | Assess compatibility, get approval, upgrade, and verify |
| `prepare-release` | Check a candidate and obtain sign-off; never publish |

Read the [catalog](docs/catalog.md) for state sequences, role bindings, costs,
input contracts, exact results, and limitations. These are starting points, not
an install-everything suite. The project orchestrator selects or adapts the ones
that fit its actual work, then records routes in the project's `.machines/README.md`.
Use the runtime's `machine-project-setup` skill for that decision and
`machine-delegation` for normal assignments. An existing worker should not repeat
setup or recursively delegate the same assignment.

## Install selected defaults into a project

Requires Node 24 or later. From this repository:

```sh
node scripts/install.mjs --list
node scripts/install.mjs --target /absolute/project \
  --workflow verify-checks --workflow implement-task --workflow review-code --dry-run

# Apply the same selected copy after inspecting the plan:
node scripts/install.mjs --target /absolute/project \
  --workflow verify-checks --workflow implement-task --workflow review-code
```

The installer copies selected definitions as `.machines/dev-<name>.ts`, plus the
small relative helper at `.machines/_machine-shop/task.ts`. Copies work after moving
the project and can be adapted locally. The `dev-` prefix avoids clobbering project
names. Identical reinstalls are no-ops; customized/conflicting files are refused
before normal writes. There is no force-overwrite option, automatic update,
implicit install-all, global installation, Agent configuration, or dependency install.
Existing instruction files, presets, and workflow maps are preserved.

A new `.machines/` directory hides ancestor catalogs. The installer refuses that
unless `--allow-shadowing` is explicitly supplied after examining the inherited
routes. It also rejects symlink destinations. For a shared-helper upgrade, compare
changes manually or install into a fresh project; never overwrite a customized
helper. A concurrent filesystem error may leave some newly created files; inspect
the printed paths before retrying. Existing files are never intentionally replaced.

Keep `.machine-runs/` out of source control in the target project. Review and save
setup changes before starting a default that requires a clean Git checkout.

## Run

Install/configure the Machines runtime separately, then discover in the target:

```sh
cd /absolute/project
machine list
machine agents
```

These commands use the target's presets. Missing named roles are intentional until
you choose real bindings; the library never installs fake presets into a live catalog.
The built-in `codex` preset is read-only, so it is suitable for review, not editing.
The `default` preset uses the locally configured Pi ACP harness; it still requires
that harness, credentials, permissions, and an authorized model budget.

Use [examples/verify.json](examples/verify.json) after replacing its workspace and
commands with actual project checks:

```sh
machine run dev-verify-checks --input-file /absolute/assignment.json
```

For an implementation, supply the complete task and real checks using the same
JSON input shape, then bind the roles to names returned by `machine agents`:

```sh
machine run dev-implement-task \
  --agent implementer=default --agent reviewer=codex \
  --input-file /absolute/assignment.json
```

This last example requires both presets to be configured and authorized; it is not
an installation or permission grant. MCP/Pi accept the same structured input.
Set launch `cwd` and input `workspace` to the same project. The coordinator must
read both the final state and JSON output, including blockers and result evidence.
A Machine that ends in `blocked` is not a successfully fulfilled software task.

Direct source execution also works without copying the defaults:

```sh
machine run /absolute/machine-shop/defaults/verify-checks.ts \
  --input-file /absolute/assignment.json
```

Runtime type imports are erased during workflow execution; the definitions do not
import a sibling runtime's private source. A runtime installation is still needed
to launch them. See the Machines runtime's authoring/integration documentation for
MCP, Pi, presets, and the public package interface.

## Local development and proof

In the Machines Org checkout, the linter, type checker, and tests can reuse the
sibling Machines development checkout and its installed dependencies:

```sh
npm run check
npm run smoke:install
```

From the umbrella, `npm run verify -- machine-shop` runs the verification Machine
and retains a check receipt. In a standalone checkout, install this repository's
development dependencies first. For runtime changes not yet published, use a built
Machines tarball rather than assuming the registry has the local version.

Tests use the real runtime, fake Agent runners, temporary Git projects, and actual
local check commands. They exercise success and failure branches, bounded retries,
Human rejection, stale candidate protection, installation conflicts, relocation,
and CLI failure exits. No paid model or production operation is needed. Live-model
instruction-following and task-solving quality are not established by these tests.

## Ticket delivery

[ticket-task.ts](ticket-task.ts) is a workflow at the repository root. It
is not one of the ten defaults and the selective installer does not install it;
run it from source or wrap it in a project Machine that supplies trusted paths
and commands. It takes one local ticket for one Git repository and carries it
from an isolated worktree to a delivered branch, patch, or draft pull request,
parking stuck work immediately by default, with an optional Human decision:

```sh
machine run /absolute/machine-shop/ticket-task.ts \
  --agent investigator=codex --agent tester=default --agent implementer=default --agent reviewer=codex \
  --input-file /absolute/ticket.json
```

Unlike the ten defaults, **it commits**: one commit on a new
`ticket/<id-slug>-<title-slug>` branch after the required checks pass and the
Machine approves the structured review. With `"output": "pr"` it also pushes that branch and opens a
pull request with `gh`, after checking with the remote that the base is already
published there.
Use it only where the assignment authorizes those effects. It never merges,
tags, force-pushes, or pushes any other ref, and never modifies the source
checkout's working tree, index, or current branch.

The ticket body must contain `## Goal`, `## Scope`, `## Acceptance`, and
`## Forbidden`, in any order and case. Goal is free text; each other section
needs at least one bullet. Scope lists permitted paths or globs, Acceptance
lists testable criteria, and Forbidden lists prohibited changes (including
`- nothing beyond the scope above`). A missing section or empty list blocks
before any Agent runs or worktree is created, including with `resume: true`.
Indented continuations and nested bullets join their parent item with single
spaces. Thematic breaks and subheadings do not count as bullets; subheadings
stay within the current section.

Before editing, `falsify` asks the investigator to show that the ticket is wrong,
already done, impossible here, or underspecified. It returns `sound` with a
one-paragraph summary or `questions` with 1–10 non-empty questions a person must
answer. Falsification questions go through the stuck policy and become numbered
`needs`, each flattened to one line and capped at 600 characters plus an ellipsis.
A sound ticket proceeds to `plan`: the investigator returns
`planned` with a plan of at most 4000 characters, recorded as stage `plan`.
In `planReview`, the reviewer approves it or requests one revision; a second
`revise` goes through the stuck policy with the reviewer's summary as the reason
and the usual capped blocker needs. Each planning report is captured before its
unchanged-worktree guard or validation; full events are saved as `<stage>-<n>.json`.
A missing or empty summary in any planning state goes through the stuck policy.
The reviewer, tester, and implementer receive the captured prose plan verbatim under `Plan:`.

By default (`redGreen: true`), a `tester` then writes acceptance tests first. The
Machine checks their paths against Scope and proves they fail using the named
`repository.redCheck` gate (default `"tests"`, which must exist in `checks`).
The implementer then makes them pass without weakening or deleting them, and
all normal gates prove green. `redGreen: false` skips the tester and red check.
After both editing stages, Scope checks record changed paths and send violations
back to the responsible Agent within `maxRepairs`. Scope supports `**` across
path segments, `*` and `?` within a segment, literal directory prefixes, and
an optional leading `./`. Evidence includes red check logs and `scope-<n>.json`.

Reviews report a verdict and evidence for each acceptance criterion, tagged
findings, and what changed since the previous round. The Machine requires
repairs for unmet criteria or blocker findings, escalates malformed reports,
non-converging repairs, and open owner questions through the stuck policy, and accepts
minor findings without another round. Minor findings from every review are
kept in `delivery.json` as `reviewNotes` and in a pull request's `## Review notes`
section, deduplicated by trimmed, case-insensitive text and location. Pull request
notes occupy one line each and omit empty locations. A reviewer `blocked` event
needs only its summary. Discussions get one implementer round. If the previous
review also had discussions, every discussion in the next review goes to the owner
together, whatever its wording, only when no criteria or blockers need repair.
Discussions after a review without any get a fresh round. Full reports are saved
as `review-<n>.json` in the evidence directory.

A stuck ticket parks by default (`stuck: "park"`): the run ends `parked`
immediately, keeping the worktree, branch, and uncommitted candidate unchanged.
It writes `park.txt` and `delivery.json` with what needs an answer and how to
resume. Failed red, scope, and green gates use `maxRepairs` (0–3, default 3);
review revisions use `maxReviewRounds` (0–5, default 2). The budgets are independent.

When either budget is exhausted, or falsification, planning, testing, implementation,
or review blocks, the `stuck` Operation chooses parking or, with `stuck: "ask"`, the Human state
`decide`. Read-only stage edits also go through this policy. Every Human prompt
and park note uses one brief helper: decision first (at most ten words), then
the ticket's standing, stopped state, reason, both budgets, evidence locations,
and options. In `decide`, `hand off` is recommended and listed first; the four
choices remain:

- `more rounds`: restart both budgets and return to the planning state that
  stopped, or to `plan` with the reviewer's feedback after a second revision.
  Otherwise return to the editing stage that stopped, the tester or the
  implementer, with the standing findings.
  It can be chosen every time a budget runs out.
- `hand off`: end `handedOff` with the worktree and branch kept, uncommitted,
  for another workflow or a person.
- `archive`: commit what delivery would have committed and keep that commit as
  the branch `archive/<slug>`, where `<slug>` is what follows `ticket/` in the
  ticket branch name, then remove the worktree and delete the ticket branch;
  ends `abandoned`. Ignored files are not kept, exactly as they are not
  delivered. An archive branch that already exists, or a candidate that does
  not differ from its base commit, ends `blocked` with nothing removed. The
  workflow never deletes an archive branch.
- `discard`: remove the worktree and delete the branch without saving anything;
  ends `abandoned`. Nothing is removed until a second Human state,
  `confirmDiscard`, is answered `confirm discard`; `go back` returns to the
  decision unchanged.

Failures while preparing the worktree, committing, or delivering still end
`blocked` without asking. `"resume": true` starts a new run in the uncommitted
worktree a park or `hand off` left behind, with fresh budgets and without rerunning
setup. A resumed worktree with no uncommitted change starts again at `falsify`,
then plans, reviews the plan, and tests the current ticket before implementation.
A worktree with a candidate skips planning and the tester and goes straight to
scope checks, verification, review, commit, rebase, and delivery. The
base branch may have moved forward in the meantime: the ticket branch must point
at the base commit or an ancestor of it, with no commit of its own.

After `commit`, the `rebase` Operation resolves the current base in the source
checkout (its HEAD when no base is named). An unchanged or unresolvable base
continues to delivery. A forward move replays exactly the ticket commit onto
the new tip. The same patch runs setup again, then the gates as `reverify`;
a changed patch is undone on the new tip and goes through verification and a
fresh review. Failed `reverify` gates return to the normal repair loop; the
review after repair is a first review of the new patch for convergence and
discussion escalation, without comparisons to reports from before the rebase. When the
run changes base, `delivery.json` includes a `rebasedFrom` field, `{ baseCommit, commit }`,
with the starting base and first approved commit. In `pr` mode the new tip must
already be published on the recorded pull request base before replay.

For every new stop, the run never stops with the workflow's commit on the ticket
branch: it undoes that commit and keeps the candidate uncommitted, clearing the
recorded commit. Conflicts, a base already holding the change, and unpublished
tips restore the original base and go through `stuck`; a failed setup keeps the
candidate on the new tip and also goes through `stuck`. Restoring the original
candidate removes later untracked outputs under the approved tree's ignore
rules, keeping files those rules ignore, `.machine-runs/`, and nested Git
repositories. This includes setup outputs only the tip ignored, so resuming an
ignore stop reaches `rebase` again with the same reason until the candidate or
ignore rules are reconciled. Resume alone repeats a
conflict until someone ports the candidate in the worktree. A rewritten or
moved-back base ends `blocked` for delivery by hand; `adopt` still refuses resume
when the branch's base is not an ancestor of the current tip. See the catalog
for recovery details and conservative stops.

To resume parked work: add the answer to the ticket body, then run the ticket
again with `resume: true`. The hold summary starts `Parked on <branch>:`, uses
the note's first line and `Needs: ...`, and ends with `Worktree kept at ...`
and `Evidence: <directory>`. `delivery.json` records `outcome: "parked"`, the
reason, and `park: { needs, next, budgets: { repairs: { used, max }, reviewRounds:
{ used, max } } }`. `result.json` records cumulative `repairs` and `reviewRounds`.
For open review or falsification questions, `park.questions` is the report's
ordered array of `{text, where}`; falsification questions use an empty `where`.
The reason and `park.needs` list every question on its own
numbered line with its location; needs cap each question's flattened text separately at 600
characters plus an ellipsis, keeping its location. The reason stays full. The
one-line hold uses `Needs: N open questions; the first: <text> (<where>)`, with
the same cap on that first question. Empty locations omit the parentheses.

The run ends `delivered`, `parked`, `handedOff`, `abandoned`, or `blocked`, and its output
is always exactly `{ "action": "hold", "summary": "..." }` so a Machines Dispatch
ticket stays open until a person merges or closes it. The workflow never
relaunches itself or another Machine and never edits a ticket. See the
[catalog](docs/catalog.md#ticket-delivery) for the input contract, evidence, and
limits.

## ChatGPT thread

[chatgpt-thread.ts](chatgpt-thread.ts) is a root workflow that keeps one ChatGPT
web chat going through Human replies. It is not one of the ten defaults and the
selective installer does not install it; run it from source. Its input is text:

```sh
# Start a fresh chat for a task in the current directory:
machine run /absolute/machine-shop/chatgpt-thread.ts "Add a health endpoint"

# Or adopt an existing conversation; nothing is sent until you reply:
machine run /absolute/machine-shop/chatgpt-thread.ts "https://chatgpt.com/c/<id>"
```

After each rig-bridge handoff a Human state shows its reason and summary and the
conversation URL. Any reply is sent to the chat unchanged; `done` ends the run,
whose output is the conversation URL and the last handoff reason and summary. A
reply that fails comes back to the Human state with the error and the reply
quoted, and is never resent automatically.

It needs the `chatgpt-web` Agent, a running rig-bridge, and a signed-in
automation browser profile. **It types into your own ChatGPT account**: the task
and every reply are submitted as you, in a real browser, and count against that
account. Run it only where that is intended. The package
`@dna113p/machines/chatgpt-web` must resolve from this checkout for replies to
be sent. See the [catalog](docs/catalog.md#chatgpt-thread) for states,
requirements, and limits.

## Other root workflows

One more root definition takes plain text input: [smoke.ts](smoke.ts), one
instant no-model Operation. The selective installer does not install it.

The earlier `implement-review` and `worktree-task` definitions were removed:
both left verification to the Agent's own word. `implement-task` runs the
supplied gates in place, and `ticket-task` owns the worktree, the gates, and
delivery for isolated work.
