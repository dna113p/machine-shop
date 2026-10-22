# Software workflow catalog

These are selectable starting points, not a mandatory process for every project.
The project orchestrator chooses and adapts the useful subset, supplies actual
acceptance criteria and commands, and validates the results. Do not run all twelve
for one task. Small direct changes can remain direct.

## Defaults

Each workflow also has [its own page](workflows/README.md) with its input and a
diagram of its states.
Names below are source names in `defaults/`. Installation adds the `dev-` prefix to the eleven selectable defaults
so these do not replace project-specific names such as `verify`. The twelfth,
`audit-project`, runs only from this checkout and is absent from `available`.

| Machine | State sequence | Required Agent roles | Maximum Agent calls, default repair budget |
| --- | --- | --- | --- |
| [verify-checks](../defaults/verify-checks.ts) | local checks -> receipt | none | 0 |
| [implement-task](../defaults/implement-task.ts) | implement -> checks -> review; bounded repair -> checks -> review | implementer, reviewer | 8 |
| [fix-bug](../defaults/fix-bug.ts) | regression test -> prove red -> fix -> prove green -> checks -> review; bounded repair | tester, implementer, reviewer | 10 |
| [refactor](../defaults/refactor.ts) | green baseline -> behavior-preserving change -> checks -> review; bounded repair | implementer, reviewer | 8 |
| [add-tests](../defaults/add-tests.ts) | green baseline -> focused tests -> checks -> review; bounded repair | tester, reviewer | 8 |
| [review-code](../defaults/review-code.ts) | read-only review -> unchanged-checkout guard -> findings receipt | reviewer | 2 |
| [audit-project](../defaults/audit-project.ts) | inventory -> judge -> report -> Human decision -> apply -> discovery | analyst | 2 |
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

Ticket recovery, stop evidence and replay policy are documented in
[ticket-task](workflows/ticket-task.md#continuing-a-stop).

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
new stage entry begins. Retrospective keeps its existing single retry through
the repair budget, with the fault in its existing feedback. All other
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

## Project audit

[audit-project](workflows/audit-project.md) accepts `{ project, apply?, since? }`.
It inventories instructions, scripts/CI, definitions and their provenance, preset
capabilities, runtime versions and recent run outcomes/stops. One analyst proposes
selective installs, safe refreshes, routing and gate findings. A schema fault gets
one send-back; a second ends refused. Without `apply: true`, Human acceptance gates
all setup writes. Skip retains the page without changing the checkout.

The audit reads the catalog and installer relative to its own checkout. The installer
copies selected defaults and their transitive helpers, records each file’s hash and
version in `.machines/_machine-shop/manifest.json`, and refuses modified or
unknown-provenance refreshes. Apply changes only selected
`.machines/` files, the marked README routes and absent bindings; other findings
stay on the page. Only the audit's own run-evidence directory is written before
acceptance. Discovery gates completion. This is also setup for an empty project;
it neither reads Drip nor installs runtime dependencies. The checkout supplies the current catalog;
there is no network release check. See the workflow page for input, schema,
preservation rules and refusal/partial-effect receipts.

## Common input

Except for retrospective and audit-project’s separate inputs above, the defaults accept a JSON object through MCP/Pi, `--input-file`, or a JSON
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

[ticket-task](workflows/ticket-task.md) carries a local ticket from an isolated worktree through
planning, tests, checks and review to a committed branch, patch, or pull request.
Its single `stuck` question retains evidence and returns the owner's answer to
the saved origin. Paths outside scope ask for inclusion or reversion immediately,
without automatic repair rounds; owner inclusions survive resume. The workflow
page documents inputs, budgets, resume and endings.

## ChatGPT thread

[chatgpt-thread](../chatgpt-thread.ts) is a separate root workflow, not one of
the twelve defaults: it is not in `defaults/`, the installer does not copy it, and
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
all twelve success paths, failure and rejection paths, red/green requirements,
repair budgets, stale verification, source-integrity guards, malformed inputs,
command errors, and result retrieval. `npm run smoke:install` covers selective
installation, conflicts, relocation, discovery, and the real CLI. Ticket delivery
is tested the same way for each output mode, with a local bare repository as the
remote and a recording `gh` stand-in; no network or real `gh` is used. The
ChatGPT thread is tested with a fake `chatgpt-web` runner and an injected
continue function; no browser, rig-bridge, or ChatGPT account is used. These tests
do not prove that a live model follows the instructions or solves a software task.
