# investigate

Diagnose a bug or answer a technical question, then have the answer challenged.

A diagnosis has to survive a skeptic before it is reported. The investigator reads the code and primary sources and returns evidence, alternatives, and the smallest next experiment. A reviewer then checks the claims against the source. Missing evidence sends it back within the repair budget. Nothing is edited.

| | |
| --- | --- |
| Agent roles | `investigator`, `reviewer` |
| Agent calls, at most | 4 at the default budget |
| Checkout | dirty is fine; it must stay unchanged |
| Source | [investigate.ts](../../defaults/investigate.ts) |

## Input

A JSON object, given with `--input-file`, as a JSON string, or through MCP or Pi.
Unknown fields are refused.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `task` | yes | — | What to do, with enough scope and acceptance criteria to act without your conversation. At most 20,000 characters. |
| `workspace` | yes | — | Absolute path to the project's Git checkout root, not a subdirectory. |
| `checks` | no | — | Not accepted: this workflow edits nothing and runs no checks. Use [verify-checks](verify-checks.md) for that. |
| `maxRepairs` | no | `1` | How many more rounds a failed check or a `revise` review may get, 0–3. |

From [examples/review.json](../../examples/review.json):

```json
{
  "task": "Review the current diff for concrete correctness and regression risks. Cite file/line evidence; leave files unchanged.",
  "workspace": "/absolute/project"
}
```

## Flow

🤖 Agent · ⚙️ Operation · 🧪 check gate · 🙋 Human · ⭘ end ([key](README.md#reading-the-diagrams))

```mermaid
flowchart TD
  start["⚙️ <b>start</b><br/>fingerprints the checkout"]
  investigate(["🤖 <b>investigate</b> · investigator<br/>evidence, alternatives, and the<br/>smallest next experiment"])
  integrity["⚙️ <b>researchIntegrity</b><br/>nothing was edited?"]
  challenge(["🤖 <b>challenge</b> · reviewer<br/>checks claims against the source;<br/>fact or assumption?"])
  result["⚙️ <b>challengeResult</b>"]
  budget["⚙️ <b>repairBudget</b>"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))

  start --> investigate
  investigate -->|completed| integrity
  investigate -->|blocked| blocked
  integrity -->|unchanged| challenge --> result
  integrity -->|changed| blocked
  result -->|approved| done
  result -->|"revise: missing evidence"| budget
  result -->|blocked| blocked
  budget -->|retry| investigate
  budget -->|exhausted| blocked

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  class investigate,challenge agent
  class start,integrity,result,budget op
  class done good
  class blocked bad
```

## Results

Every end writes `.machine-runs/machine-shop/<id>/result.json` and returns the
same JSON: `outcome`, `checksPassed`, repairs, Agent calls, check exit codes and
log paths, and each stage's summary.

- ✅ **`done`**, `outcome: completed`: the challenged report is delivered.
- ⛔ **`blocked`**, `outcome: blocked`: the investigator or reviewer blocked, the checkout changed, or the budget ran out.

Read the final state and `outcome`, not only the exit code. The catalog's
[results](../catalog.md#human-decisions-and-results) section has every field.
