# Workflow diagrams

One diagram per Machine in this repository, drawn from the state names in the
source. The [catalog](catalog.md) has the inputs, results, and limits; this page
shows how a run moves. Nodes carry a short note where the name alone does not
say what the state does.

| Shape | Kind | What it means |
| --- | --- | --- |
| 🤖 rounded | Agent | A model call through a bound role. Its word is never the last word. |
| ⚙️ box | Operation | Plain code: bookkeeping, Git, budgets, judging a report. |
| 🧪 hexagon | Check gate | Runs real commands and keeps their exit codes and logs. |
| 🙋 slanted | Human | Waits for a person's choice. A Machine never invents one. |
| circle | End | Every end of a default writes `result.json` in the evidence folder. |

The defaults share one idea: an Agent edits, the Machine checks, another Agent
reviews a *sealed* checkout, and a small repair budget decides whether to try
again. Read-only stages are fingerprinted before and after, so a reviewer that
edits a file blocks the run instead of slipping a change through.

- [verify-checks](#verify-checks)
- [implement-task](#implement-task)
- [fix-bug](#fix-bug)
- [refactor](#refactor)
- [add-tests](#add-tests)
- [update-docs](#update-docs)
- [review-code](#review-code)
- [investigate](#investigate)
- [upgrade-dependency](#upgrade-dependency)
- [prepare-release](#prepare-release)
- [ticket-task](#ticket-task)
- [chatgpt-thread](#chatgpt-thread)
- [smoke](#smoke)

## verify-checks

No model at all. The cheapest way to get a receipt that the checks really ran.
[Source](../defaults/verify-checks.ts)

```mermaid
flowchart LR
  start["⚙️ <b>start</b><br/>opens the evidence folder"]
  verify{{"🧪 <b>verify</b><br/>runs every check, even<br/>after one fails"}}
  checkFailure["⚙️ <b>checkFailure</b><br/>records blocked, then fails<br/>the run loudly"]
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

## implement-task

The plain feature loop. [Source](../defaults/implement-task.ts)

```mermaid
flowchart TD
  start["⚙️ <b>start</b><br/>refuses a dirty checkout"]
  change(["🤖 <b>change</b> · implementer<br/>the feature and its tests"])
  verify{{"🧪 <b>verify</b><br/>the supplied checks"}}
  seal["⚙️ <b>sealReview</b><br/>fingerprints the checkout"]
  review(["🤖 <b>review</b> · reviewer<br/>reads the diff and check logs;<br/>edits nothing"])
  result["⚙️ <b>reviewResult</b><br/>trusts the verdict only if<br/>the seal still holds"]
  budget["⚙️ <b>repairBudget</b><br/>maxRepairs, default 1"]
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
  budget -->|retry with the feedback| change
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

## fix-bug

The bug has to be caught on camera before anyone fixes it.
[Source](../defaults/fix-bug.ts)

```mermaid
flowchart TD
  start["⚙️ <b>start</b><br/>refuses a dirty checkout"]
  write(["🤖 <b>writeRegression</b> · tester<br/>a test that reproduces the bug;<br/>no production code yet"])
  red{{"🧪 <b>proveRed</b><br/>regression must fail with the<br/>stated exit code and message"}}
  fix(["🤖 <b>fix</b> · implementer<br/>may not weaken the regression"])
  green{{"🧪 <b>proveGreen</b><br/>the same command now passes"}}
  verify{{"🧪 <b>verify</b><br/>the supplied checks"}}
  seal["⚙️ <b>sealReview</b>"]
  review(["🤖 <b>review</b> · reviewer<br/>reads red and green logs: was the<br/>cause fixed, or the test disabled?"])
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
  verify -->|passed| seal --> review --> result
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
  class start,seal,result,budget op
  class red,green,verify gate
  class done good
  class blocked bad
```

## refactor

The checks pass before the change and are the contract after it.
[Source](../defaults/refactor.ts)

```mermaid
flowchart TD
  start["⚙️ <b>start</b><br/>refuses a dirty checkout"]
  baseline{{"🧪 <b>baseline</b><br/>must be green before any edit"}}
  change(["🤖 <b>change</b> · implementer<br/>new shape, same behavior;<br/>tests are not bent to fit"])
  verify{{"🧪 <b>verify</b>"}}
  seal["⚙️ <b>sealReview</b>"]
  review(["🤖 <b>review</b> · reviewer"])
  result["⚙️ <b>reviewResult</b>"]
  budget["⚙️ <b>repairBudget</b>"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))

  start --> baseline
  baseline -->|passed| change
  baseline -->|"failed: nothing to preserve"| blocked
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
  class baseline,verify gate
  class done good
  class blocked bad
```

## add-tests

Same shape as refactor, with a tester instead of an implementer.
[Source](../defaults/add-tests.ts)

```mermaid
flowchart TD
  start["⚙️ <b>start</b><br/>refuses a dirty checkout"]
  baseline{{"🧪 <b>baseline</b><br/>must be green before any edit"}}
  change(["🤖 <b>change</b> · tester<br/>tests that would catch a real<br/>regression; production untouched"])
  verify{{"🧪 <b>verify</b>"}}
  seal["⚙️ <b>sealReview</b>"]
  review(["🤖 <b>review</b> · reviewer<br/>are the assertions vacuous?"])
  result["⚙️ <b>reviewResult</b>"]
  budget["⚙️ <b>repairBudget</b>"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))

  start --> baseline
  baseline -->|passed| change
  baseline -->|failed| blocked
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
  class baseline,verify gate
  class done good
  class blocked bad
```

## update-docs

[Source](../defaults/update-docs.ts)

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

## review-code

One call, no edits. Works on a dirty checkout, since that is often what is being
reviewed. [Source](../defaults/review-code.ts)

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

## investigate

A diagnosis has to survive a skeptic before it is reported.
[Source](../defaults/investigate.ts)

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

## upgrade-dependency

Nothing is installed until a person approves the plan.
[Source](../defaults/upgrade-dependency.ts)

```mermaid
flowchart TD
  start["⚙️ <b>start</b><br/>refuses a dirty checkout"]
  baseline{{"🧪 <b>baseline</b><br/>green before the upgrade"}}
  sealPlan["⚙️ <b>sealPlan</b>"]
  assess(["🤖 <b>assess</b> · analyst<br/>versions from primary sources,<br/>migration, risk, rollback; no edits"])
  planIntegrity["⚙️ <b>planIntegrity</b><br/>the analyst edited nothing?"]
  approval[/"🙋 <b>approval</b><br/>approve or reject the plan"/]
  approvalIntegrity["⚙️ <b>approvalIntegrity</b><br/>nothing changed while waiting?"]
  upgrade(["🤖 <b>upgrade</b> · implementer<br/>only the approved plan"])
  verify{{"🧪 <b>verify</b>"}}
  seal["⚙️ <b>sealReview</b>"]
  review(["🤖 <b>review</b> · reviewer<br/>compares the result with the plan"])
  result["⚙️ <b>reviewResult</b>"]
  budget["⚙️ <b>repairBudget</b>"]
  done(("✅ completed"))
  blocked(("⛔ blocked"))
  rejected(("🚫 rejected"))

  start --> baseline
  baseline -->|passed| sealPlan --> assess
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
  verify -->|passed| seal --> review --> result
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
  class start,sealPlan,planIntegrity,approvalIntegrity,seal,result,budget op
  class baseline,verify gate
  class approval human
  class done good
  class blocked bad
  class rejected no
```

## prepare-release

Gets a candidate ready for a person to sign off. It never tags, pushes, or
publishes. [Source](../defaults/prepare-release.ts)

```mermaid
flowchart TD
  start["⚙️ <b>start</b><br/>refuses a dirty checkout"]
  verify{{"🧪 <b>verify</b><br/>the supplied checks"}}
  seal["⚙️ <b>sealReview</b>"]
  review(["🤖 <b>review</b> · reviewer<br/>drafts release notes and a<br/>readiness checklist"])
  result["⚙️ <b>reviewResult</b>"]
  approval[/"🙋 <b>approval</b><br/>sign off on the candidate?"/]
  done(("✅ completed"))
  blocked(("⛔ blocked"))
  rejected(("🚫 rejected"))

  start --> verify
  verify -->|passed| seal --> review
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
  class start,seal,result op
  class verify gate
  class approval human
  class done good
  class blocked bad
  class rejected no
```

## ticket-task

The big one: a local ticket carried from an isolated worktree to a delivered
branch, patch, or pull request. Planning is read-only, tests come first by
default, and the Machine, not the reviewer, decides whether a review passed.
[Source](../ticket-task.ts) · [details](catalog.md#ticket-delivery)

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

## chatgpt-thread

Keeps one ChatGPT web chat going, with a person writing every reply. It types
into your own account. [Source](../chatgpt-thread.ts) ·
[details](catalog.md#chatgpt-thread)

```mermaid
flowchart LR
  input{"input is a ChatGPT<br/>conversation URL?"}
  start(["🤖 <b>start</b> · chatgpt-web<br/>opens a fresh chat with the task"])
  reply[/"🙋 <b>reply</b><br/>shows ChatGPT's handoff;<br/>type a reply, or done"/]
  send["⚙️ <b>send</b><br/>one attempt per reply, never<br/>retried; a failure comes back here"]
  done(("✅ done"))

  input -->|no| start
  input -->|"yes: adopt it"| reply
  start --> reply
  reply -->|"any text"| send
  send -->|"sent, or unsent"| reply
  reply -->|done| done

  classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef human fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  class start agent
  class send op
  class reply human
  class done good
```

## smoke

Proves the runtime can load a definition from here. No model, no checks.
[Source](../smoke.ts)

```mermaid
flowchart LR
  run["⚙️ <b>run</b><br/>prints the input"] --> done(("✅ done"))

  classDef op fill:#f1f5f9,stroke:#64748b,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  class run op
  class done good
```
