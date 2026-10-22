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

Twelve defaults live in `defaults/`. The installer copies these eleven into a
project on request:

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

The audit and three root workflows run from source and are never installed:

| Workflow | Purpose |
| --- | --- |
| [`audit-project`](docs/workflows/audit-project.md) | Propose Machines, gates and role bindings for a project, then apply on acceptance |
| [`ticket-task`](docs/workflows/ticket-task.md) | Carry a local ticket from its own worktree to a branch, patch, or pull request |
| [`chatgpt-thread`](docs/workflows/chatgpt-thread.md) | Keep one ChatGPT web chat going, with a person writing each reply |
| [`smoke`](docs/workflows/smoke.md) | One no-model step that proves the runtime can load a definition |

A project orchestrator chooses among them with the runtime's
`machine-project-setup` skill, records the routes in the project's
`.machines/README.md`, and hands out work with `machine-delegation`.

Malformed Agent reports get [one send-back with the exact fault](docs/catalog.md#recovery),
kept in the stage evidence, before the existing stop applies.

## Project setup and audit

Run from this checkout with input `{ "project": "/absolute/project" }`:

```sh
machine run defaults/audit-project.ts --input-file /absolute/audit-input.json
```

The [audit](docs/workflows/audit-project.md) inventories the project, proposes
routes, gates and role bindings, and waits for accept or skip. `apply: true`
authorizes applying immediately. It is also setup for a project with no catalog.
It stays in Machine Shop so it can use the current defaults and installer; it is
absent from the installer’s selections. Evidence and the decision page live under
the audited project's `.machine-runs/`. Optional caller-supplied `projectAgent`
argv inspects a shared binding and offers a separate setup route; audit never
executes setup. Without it there are no new external calls or Drip/Overlord
dependencies. See the [adapter contract](docs/workflows/audit-project.md#optional-shared-project-agent-inspection).

## Installing

- Each selected workflow lands as `.machines/dev-<name>.ts`, beside its required
  helpers in `.machines/_machine-shop/`. The `dev-` prefix leaves names such as
  `verify` free for the project.
- **Safe to repeat.** An identical file is a no-op. A customized or conflicting
  one is refused, never overwritten. There is no force option, automatic
  update, or install-all. The accepted audit can refresh copies whose bytes still
  match their recorded installer hashes.
- **No shadowing by accident.** A new `.machines/` directory hides the catalogs
  of parent directories, so the installer refuses to create one unless you pass
  `--allow-shadowing`. It also refuses symlinked destinations.
- **Provenance.** `.machines/_machine-shop/manifest.json` records each copied
  file’s hash and Machine Shop version. Modified and unknown-provenance files
  are preserved by the audit.
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

[ticket-task](docs/workflows/ticket-task.md) carries a local ticket from an isolated worktree through
planning, tests, checks and review to a committed branch, patch, or pull request.
Its single `stuck` question retains evidence and returns the owner's answer to
the saved origin. Paths outside scope ask for inclusion or reversion immediately,
without automatic repair rounds; owner inclusions survive resume. The workflow
page documents inputs, budgets, resume and endings.

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
