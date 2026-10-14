# Machine Shop

Ready-made software workflows for Machines. Each one is a TypeScript state
machine with real check gates, a small repair budget, and a JSON receipt of
what happened. Pick the few a project needs; nothing here is meant to be
installed wholesale.

This is the independent `machine-shop` repository in Machines Org. It owns
workflow policy only, not the Machines runtime, Agent harnesses, scheduling, or
`~/.machines`.

- **[Catalog](docs/catalog.md)**: inputs, results, costs, and limits for every workflow.
- **[Workflows](docs/workflows/README.md)**: a page per workflow with its input and a diagram of its states.

## The workflows

Ten defaults that the installer copies into a project on request:

| Default | Purpose |
| --- | --- |
| [`verify-checks`](docs/workflows/verify-checks.md) | Run explicit project checks without a model |
| [`implement-task`](docs/workflows/implement-task.md) | Implement a feature, verify it, and review it |
| [`fix-bug`](docs/workflows/fix-bug.md) | Prove a regression red, fix it, prove green, and review |
| [`refactor`](docs/workflows/refactor.md) | Preserve behavior against a passing baseline |
| [`add-tests`](docs/workflows/add-tests.md) | Add meaningful tests without changing production behavior |
| [`review-code`](docs/workflows/review-code.md) | Return evidence-backed review findings without edits |
| [`investigate`](docs/workflows/investigate.md) | Investigate and challenge a diagnosis or technical choice |
| [`update-docs`](docs/workflows/update-docs.md) | Update docs/examples and validate against the source |
| [`upgrade-dependency`](docs/workflows/upgrade-dependency.md) | Assess compatibility, get approval, upgrade, and verify |
| [`prepare-release`](docs/workflows/prepare-release.md) | Check a candidate and obtain sign-off; never publish |

Three more run from source and are never installed:

| Workflow | Purpose |
| --- | --- |
| [`ticket-task`](docs/workflows/ticket-task.md) | Carry a local ticket from its own worktree to a branch, patch, or pull request |
| [`chatgpt-thread`](docs/workflows/chatgpt-thread.md) | Keep one ChatGPT web chat going, with a person writing each reply |
| [`smoke`](docs/workflows/smoke.md) | One no-model step that proves the runtime can load a definition |

A project orchestrator chooses with the runtime's `machine-project-setup`
skill, records the routes in the project's `.machines/README.md`, and hands out
work with `machine-delegation`.

## Install into a project

Requires Node 24 or later. Preview the copy, then apply it:

```sh
node scripts/install.mjs --list
node scripts/install.mjs --target /absolute/project \
  --workflow verify-checks --workflow implement-task --dry-run
node scripts/install.mjs --target /absolute/project \
  --workflow verify-checks --workflow implement-task
```

- Each workflow lands as `.machines/dev-<name>.ts`, beside the helper
  `.machines/_machine-shop/task.ts`. The `dev-` prefix leaves names such as
  `verify` free for the project.
- It is safe to repeat. An identical file is a no-op; a customized or
  conflicting one is refused, never overwritten. There is no force option,
  automatic update, or install-all.
- A new `.machines/` directory hides the catalogs of parent directories, so the
  installer refuses to create one unless you pass `--allow-shadowing`. It also
  refuses symlinked destinations.
- It installs no Agents, presets, dependencies, or global configuration.
- To upgrade a helper you customized, compare by hand or install into a fresh
  project. If a filesystem error interrupts a copy, check the printed paths
  before retrying.

Keep `.machine-runs/` out of source control. Editing workflows need a clean
checkout, so commit setup changes first.

## Run

```sh
cd /absolute/project
machine list      # the workflows this project can run
machine agents    # the presets you can bind roles to
machine run dev-verify-checks --input-file /absolute/assignment.json
machine run dev-implement-task \
  --agent implementer=default --agent reviewer=codex \
  --input-file /absolute/assignment.json
```

Start from [examples/verify.json](examples/verify.json) and replace its
workspace and commands with the project's real checks. The catalog describes
the [input](docs/catalog.md#common-input).

- Bind every role to a preset that `machine agents` lists. The built-in `codex`
  preset is read-only, so it suits reviewing, not editing. `default` uses the
  local Pi ACP harness and needs its credentials and model budget.
- The launch `cwd` and the input's `workspace` must be the same project. MCP and
  Pi take the same JSON input.
- Read the final state and the JSON output, not just the exit code. A run that
  ends `blocked` did not do the task.
- A definition also runs straight from this checkout:
  `machine run /absolute/machine-shop/defaults/verify-checks.ts --input-file …`.

## Ticket delivery

[ticket-task.ts](ticket-task.ts) carries one local ticket for one Git repository
from a fresh worktree to a delivered branch, patch, or pull request. Unlike the
defaults, **it commits**, and with `"output": "pr"` it pushes its own branch and
opens a pull request. It never merges, tags, force-pushes, or touches the source
checkout's working tree.

```sh
machine run /absolute/machine-shop/ticket-task.ts \
  --agent investigator=codex --agent tester=default \
  --agent implementer=default --agent reviewer=codex \
  --input-file /absolute/ticket.json
```

The ticket body needs `## Goal`, `## Scope`, `## Acceptance`, and `## Forbidden`.
A missing section blocks before any Agent runs. A run then goes
([diagram](docs/workflows/ticket-task.md#flow)):

1. **Falsify.** An investigator tries to show the ticket is wrong, already done,
   or too vague. Open questions stop the run for the owner. With
   `"assume": true`, questions whose cautious answer loses nothing are answered
   and recorded instead.
2. **Plan and plan review.** A plan of at most 4000 characters, with one
   revision allowed.
3. **Tests first.** A tester writes failing tests for each acceptance criterion
   and the Machine proves they fail. `"redGreen": false` skips this step.
4. **Implement.** A change outside the ticket's Scope is sent back.
5. **Gates and review.** The repository's checks, then a structured review that
   the Machine judges itself.
6. **Commit, rebase, deliver.** If the base moved, the commit is replayed onto
   it and checked again.

A stuck run parks: it stops at once, keeps the worktree, and writes `park.txt`
saying what it needs. Answer in the ticket and run again with `"resume": true`.
With `"stuck": "ask"` it waits instead for a person to choose more rounds, hand
off, archive, or discard. The output is always `{ "action": "hold", … }`, so a
Machines Dispatch ticket stays open until a person merges or closes it.

Its [page](docs/workflows/ticket-task.md) lists every input field, and the
[catalog](docs/catalog.md#ticket-delivery) has the resume rules, evidence files,
and every stop.

## ChatGPT thread

[chatgpt-thread](docs/workflows/chatgpt-thread.md) keeps one ChatGPT web chat
going, sending each reply you type. **It types into your own ChatGPT account**,
in a real browser, so run it only where that is intended.

## Develop

```sh
npm run check            # lint, types, and tests
npm run smoke:install
```

From the umbrella, `npm run verify -- machine-shop` runs the same checks as a
Machine and keeps a receipt. Inside Machines Org the checks reuse the sibling
Machines checkout; a standalone checkout installs its dev dependencies first,
and runtime changes not yet published need a built Machines tarball.

Tests drive the real runtime with fake Agents, temporary Git repositories, and
real commands, so they need no paid model. They do not measure how well a live
model does the work.
