# Workflows

One page per workflow: what it does, its input, and a diagram of its states.
The [catalog](../catalog.md) has the shared input rules, results, and limits in
full.

## Defaults

The installer copies these eleven into a project on request.

| Workflow | What it does |
| --- | --- |
| [verify-checks](verify-checks.md) | Run the project's checks and keep a receipt, with no model |
| [implement-task](implement-task.md) | Implement a feature, run the checks, and review it |
| [fix-bug](fix-bug.md) | Prove a bug fails, fix it, prove it passes, and review |
| [refactor](refactor.md) | Restructure code against a passing baseline |
| [add-tests](add-tests.md) | Add tests without changing production code |
| [update-docs](update-docs.md) | Update docs and check them against the source |
| [review-code](review-code.md) | Return review findings without editing |
| [retrospective](retrospective.md) | Read ticket-run evidence and report repeated causes without changing the workspaces |
| [investigate](investigate.md) | Diagnose or research, then have the answer challenged |
| [upgrade-dependency](upgrade-dependency.md) | Plan an upgrade, get approval, upgrade, and verify |
| [prepare-release](prepare-release.md) | Check a candidate and get sign-off; never publish |

## Run from source

`audit-project` lives in `defaults/` but is never copied into projects.

| Workflow | What it does |
| --- | --- |
| [audit-project](audit-project.md) | Inventory project workflow coverage, propose routes and bindings, then apply on acceptance |
| [ticket-task](ticket-task.md) | Carry a local ticket from its own worktree to a branch, patch, or pull request |
| [chatgpt-thread](chatgpt-thread.md) | Keep one ChatGPT web chat going, with a person writing each reply |
| [smoke](smoke.md) | Prove the runtime can load a definition from here |

## Reading the diagrams

Each diagram is drawn from the state names in the source. Nodes carry a short
note where the name alone does not say what the state does, and edges are
labeled with the event that takes them. The `sealReview` and `sealPlan` states,
which only fingerprint the checkout before a read-only stage, are left out.

| Shape | Kind | What it means |
| --- | --- | --- |
| 🤖 rounded | Agent | A model call through a bound role. Its word is never the last word. |
| ⚙️ box | Operation | Plain code: bookkeeping, Git, budgets, judging a report. |
| 🧪 hexagon | Check gate | Runs real commands and keeps their exit codes and logs. |
| 🙋 slanted | Human | Waits for a person's choice. A Machine never invents one. |
| ⭘ circle | End | Where the run stops. |

Most defaults share one idea: an Agent edits, the Machine runs the checks,
another Agent reviews a *sealed* checkout, and a small repair budget decides
whether to try again. Read-only stages are fingerprinted before and after, so a
reviewer that edits a file blocks the run instead of slipping a change through.
