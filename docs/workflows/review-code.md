# review-code

Review code or a diff and return findings, without editing anything.

One reviewer call. It works on a dirty checkout, since that is often what is being reviewed. The checkout is fingerprinted before and after, so a reviewer that edits a file blocks the run. `done` means the report was delivered, not that the code is free of bugs.

| | |
| --- | --- |
| Agent roles | `reviewer` |
| Agent calls, at most | 1 |
| Checkout | dirty is fine; it must stay unchanged |
| Source | [review-code.ts](../../defaults/review-code.ts) |

## Input

A JSON object, given with `--input-file`, as a JSON string, or through MCP or Pi.
Unknown fields are refused.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `task` | yes | — | What to do, with enough scope and acceptance criteria to act without your conversation. At most 20,000 characters. |
| `workspace` | yes | — | Absolute path to the project's Git checkout root, not a subdirectory. |
| `checks` | no | — | Not accepted: this workflow edits nothing and runs no checks. Use [verify-checks](verify-checks.md) for that. |

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
flowchart LR
  start["⚙️ <b>start</b><br/>fingerprints the checkout,<br/>dirty or not"]
  review(["🤖 <b>review</b> · reviewer<br/>findings with paths, lines,<br/>and impact"])
  integrity["⚙️ <b>integrity</b><br/>same fingerprint as before?"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))

  start --> review
  review -->|reviewed| integrity
  review -->|blocked| blocked
  integrity -->|unchanged| done
  integrity -->|"changed: reviewer edited"| blocked

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  class review agent
  class start,integrity op
  class done good
  class blocked bad
```

## Results

Every end writes `.machine-runs/machine-shop/<id>/result.json` and returns the
same JSON: `outcome`, `checksPassed`, repairs, Agent calls, check exit codes and
log paths, and each stage's summary.

- ✅ **`done`**, `outcome: completed`: the findings are in the reviewer's summary.
- ⛔ **`blocked`**, `outcome: blocked`: the reviewer could not assess it, or the checkout changed.

Read the final state and `outcome`, not only the exit code. The catalog's
[results](../catalog.md#human-decisions-and-results) section has every field.
