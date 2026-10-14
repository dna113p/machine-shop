# verify-checks

Run the project's checks and keep a receipt, with no model involved.

The cheapest proof that the checks really ran: real exit codes, logs, and a receipt. A failed check also makes the run itself fail, so CI sees a nonzero exit.

| | |
| --- | --- |
| Agent roles | none |
| Agent calls, at most | 0 |
| Checkout | any directory; Git is not needed |
| Source | [verify-checks.ts](../../defaults/verify-checks.ts) |

## Input

A JSON object, given with `--input-file`, as a JSON string, or through MCP or Pi.
Unknown fields are refused.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `task` | yes | — | What to do, with enough scope and acceptance criteria to act without your conversation. At most 20,000 characters. |
| `workspace` | yes | — | Absolute path to an existing directory. |
| `checks` | yes, 1–20 | — | Commands to run, in order, as `{ name, command, timeoutMs }`. `command` is an argv array with no shell; `timeoutMs` defaults to 60000 and caps at 600000. Every check runs even after one fails. |

From [examples/verify.json](../../examples/verify.json):

```json
{
  "task": "Verify the selected project checks. Replace these example commands with actual project commands.",
  "workspace": "/absolute/project",
  "checks": [{"name": "tests", "command": ["npm", "test"], "timeoutMs": 120000}],
  "maxRepairs": 1
}
```

## Flow

🤖 Agent · ⚙️ Operation · 🧪 check gate · 🙋 Human · ⭘ end ([key](README.md#reading-the-diagrams))

```mermaid
%%{init: {"themeVariables": {"fontSize": "13px"}, "flowchart": {"nodeSpacing": 16, "rankSpacing": 26, "padding": 6, "diagramPadding": 4}}}%%
flowchart LR
  start["⚙️ <b>start</b>"]
  verify{{"🧪 <b>verify</b><br/>runs every check"}}
  checkFailure["⚙️ <b>checkFailure</b><br/>saves receipt, fails the run"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))

  start --> verify
  verify -->|passed| done
  verify -->|failed| checkFailure --> blocked

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef gate fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  class start,checkFailure op
  class verify gate
  class done good
  class blocked bad
```

## Results

Every end writes `.machine-runs/machine-shop/<id>/result.json` and returns the
same JSON: `outcome`, `checksPassed`, repairs, Agent calls, check exit codes and
log paths, and each stage's summary.

- ✅ **`done`**, `outcome: completed`: every check passed.
- ⛔ **`blocked`**, `outcome: blocked`: a check failed; the receipt is saved, then the run fails.

Read the final state and `outcome`, not only the exit code. The catalog's
[results](../catalog.md#human-decisions-and-results) section has every field.
