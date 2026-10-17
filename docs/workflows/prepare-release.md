# prepare-release

Check a release candidate and get a person's sign-off. It never publishes.

The checks run first. A reviewer then drafts release notes and a readiness checklist without editing any file, and a person signs off. Approval does not tag, push, publish, or deploy anything.

| | |
| --- | --- |
| Agent roles | `reviewer` |
| Agent calls, at most | 2 |
| Checkout | clean |
| Source | [prepare-release.ts](../../defaults/prepare-release.ts) |

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
| `checks` | yes, 1–20 | — | Commands to run, in order, as `{ name, command, timeoutMs }`. `command` is an argv array with no shell; `timeoutMs` defaults to 60000 and caps at 600000. Every check runs even after one fails. |

From [examples/release.json](../../examples/release.json):

```json
{
  "task": "Assess the explicitly specified release candidate and draft its checklist and release notes. Do not publish.",
  "workspace": "/absolute/project",
  "checks": [{"name": "tests", "command": ["npm", "test"], "timeoutMs": 120000}],
  "maxRepairs": 1
}
```

## Flow

🤖 Agent · ⚙️ Operation · 🧪 check gate · 🙋 Human · ⭘ end ([key](README.md#reading-the-diagrams))

```mermaid
%%{init: {"themeVariables": {"fontSize": "13px"}, "flowchart": {"nodeSpacing": 16, "rankSpacing": 26, "padding": 6, "diagramPadding": 4}}}%%
flowchart TD
  start["⚙️ <b>start</b><br/>needs a clean checkout"]
  verify{{"🧪 <b>verify</b>"}}
  review(["🤖 <b>review</b> · reviewer<br/>drafts notes and checklist"])
  result["⚙️ <b>reviewResult</b>"]
  approval[/"🙋 <b>approval</b><br/>sign off on the candidate?"/]
  done(("✅ completed"))
  blocked(("⛔ blocked"))
  rejected(("🚫 rejected"))

  start --> verify
  verify -->|passed| review
  verify -->|failed| blocked
  review -->|approved| result
  review -->|"blocked: evidence too thin"| blocked
  result -->|approved| approval
  result -->|"blocked, or checkout changed"| blocked
  approval -->|approve| done
  approval -->|reject| rejected

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef gate fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef human fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef no fill:#fde68a,stroke:#b45309,color:#0f172a
  class review agent
  class start,result op
  class verify gate
  class approval human
  class done good
  class blocked bad
  class rejected no
```

## Results

Every end writes `.machine-runs/machine-shop/<id>/result.json` and returns the
same JSON: `outcome`, `checksPassed`, repairs, Agent calls, check exit codes and
log paths, and each stage's summary.

- ✅ **`done`**, `outcome: completed`: checks passed, the reviewer found it ready, and the person approved.
- ⛔ **`blocked`**, `outcome: blocked`: a check failed, the evidence was too thin, or the candidate changed while waiting.
- 🚫 **`rejected`**, `outcome: rejected`: the person said `reject`. Nothing is inferred from silence.

Read the final state and `outcome`, not only the exit code. The catalog's
[results](../catalog.md#human-decisions-and-results) section has every field.
