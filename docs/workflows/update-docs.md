# update-docs

Update documentation or examples and check them against the source.

A writer reads the source of truth and checks every command and API name it documents. The checks you supply (a doc build, a link check, runnable examples) gate it, and the reviewer compares the docs with the code.

| | |
| --- | --- |
| Agent roles | `writer`, `reviewer` |
| Agent calls, at most | 4 at the default budget |
| Checkout | clean |
| Source | [update-docs.ts](../../defaults/update-docs.ts) |

## Input

A JSON object, given with `--input-file`, as a JSON string, or through MCP or Pi.
Unknown fields are refused.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `task` | yes | — | What to do, with enough scope and acceptance criteria to act without your conversation. At most 20,000 characters. |
| `workspace` | yes | — | Absolute path to the project's Git checkout root, not a subdirectory. |
| `checks` | yes, 1–20 | — | Commands to run, in order, as `{ name, command, timeoutMs }`. `command` is an argv array with no shell; `timeoutMs` defaults to 60000 and caps at 600000. Every check runs even after one fails. |
| `maxRepairs` | no | `1` | How many more rounds a failed check or a `revise` review may get, 0–3. |

From [examples/implementation.json](../../examples/implementation.json):

```json
{
  "task": "Implement the requested behavior, with acceptance criteria and scope supplied by the orchestrator.",
  "workspace": "/absolute/project",
  "checks": [{"name": "tests", "command": ["npm", "test"], "timeoutMs": 120000}],
  "maxRepairs": 1
}
```

## Flow

🤖 Agent · ⚙️ Operation · 🧪 check gate · 🙋 Human · ⭘ end ([key](README.md#reading-the-diagrams))

```mermaid
flowchart TD
  start["⚙️ <b>start</b><br/>refuses a dirty checkout"]
  change(["🤖 <b>change</b> · writer<br/>reads the source of truth and<br/>checks every command it documents"])
  verify{{"🧪 <b>verify</b><br/>the supplied checks"}}
  seal["⚙️ <b>sealReview</b>"]
  review(["🤖 <b>review</b> · reviewer<br/>do the docs match the code?"])
  result["⚙️ <b>reviewResult</b>"]
  budget["⚙️ <b>repairBudget</b>"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))

  start --> change
  change -->|completed| verify
  change -->|blocked| blocked
  verify -->|passed| seal --> review --> result
  verify -->|failed| budget
  result -->|approved| done
  result -->|revise| budget
  result -->|"blocked, or checkout changed"| blocked
  budget -->|retry| change
  budget -->|exhausted| blocked

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef gate fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  class change,review agent
  class start,seal,result,budget op
  class verify gate
  class done good
  class blocked bad
```

## Results

Every end writes `.machine-runs/machine-shop/<id>/result.json` and returns the
same JSON: `outcome`, `checksPassed`, repairs, Agent calls, check exit codes and
log paths, and each stage's summary.

- ✅ **`done`**, `outcome: completed`: checks passed and the reviewer approved.
- ⛔ **`blocked`**, `outcome: blocked`: an Agent blocked or the budget ran out.

Read the final state and `outcome`, not only the exit code. The catalog's
[results](../catalog.md#human-decisions-and-results) section has every field.
