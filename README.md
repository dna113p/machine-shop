# Machine Shop

Ready-made software workflows for [Machines](https://github.com/dna113p/machines). Each one is a TypeScript state
machine with real check gates, a small repair budget, and a JSON receipt of
what happened.

Pick the few a project needs. Nothing here is meant to be installed wholesale.

This is the independent `machine-shop` repository in Machines Org. It owns
workflow policy only, not the Machines runtime, Agent harnesses, scheduling or
`~/.machines`.

- **[Catalog](docs/catalog.md)**: inputs, results, costs and limits for every workflow.
- **[Workflows](docs/workflows/README.md)**: a page per workflow, with its input and a diagram of its states.

## Quick start

Needs Node 24 or later. Preview the copy, then apply it:

```sh
node scripts/install.mjs --list
node scripts/install.mjs --target /absolute/project \
  --workflow verify-checks --workflow implement-task --dry-run
node scripts/install.mjs --target /absolute/project \
  --workflow verify-checks --workflow implement-task
```

Then run from the project:

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

## The workflows

Eleven defaults that the installer copies into a project on request:

| Default | Purpose |
| --- | --- |
| [`verify-checks`](docs/workflows/verify-checks.md) | Run explicit project checks without a model |
| [`implement-task`](docs/workflows/implement-task.md) | Implement a feature, verify it, and review it |
| [`fix-bug`](docs/workflows/fix-bug.md) | Prove a regression red, fix it, prove green, and review |
| [`refactor`](docs/workflows/refactor.md) | Preserve behavior against a passing baseline |
| [`add-tests`](docs/workflows/add-tests.md) | Add meaningful tests without changing production behavior |
| [`review-code`](docs/workflows/review-code.md) | Return evidence-backed review findings without edits |
| [`retrospective`](docs/workflows/retrospective.md) | Report recurring ticket stops and automation candidates from run evidence; changes only its own evidence folder |
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

A project orchestrator chooses among them with the runtime's
`machine-project-setup` skill, records the routes in the project's
`.machines/README.md`, and hands out work with `machine-delegation`.

Malformed Agent reports get [one send-back with the exact fault](docs/catalog.md#recovery),
kept in the stage evidence, before the existing stop applies.

## Installing

- Each workflow lands as `.machines/dev-<name>.ts`, beside the helper
  `.machines/_machine-shop/task.ts`. The `dev-` prefix leaves names such as
  `verify` free for the project.
- **Safe to repeat.** An identical file is a no-op. A customized or conflicting
  one is refused, never overwritten. There is no force option, automatic
  update, or install-all.
- **No shadowing by accident.** A new `.machines/` directory hides the catalogs
  of parent directories, so the installer refuses to create one unless you pass
  `--allow-shadowing`. It also refuses symlinked destinations.
- **Nothing else.** It installs no Agents, presets, dependencies, or global
  configuration.
- **Upgrading a customized helper:** compare by hand or install into a fresh
  project. If a filesystem error interrupts a copy, check the printed paths
  before retrying.

Keep `.machine-runs/` out of source control. Editing workflows need a clean
checkout, so commit setup changes first.

## Running

- **Bind every role** to a preset that `machine agents` lists. The built-in
  `codex` preset is read-only, so it suits reviewing, not editing. `default`
  uses the local Pi ACP harness and needs its credentials and model budget.
- **One project.** The launch `cwd` and the input's `workspace` must be the
  same project. MCP and Pi take the same JSON input.
- **Read the result.** Check the final state and the JSON output, not just the
  exit code. A default ending `blocked` or a ticket ending `refused` did not
  do the task.
- **From source.** A definition also runs straight from this checkout:
  `machine run /absolute/machine-shop/defaults/verify-checks.ts --input-file …`.

## Ticket delivery

[ticket-task.ts](ticket-task.ts) carries one local ticket for one Git repository
from a fresh worktree to a delivered branch, patch, or pull request.

Unlike the defaults, **it commits**, and with `"output": "pr"` it pushes its own
branch and opens a pull request. It never merges, tags, force-pushes, or
touches the source checkout's working tree.

```sh
machine run /absolute/machine-shop/ticket-task.ts \
  --agent investigator=codex --agent tester=default \
  --agent implementer=default --agent reviewer=codex \
  --input-file /absolute/ticket.json
```

The ticket body needs `## Goal`, `## Scope`, `## Acceptance`, and `## Forbidden`.
A missing section ends `refused`, a declared failed ending, before any Agent runs.

### How a run goes

See the [diagram](docs/workflows/ticket-task.md#flow).

1. **Falsify.** An investigator tries to show the ticket is wrong, already
   done, or too vague. Open questions stop the run for the owner. With
   `"assume": true`, questions whose cautious answer loses nothing are answered
   and recorded instead.
2. **Plan and plan review.** A concise plan naming files and tests, with one
   revision allowed. The reviewer can find the ticket too broad and suggest a split.
3. **Tests first.** A tester writes failing tests for each acceptance
   criterion, and the Machine proves they fail. `"redGreen": false` skips this.
4. **Implement.** A change outside the ticket's Scope is sent back.
5. **Gates and review.** The repository's checks, then a structured review
   that the Machine judges itself.
6. **Commit, rebase, deliver.** If the base moved, the commit is replayed onto
   it and checked again; a conflict there goes to the implementer once, in the same run.

A spent review budget returns to the implementer once with a fresh review budget
when the last verdict is `revise`, every finding names a path inside Scope,
there is a blocker, and there is no discussion finding. The blocker feedback stays
in the implementer's prompt, and repair rounds already used still count.
A second spent budget, an outside-Scope or pathless finding, or no blocker asks
the owner; a `blocked` review still stops immediately. After the extra round
begins, every stuck question says it was used and gives the reviewer's latest
`newSinceLastRound`, or says no review has finished in it yet.

A stuck run sleeps on one Human question, keeping its worktree and branch.
The first sentence says what is needed, including the question count or fault.
The prompt then gives the stopped stage and budgets, the questions or remaining
reason once, and evidence. It suggests
`more rounds`, `hand off`, `archive`, and `discard`; discard still asks for confirmation.
Any other reply is an answer: like `more rounds`, it renews both budgets, clears
the owner questions, and returns to the stage that stopped.
The answer stays in later Agent prompts. `stuck` no longer changes anything:
both `"park"` (the default) and `"ask"` are accepted.
Each question is saved as `question-<n>.txt` in the evidence directory, numbered
from 1 across re-asks and continuation after sleep. The four decisions match
ignoring case, surrounding whitespace and trailing punctuation (`. , ; : ! ? …`);
`confirm discard` and `go back` stay exact.

**Resuming after the base moved.** A resumed run saves its uncommitted
candidate, moves onto the current tip and runs setup before checks. Conflicts
go to its implementer, then through the normal scope check, checks, and review.

### When it is stuck

- A stuck run sleeps on one Human question, keeping its worktree and branch.
- The first sentence says what is needed. The stage and budgets follow, then
  open questions or the remaining reason once, and evidence. It
  suggests `more rounds`, `hand off`, `archive`, and `discard`; discard still
  asks for confirmation.
- Any other reply is an answer: like `more rounds`, it renews both budgets,
  clears the owner questions, and returns to the stage that stopped. The answer
  stays in later Agent prompts.
- The four decisions match ignoring case, surrounding whitespace and trailing
  punctuation (`. , ; : ! ? …`); `confirm discard` and `go back` stay exact.
- Each question is saved as `question-<n>.txt` in the evidence directory,
  numbered from 1 across re-asks and continuation after sleep.
- `stuck` no longer changes anything: both `"park"` (the default) and `"ask"`
  are accepted.

### How it ends

Expected failures use [recovery by step](docs/workflows/ticket-task.md#recovery-by-step):
push and merge cleanup retry three times at one-minute intervals, then ask.
Setup and commit failures ask the choices that can act on that candidate.

- **Refused:** malformed tickets and preparation refusals end `refused` with the reason.
- **Worktree kept after delivery:** ends `delivered` at once, naming the leftover path and cleanup log.
- **Branch or patch:** ends `delivered` with `{ "action": "hold", "summary": "…" }`,
  keeping the Dispatch ticket open.
- **Pull request:** after opening it and removing the worktree, the run checks
  with `gh` every 10 minutes, and sleeps while waiting for the merge when run
  with the sleep option, as Dispatch does.
- **Merged:** it deletes the ticket branch locally and remotely and ends `merged` with
  `{ "action": "complete", "summary": "…" }`, so Dispatch closes the ticket.
- **Closed, or `gh` keeps failing:** a closed pull request or three consecutive
  check failures asks for hand off or confirmed local discard. Both keep the
  pushed branch and return `hold`.

Its [page](docs/workflows/ticket-task.md) lists every input field, and the
[catalog](docs/catalog.md#ticket-delivery) has the resume rules, evidence files,
and every stop.

## ChatGPT thread

[chatgpt-thread](docs/workflows/chatgpt-thread.md) keeps one ChatGPT web chat
going, sending each reply you type.

**It types into your own ChatGPT account**, in a real browser, so run it only
where that is intended.

## Develop

```sh
npm run check            # lint, types, and tests
npm run smoke:install
```

From the umbrella, `npm run verify -- machine-shop` runs the same checks as a
Machine and keeps a receipt.

- Inside Machines Org the checks reuse the sibling Machines checkout.
- A standalone checkout installs its dev dependencies first, and runtime
  changes not yet published need a built Machines tarball.

Tests drive the real runtime with fake Agents, temporary Git repositories, and
real commands, so they need no paid model. They do not measure how well a live
model does the work.

## The Machines family

| Project | What it does |
| --- | --- |
| [Machines](https://github.com/dna113p/machines) | The runtime: write a workflow as states, and run it with Agents, checks and people |
| **Machine Shop** (this repository) | Ready-made software workflows to copy into a project |
| [Machines Dispatch](https://github.com/dna113p/machines-dispatch) | A local daemon that runs a Machine for each ticket that is ready |
| [Machine Wars](https://github.com/dna113p/machine-wars) | A concept: ranking Agents so a Machine can pick one |
