# refactor

Restructure code without changing what it does.

The checks must pass before anyone touches the code, and that green baseline is the contract afterwards. The implementer may not bend tests to fit the new shape.

| | |
| --- | --- |
| Agent roles | `implementer`, `reviewer` |
| Agent calls, at most | 14 at the default budgets |
| Checkout | clean |
| Source | [refactor.ts](../../defaults/refactor.ts) |

Malformed Agent reports use [report recovery](../catalog.md#recovery): one
send-back to the same role with the exact fault, retained in stage evidence.
The call ceiling includes these send-backs and the bounded mechanical recovery calls.

## Advisory review

The Agent decides reversible questions and reports `assumptions` as
`[{question, answer, why}]` and `scopeAdditions` as `[{path, why}]`. It runs only
tests for what it changed; the workflow runs every required check.

Review findings are `{severity, kind?, text, where}`. Only a `blocker` whose
`kind` is `acceptance`, `regression`, or `safety` requests a revision. Missing
`kind` counts as `other`; other findings are advisory. An unstructured `revise`
gets one send-back, then stands as a discussion note. `maxReviewRounds` defaults
to 1 and counts revision cycles separately from failed-check `maxRepairs`.
When review rounds run out with green checks, the result is `completed`.
`reviewNotes` holds the last findings; `needs` holds standing defects as
`{kind: "review", text, paths?}`. These fields, `assumptions`, and `scopeAdditions`
are included in the receipt even when empty.

A mechanical `blocked` can name `needs: [{kind: "baseFailing", text, check}]`.
The workflow runs only that configured check, whole and once, in a temporary
detached worktree at the start commit. Ignored dependency directories are linked
from the candidate and removed as links during cleanup. A confirmed nonzero
exit ends `blocked` with the base failure and log path, without another Agent
call. A passing or unrunnable base check returns its evidence to the Agent once.
A `needs: [{kind: "scope", text, paths}]` outside the task's `## Scope` bullets
(or without stated Scope) becomes a scope addition and returns to the Agent.
Scope recovery is allowed once per editing stage; base verification once per run.
A repeated mechanical block or a need requiring a person remains `blocked`.
The candidate is never switched in place. Direct defaults have no setup input;
a custom caller can supply setup commands through the shared runner's policy.

## Input

A JSON object, given with `--input-file`, as a JSON string, or through MCP or Pi.
Unknown fields are refused.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `task` | yes | — | What to do, with enough scope and acceptance criteria to act without your conversation. At most 20,000 characters. |
| `workspace` | yes | — | Absolute path to the project's Git checkout root, not a subdirectory. |
| `checks` | yes, 1–20 | — | Commands to run, in order, as `{ name, command, timeoutMs }`. `command` is an argv array with no shell; `timeoutMs` defaults to 60000 and caps at 600000. Every selected check runs even after one fails. |
| `rerunFailedChecks` | no | `true` | Run each failed gate once more, alone, after all gates have run. A passing rerun is marked `flaky`, with both logs kept and no repair round used. Set `false` to require first-time passes. |
| `maxRepairs` | no | `1` | Additional failed-check repairs, 0–3; independent of review revisions. |
| `maxReviewRounds` | no | `1` | Additional review revision cycles, 0–5. Green checks permit completion when exhausted. |

From [examples/implementation.json](../../examples/implementation.json):

```json
{
  "task": "Implement the requested behavior, with acceptance criteria and scope supplied by the orchestrator.",
  "workspace": "/absolute/project",
  "checks": [{"name": "tests", "command": ["npm", "test"], "timeoutMs": 120000}],
  "maxRepairs": 1
}
```

### Layered check fields

See [Common input](../catalog.md#layered-checks) for Drip's example: build first;
then types, focused tests, linked-tests, machine-tests, conditional ui and
remote-ui in one group; package-smoke after all of them.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `checks[].when` | no | `always` | 1–50 Scope path globs. Run if any changed path matches; otherwise record skipped (no changed path matched when). |
| `checks[].focused` | no | `false` | Select named or importing test files and replace a trailing glob argument. Run whole when selection is unsafe or unavailable; delivery reverify always runs whole. |
| `checks[].focusedLimit` | no | `40` | Maximum selected test files, 1–500; only with focused: true. More files runs the whole check. |
| `checks[].group` | no | `none` | Checks sharing a group run concurrently, with one log per check. Ungrouped checks remain sequential. |
| `checks[].after` | no | `[]` | Names that must finish before this check starts; skipped and failed count as finished. Names must be listed earlier in an earlier unit, or belong to the same group; cycles are refused. |
| `checks[].fastMs` | no | `90000` | Fast always-check threshold in milliseconds, 1–600000. Only without when or focused; used when selecting a repair round. |

Paths are measured from the run's start commit, including committed and local
changes. Groups run at their first member's position; other checks stay serial.
[Recovery](../catalog.md#reduced-repair-rounds) runs failed checks and fast
always-checks after failure, then a full layered round before passing. Receipts
name every round's run and skipped checks, reasons and focused files.

The baseline runs every check whole, ignoring `when` and `focused`.

## Flow

🤖 Agent · ⚙️ Operation · 🧪 check gate · 🙋 Human · ⭘ end ([key](README.md#reading-the-diagrams))

```mermaid
%%{init: {"themeVariables": {"fontSize": "13px"}, "flowchart": {"nodeSpacing": 16, "rankSpacing": 26, "padding": 6, "diagramPadding": 4}}}%%
flowchart TD
  start["⚙️ <b>start</b><br/>needs a clean checkout"]
  baseline{{"🧪 <b>baseline</b><br/>must be green first"}}
  change(["🤖 <b>change</b> · implementer<br/>new shape, same behavior"])
  verify{{"🧪 <b>verify</b>"}}
  review(["🤖 <b>review</b> · reviewer"])
  result["⚙️ <b>reviewResult</b>"]
  budget["⚙️ <b>repairBudget</b>"]
  reviews["⚙️ <b>reviewBudget</b><br/>maxReviewRounds, default 1"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))

  start --> baseline
  baseline -->|passed| change
  baseline -->|"failed: nothing to preserve"| blocked
  change -->|completed| verify
  change -->|blocked| changeBlock["⚙️ inspect mechanical need"]
  changeBlock -->|scope addition or base claim refuted/unrunnable| change
  changeBlock -->|confirmed base failure or real blocker| blocked
  verify -->|passed| review --> result
  verify -->|failed| budget
  result -->|approved| done
  result -->|actionable defect| reviews
  reviews -->|retry| change
  reviews -->|exhausted with green checks| done
  result -->|"blocked, or checkout changed"| blocked
  budget -->|retry| change
  budget -->|exhausted| blocked

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef gate fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  class change,review agent
  class start,result,budget,reviews op
  class baseline,verify gate
  class done good
  class blocked bad
```

## Results

Every end writes `.machine-runs/machine-shop/<id>/result.json` and returns the
same JSON: `outcome`, `checksPassed`, repairs, Agent calls, check exit codes and
log paths, and each stage's summary.

- ✅ **`done`**, `outcome: completed`: the baseline and final checks passed and advisory review finished.
- ⛔ **`blocked`**, `outcome: blocked`: the baseline was already red, an Agent blocked, or the failed-check repair budget ran out.

Read the final state and `outcome`, not only the exit code. The catalog's
[results](../catalog.md#human-decisions-and-results) section has every field.
