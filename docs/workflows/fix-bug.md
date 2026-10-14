# fix-bug

Prove a bug fails, fix it, prove it passes, then run the checks and review.

The bug has to be caught on camera before anyone fixes it. A tester writes a regression test, and the Machine runs it and requires the exact failure you described. Only then may the implementer fix it, and the same command must pass afterwards. The reviewer reads both logs to make sure the fix addressed the cause and did not just disable the test.

| | |
| --- | --- |
| Agent roles | `tester`, `implementer`, `reviewer` |
| Agent calls, at most | 5 at the default budget |
| Checkout | clean |
| Source | [fix-bug.ts](../../defaults/fix-bug.ts) |

## Input

A JSON object, given with `--input-file`, as a JSON string, or through MCP or Pi.
Unknown fields are refused.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `task` | yes | — | What to do, with enough scope and acceptance criteria to act without your conversation. At most 20,000 characters. |
| `workspace` | yes | — | Absolute path to the project's Git checkout root, not a subdirectory. |
| `checks` | yes, 1–20 | — | Commands to run, in order, as `{ name, command, timeoutMs }`. `command` is an argv array with no shell; `timeoutMs` defaults to 60000 and caps at 600000. Every check runs even after one fails. |
| `maxRepairs` | no | `1` | How many more rounds a failed check or a `revise` review may get, 0–3. |
| `regression` | yes | — | The command that reproduces the bug: `{ name, command, timeoutMs, failureExitCode, failureIncludes }`. Before the fix it must exit with `failureExitCode` (1–125) and print `failureIncludes`; after the fix it must exit 0. |

From [examples/bugfix.json](../../examples/bugfix.json):

```json
{
  "task": "Fix empty-input behavior without changing other cases. The regression should assert an empty collection is returned.",
  "workspace": "/absolute/project",
  "checks": [{"name": "tests", "command": ["npm", "test"], "timeoutMs": 120000}],
  "maxRepairs": 1,
  "regression": {
    "name": "empty-input-regression",
    "command": ["node", "--test", "tests/empty-input.test.js"],
    "failureExitCode": 1,
    "failureIncludes": "empty input returns an empty collection"
  }
}
```

## Flow

🤖 Agent · ⚙️ Operation · 🧪 check gate · 🙋 Human · ⭘ end ([key](README.md#reading-the-diagrams))

```mermaid
%%{init: {"themeVariables": {"fontSize": "13px"}, "flowchart": {"nodeSpacing": 16, "rankSpacing": 26, "padding": 6, "diagramPadding": 4}}}%%
flowchart TD
  start["⚙️ <b>start</b><br/>needs a clean checkout"]
  write(["🤖 <b>writeRegression</b> · tester<br/>reproduces the bug"])
  red{{"🧪 <b>proveRed</b><br/>must fail as described"}}
  fix(["🤖 <b>fix</b> · implementer<br/>keeps the regression intact"])
  green{{"🧪 <b>proveGreen</b><br/>same command passes"}}
  verify{{"🧪 <b>verify</b>"}}
  review(["🤖 <b>review</b> · reviewer<br/>cause fixed, or test disabled?"])
  result["⚙️ <b>reviewResult</b>"]
  budget["⚙️ <b>repairBudget</b>"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))

  start --> write
  write -->|completed| red
  write -->|blocked| blocked
  red -->|"failed as promised"| fix
  red -->|"did not reproduce"| blocked
  fix -->|completed| green
  fix -->|blocked| blocked
  green -->|passed| verify
  green -->|failed| budget
  verify -->|passed| review --> result
  verify -->|failed| budget
  result -->|approved| done
  result -->|revise| budget
  result -->|"blocked, or checkout changed"| blocked
  budget -->|retry| fix
  budget -->|exhausted| blocked

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef gate fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  class write,fix,review agent
  class start,result,budget op
  class red,green,verify gate
  class done good
  class blocked bad
```

## Results

Every end writes `.machine-runs/machine-shop/<id>/result.json` and returns the
same JSON: `outcome`, `checksPassed`, repairs, Agent calls, check exit codes and
log paths, and each stage's summary.

- ✅ **`done`**, `outcome: completed`: red, then green, checks passed, and the reviewer approved.
- ⛔ **`blocked`**, `outcome: blocked`: the regression did not reproduce, an Agent blocked, or the budget ran out.

Read the final state and `outcome`, not only the exit code. The catalog's
[results](../catalog.md#human-decisions-and-results) section has every field.
