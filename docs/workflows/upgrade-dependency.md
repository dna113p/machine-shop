# upgrade-dependency

Plan a dependency upgrade, get a person's approval, then upgrade and verify.

Nothing is installed until a person approves the plan. An analyst confirms the versions from primary sources and proposes migration steps, risks, and a rollback. A changed checkout while the plan waits for approval voids it. After approval, the implementer applies only that plan, and the result is checked and reviewed against it.

| | |
| --- | --- |
| Agent roles | `analyst`, `implementer`, `reviewer` |
| Agent calls, at most | 10 at the default budget |
| Checkout | clean |
| Source | [upgrade-dependency.ts](../../defaults/upgrade-dependency.ts) |

Malformed Agent reports use [report recovery](../catalog.md#recovery): one
send-back to the same role with the exact fault, retained in stage evidence.
The call ceiling includes these send-backs; repair and review budgets are unchanged.

## Input

A JSON object, given with `--input-file`, as a JSON string, or through MCP or Pi.
Unknown fields are refused.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `task` | yes | — | What to do, with enough scope and acceptance criteria to act without your conversation. At most 20,000 characters. |
| `workspace` | yes | — | Absolute path to the project's Git checkout root, not a subdirectory. |
| `checks` | yes, 1–20 | — | Commands to run, in order, as `{ name, command, timeoutMs }`. `command` is an argv array with no shell; `timeoutMs` defaults to 60000 and caps at 600000. Every selected check runs even after one fails. |
| `rerunFailedChecks` | no | `true` | Run each failed gate once more, alone, after all gates have run. A passing rerun is marked `flaky`, with both logs kept and no repair round used. Set `false` to require first-time passes. |
| `maxRepairs` | no | `1` | How many more rounds a failed check or a `revise` review may get, 0–3. |

From [examples/upgrade.json](../../examples/upgrade.json):

```json
{
  "task": "Assess an explicitly named dependency and target version supplied by the orchestrator; request approval before changing it.",
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
  assess(["🤖 <b>assess</b> · analyst<br/>plan from primary sources"])
  planIntegrity["⚙️ <b>planIntegrity</b><br/>checkout unchanged?"]
  approval[/"🙋 <b>approval</b><br/>approve or reject the plan"/]
  approvalIntegrity["⚙️ <b>approvalIntegrity</b><br/>nothing changed while waiting?"]
  upgrade(["🤖 <b>upgrade</b> · implementer<br/>only the approved plan"])
  verify{{"🧪 <b>verify</b>"}}
  review(["🤖 <b>review</b> · reviewer<br/>matches the plan?"])
  result["⚙️ <b>reviewResult</b>"]
  budget["⚙️ <b>repairBudget</b>"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))
  rejected(("🚫 rejected"))

  start --> baseline
  baseline -->|passed| assess
  baseline -->|failed| blocked
  assess -->|completed| planIntegrity
  assess -->|"blocked: no version evidence"| blocked
  planIntegrity -->|unchanged| approval
  planIntegrity -->|changed| blocked
  approval -->|approve| approvalIntegrity
  approval -->|reject| rejected
  approvalIntegrity -->|unchanged| upgrade
  approvalIntegrity -->|changed| blocked
  upgrade -->|completed| verify
  upgrade -->|blocked| blocked
  verify -->|passed| review --> result
  verify -->|failed| budget
  result -->|approved| done
  result -->|revise| budget
  result -->|"blocked, or checkout changed"| blocked
  budget -->|retry| upgrade
  budget -->|exhausted| blocked

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef gate fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef human fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef no fill:#fde68a,stroke:#b45309,color:#0f172a
  class assess,upgrade,review agent
  class start,planIntegrity,approvalIntegrity,result,budget op
  class baseline,verify gate
  class approval human
  class done good
  class blocked bad
  class rejected no
```

## Results

Every end writes `.machine-runs/machine-shop/<id>/result.json` and returns the
same JSON: `outcome`, `checksPassed`, repairs, Agent calls, check exit codes and
log paths, and each stage's summary.

- ✅ **`done`**, `outcome: completed`: approved, upgraded, checks passed, and the reviewer approved.
- ⛔ **`blocked`**, `outcome: blocked`: the baseline was red, the version evidence was missing, the checkout changed, or the budget ran out.
- 🚫 **`rejected`**, `outcome: rejected`: the person said `reject`. Nothing is inferred from silence.

Read the final state and `outcome`, not only the exit code. The catalog's
[results](../catalog.md#human-decisions-and-results) section has every field.
