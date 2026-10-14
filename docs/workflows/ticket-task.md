# ticket-task

Carry one local ticket from its own worktree to a delivered branch, patch, or
pull request.

The big one. Planning is read-only, tests come first by default, and the
Machine, not the reviewer, decides whether a review passed. Unlike the defaults,
**it commits**, and with `"output": "pr"` it pushes its own branch and opens a
pull request. It never merges, tags, force-pushes, or touches the source
checkout's working tree. A stuck run parks by default: it stops at once, keeps
the worktree, and writes `park.txt` saying what it needs.

It runs from source; the installer never copies it.

| | |
| --- | --- |
| Agent roles | `investigator`, `tester`, `implementer`, `reviewer` |
| Agent calls, at most | 16 at the default budgets with a stable base; 9 with both budgets at 0 |
| Checkout | its own new worktree; the source checkout is left alone |
| Source | [ticket-task.ts](../../ticket-task.ts) |

## Input

```json
{
  "ticket": {"id": "PROJ-12", "title": "Add the empty state", "body": "## Goal\n…\n## Scope\n- src/widgets/**\n## Acceptance\n- …\n## Forbidden\n- nothing beyond the scope above"},
  "repository": {
    "name": "widgets",
    "path": "/absolute/widgets",
    "base": "main",
    "setup": [{"name": "install", "command": ["npm", "ci"], "timeoutMs": 300000}],
    "checks": [{"name": "tests", "command": ["npm", "test"], "timeoutMs": 120000}],
    "output": "pr"
  },
  "worktreeRoot": "/absolute/worktrees",
  "evidenceRoot": "/absolute/project"
}
```

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ticket.id` | yes | — | Becomes the branch `ticket/<id>-<title>` and the worktree name. |
| `ticket.title` | yes | — | The commit subject and pull request title. |
| `ticket.body` | yes | — | Markdown with `## Goal`, `## Scope` (paths or globs the change may touch), `## Acceptance` (testable criteria), and `## Forbidden`. A missing section blocks before any Agent runs. |
| `repository.name` | yes | — | One path segment, used in the worktree name. |
| `repository.path` | yes | — | Absolute path to the source checkout root. |
| `repository.base` | no | its HEAD | Branch or ref to start from and rebase onto. |
| `repository.setup` | no | none | Commands run in the new worktree before any Agent, such as `npm ci`. Same shape as `checks`. |
| `repository.checks` | yes, 1–20 | — | The gates, as `{ name, command, timeoutMs }` with `command` an argv array. |
| `repository.redCheck` | no | `"tests"` | The check that must fail after the tester and pass after the implementer. |
| `repository.output` | yes | — | `branch`, `patch`, or `pr`. |
| `repository.remote` | no | `"origin"` | Where `pr` mode pushes. |
| `repository.draft` | no | `true` | Whether `pr` mode opens a draft. |
| `worktreeRoot` | yes | — | Absolute directory for the worktree, outside the repository. |
| `evidenceRoot` | yes | — | Absolute directory for run evidence, outside the repository and worktree. |
| `maxRepairs` | no | `3` | Rounds for a failed scope, red, or green gate, 0–3. |
| `maxReviewRounds` | no | `2` | Rounds for a `revise` review, 0–5. |
| `redGreen` | no | `true` | Write failing tests first. `false` skips the tester and the red check. |
| `assume` | no | `false` | Let `falsify` answer questions whose cautious answer loses nothing, and record them, instead of stopping. |
| `stuck` | no | `"park"` | `"park"` stops at once; `"ask"` waits for a person to choose more rounds, hand off, archive, or discard. |
| `resume` | no | `false` | Pick up the worktree a park or hand-off left, or a delivered commit whose worktree is gone. |

## Flow

