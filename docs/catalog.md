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
installation, conflicts, relocation, discovery, and the real CLI. These tests do
not prove that a live model follows the instructions or solves a software task.
