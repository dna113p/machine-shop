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

Any setup, commit, archive, or delivery failure ends ⛔ blocked; those edges are
left out to keep the picture readable.

```mermaid
flowchart TD
  subgraph setup [Setup]
    shape["⚙️ <b>shape</b><br/>has Goal, Scope,<br/>Acceptance, Forbidden?"]
    prepare["⚙️ <b>prepare</b><br/>new worktree and ticket branch,<br/>setup commands; pr mode checks<br/>the base is pushed"]
    start["⚙️ <b>start</b>"]
  end

  subgraph planning [Planning · read-only]
    falsify(["🤖 <b>falsify</b> · investigator<br/>tries to show the ticket is wrong,<br/>done already, or too vague"])
    falsifyResult["⚙️ <b>falsifyResult</b><br/>open questions stop the run;<br/>with assume on, safe ones are<br/>answered and recorded"]
    plan(["🤖 <b>plan</b> · investigator<br/>files, tests, checks;<br/>4000 characters at most"])
    planResult["⚙️ <b>planResult</b><br/>too long? sent back once"]
    planReview(["🤖 <b>planReview</b> · reviewer"])
    planReviewResult["⚙️ <b>planReviewResult</b><br/>one revision allowed"]
  end

  subgraph build [Build]
    test(["🤖 <b>test</b> · tester<br/>failing tests, one or more<br/>per acceptance criterion"])
    scopeAfterTest{{"🧪 <b>scopeAfterTest</b><br/>only Scope paths touched?"}}
    red{{"🧪 <b>red</b><br/>the new tests must fail now"}}
    change(["🤖 <b>change</b> · implementer<br/>makes the tests pass without<br/>weakening them"])
    scopeAfterChange{{"🧪 <b>scopeAfterChange</b>"}}
    verify{{"🧪 <b>verify</b><br/>the repository's gates"}}
    sealReview["⚙️ <b>sealReview</b>"]
    review(["🤖 <b>review</b> · reviewer<br/>each criterion met, with evidence;<br/>findings: blocker, discussion, minor"])
    reviewResult["⚙️ <b>reviewResult</b><br/>Machine judges the report; same<br/>blockers twice means stuck"]
    repairBudget["⚙️ <b>repairBudget</b>"]
    reviewBudget["⚙️ <b>reviewBudget</b><br/>maxReviewRounds, default 2"]
    repairTarget["⚙️ <b>repairTarget</b><br/>back to the stage that stopped"]
  end

  subgraph ship [Deliver]
    commit["⚙️ <b>commit</b>"]
    rebase["⚙️ <b>rebase</b><br/>base moved? replay and<br/>re-run the gates"]
    deliver["⚙️ <b>deliver</b><br/>branch, patch, or pull request"]
  end

  subgraph stuckZone [When stuck]
    stuck["⚙️ <b>stuck</b><br/>park by default; ask if<br/>stuck is ask"]
    park["⚙️ <b>park</b><br/>keeps the worktree and writes<br/>park.txt: what is needed"]
    decide[/"🙋 <b>decide</b><br/>more rounds, hand off,<br/>archive, or discard"/]
    confirmDiscard[/"🙋 <b>confirmDiscard</b><br/>a second yes before deleting"/]
    archive["⚙️ <b>archive</b><br/>saves the candidate on<br/>a branch of its own"]
    remove["⚙️ <b>remove</b><br/>worktree and ticket branch"]
  end

  delivered(("✅ delivered"))
  blocked(("⛔ blocked"))
  parked(("🅿️ parked"))
  handedOff(("🤝 handedOff"))
  abandoned(("🗑️ abandoned"))

  shape -->|prepared| prepare
  shape -->|"missing sections"| blocked
  prepare -->|prepared| start
  prepare -->|"resumed with edits"| scopeAfterChange
  prepare -->|"redeliver"| rebase
  start --> falsify --> falsifyResult
  falsifyResult -->|"sound, or assumed"| plan
  falsifyResult -->|"open questions"| stuck
  plan --> planResult
  planResult -->|planned| planReview
  planResult -->|shorten| plan
  planResult -->|blocked| stuck
  planReview --> planReviewResult
  planReviewResult -->|approved| test
  planReviewResult -.->|"approved, redGreen off"| change
  planReviewResult -->|revise| plan
  planReviewResult -->|blocked| stuck

  test -->|completed| scopeAfterTest
  test -->|blocked| stuck
  scopeAfterTest -->|passed| red
  scopeAfterTest -->|failed| repairBudget
  red -->|"proved red"| change
  red -->|"already passing"| repairBudget
  change -->|completed| scopeAfterChange
  change -->|blocked| stuck
  scopeAfterChange -->|passed| verify
  scopeAfterChange -->|failed| repairBudget
  verify -->|passed| sealReview --> review --> reviewResult
  verify -->|failed| repairBudget
  reviewResult -->|approved| commit
  reviewResult -->|revise| reviewBudget
  reviewResult -->|blocked| stuck
  reviewBudget -->|retry| change
  reviewBudget -->|exhausted| stuck
  repairBudget -->|retry| repairTarget
  repairBudget -->|exhausted| stuck
  repairTarget --> test
  repairTarget --> change
  repairTarget -.->|"after more rounds"| planning

  commit --> rebase
  rebase -->|"current, or rebased"| deliver
  rebase -->|"patch changed: review again"| verify
  rebase -->|"gates failed"| repairBudget
  rebase -->|stuck| stuck
  deliver -->|delivered| delivered

  stuck -->|park| park --> parked
  stuck -->|ask| decide
  decide -->|"more rounds"| repairTarget
  decide -->|"hand off"| handedOff
  decide -->|archive| archive --> remove
  decide -->|discard| confirmDiscard
  confirmDiscard -->|"confirm discard"| remove
  confirmDiscard -->|"no"| stuck
  remove --> abandoned

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef gate fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef human fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef no fill:#fde68a,stroke:#b45309,color:#0f172a
  class falsify,plan,planReview,test,change,review agent
  class shape,prepare,start,falsifyResult,planResult,planReviewResult,sealReview,reviewResult,repairBudget,reviewBudget,repairTarget,commit,rebase,deliver,stuck,park,archive,remove op
  class scopeAfterTest,red,scopeAfterChange,verify gate
  class decide,confirmDiscard human
  class delivered good
  class blocked bad
  class parked,handedOff,abandoned no
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