🤖 Agent · ⚙️ Operation · 🧪 check gate · 🙋 Human · ⭘ end ([key](README.md#reading-the-diagrams))

To keep the picture small, two kinds of edge are left out. An Agent that
blocks, and a planning or review result that cannot go on, both go to ⏸ stuck.
A setup, commit, or delivery failure ends ⛔ blocked.

```mermaid
%%{init: {"themeVariables": {"fontSize": "13px"}, "flowchart": {"nodeSpacing": 16, "rankSpacing": 26, "padding": 6, "diagramPadding": 4}}}%%
flowchart TD
  shape["⚙️ <b>shape</b><br/>all four sections?"]
  prepare["⚙️ <b>prepare</b><br/>worktree, branch, setup"]
  falsify(["🤖 <b>falsify</b> · investigator<br/>is the ticket wrong or vague?"])
  falsifyResult["⚙️ <b>falsifyResult</b><br/>questions stop, or are assumed"]
  plan(["🤖 <b>plan</b> · investigator<br/>4000 characters at most"])
  planResult["⚙️ <b>planResult</b><br/>too long? sent back once"]
  planReview(["🤖 <b>planReview</b> · reviewer"])
  planReviewResult["⚙️ <b>planReviewResult</b><br/>one revision allowed"]
  test(["🤖 <b>test</b> · tester<br/>a failing test per criterion"])
  scopeAfterTest{{"🧪 <b>scopeAfterTest</b><br/>only Scope paths touched?"}}
  red{{"🧪 <b>red</b><br/>new tests must fail"}}
  change(["🤖 <b>change</b> · implementer<br/>makes the tests pass"])
  scopeAfterChange{{"🧪 <b>scopeAfterChange</b>"}}
  verify{{"🧪 <b>verify</b><br/>the repository's gates"}}
  review(["🤖 <b>review</b> · reviewer<br/>criteria and tagged findings"])
  reviewResult["⚙️ <b>reviewResult</b><br/>the Machine judges it"]
  reviewBudget["⚙️ <b>reviewBudget</b><br/>maxReviewRounds, default 2"]
  repairBudget["⚙️ <b>repairBudget</b><br/>maxRepairs, default 3"]
  repairTarget["⚙️ <b>repairTarget</b><br/>to the stage that stopped"]
  commit["⚙️ <b>commit</b>"]
  rebase["⚙️ <b>rebase</b><br/>replays onto a moved base"]
  deliver["⚙️ <b>deliver</b><br/>branch, patch, or pull request"]
  delivered(("✅ delivered"))
  blocked(("⛔ blocked"))
  stuck(("⏸ stuck"))

  shape -->|prepared| prepare
  shape -->|"missing sections"| blocked
  prepare -->|prepared| falsify
  prepare -->|"resumed with edits"| scopeAfterChange
  prepare -->|redeliver| rebase
  falsify --> falsifyResult
  falsifyResult -->|"malformed, once"| falsify
  falsifyResult -->|"sound, or assumed"| plan
  falsifyResult -->|"open questions"| stuck
  plan --> planResult
  planResult -->|shorten| plan
  planResult -->|planned| planReview --> planReviewResult
  planReviewResult -->|revise| plan
  planReviewResult -->|approved| test
  planReviewResult -.->|"approved, redGreen off"| change
  test --> scopeAfterTest
  scopeAfterTest -->|passed| red
  red -->|"proved red"| change
  change --> scopeAfterChange
  scopeAfterChange -->|passed| verify
  verify -->|passed| review --> reviewResult
  reviewResult -->|revise| reviewBudget
  reviewBudget -->|retry| change
  reviewResult -->|approved| commit --> rebase
  rebase -->|"current, or rebased"| deliver --> delivered
  rebase -->|"patch changed"| verify
  scopeAfterTest & red & scopeAfterChange & verify -->|failed| repairBudget
  rebase -->|"gates failed"| repairBudget
  repairBudget -->|retry| repairTarget
  repairTarget --> test & change
  repairBudget & reviewBudget -->|exhausted| stuck

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef gate fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef no fill:#fde68a,stroke:#b45309,color:#0f172a
  class falsify,plan,planReview,test,change,review agent
  class shape,prepare,falsifyResult,planResult,planReviewResult,reviewResult,reviewBudget,repairBudget,repairTarget,commit,rebase,deliver op
  class scopeAfterTest,red,scopeAfterChange,verify gate
  class delivered good
  class blocked bad
  class stuck no
```

### When stuck

By default the run parks. With `"stuck": "ask"`, a person decides instead.

```mermaid
%%{init: {"themeVariables": {"fontSize": "13px"}, "flowchart": {"nodeSpacing": 16, "rankSpacing": 26, "padding": 6, "diagramPadding": 4}}}%%
flowchart LR
  stuck["⚙️ <b>stuck</b>"]
  park["⚙️ <b>park</b><br/>writes park.txt"]
  decide[/"🙋 <b>decide</b><br/>more rounds, hand off,<br/>archive, or discard"/]
  confirmDiscard[/"🙋 <b>confirmDiscard</b><br/>a second yes before deleting"/]
  archive["⚙️ <b>archive</b><br/>keeps an archive branch"]
  remove["⚙️ <b>remove</b><br/>deletes worktree and branch"]
  again(["↩ the stage that stopped,<br/>with fresh budgets"])
  parked(("🅿️ parked"))
  handedOff(("🤝 handedOff"))
  abandoned(("🗑️ abandoned"))

  stuck -->|park| park --> parked
  stuck -->|ask| decide
  decide -->|"more rounds"| again
  decide -->|"hand off"| handedOff
  decide -->|archive| archive --> remove
  decide -->|discard| confirmDiscard
  confirmDiscard -->|"confirm discard"| remove
  confirmDiscard -->|"go back"| stuck
  remove --> abandoned

  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef human fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef no fill:#fde68a,stroke:#b45309,color:#0f172a
  classDef back fill:#dbeafe,stroke:#2563eb,color:#0f172a,stroke-dasharray:4 3
  class stuck,park,archive,remove op
  class decide,confirmDiscard human
  class parked,handedOff,abandoned no
  class again back
```

## Results

The output is always `{ "action": "hold", "summary": "…" }`, so a Machines
Dispatch ticket stays open until a person merges or closes it. `delivery.json`
in the evidence folder records the outcome, branch, commit, and anything assumed.

- ✅ **`delivered`**: committed and delivered as a branch, patch, or pull request.
- 🅿️ **`parked`**: stuck; the worktree is kept and `park.txt` says what is needed.
  Answer in the ticket and run again with `"resume": true`.
- 🤝 **`handedOff`**: a person chose to hand the uncommitted work to someone else.
- 🗑️ **`abandoned`**: archived to `archive/<slug>` and removed, or discarded after a second confirmation.
- ⛔ **`blocked`**: the ticket's shape, setup, commit, or delivery failed.

The catalog's [ticket delivery](../catalog.md#ticket-delivery) section has the
resume rules, evidence files, and every stop.
