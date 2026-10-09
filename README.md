# Dev Machines

Dev Machines is our collection of development workflow definitions for the
[Machines](../machines) runtime.

This repository owns workflow policy. It does not own the runtime, agent
harnesses, or the global `~/.machines` installation directory.

Each Machine should remain a small, readable TypeScript file built from the
runtime's `agent`, `human`, `operation`, and `final` primitives.

The repository also contains a model-discoverable
[`machine-builder`](./skills/machine-builder/SKILL.md) skill that teaches agents
how to build and verify definitions while preserving the runtime boundary.

## Choose an Agent for one run

List the Agent presets resolved from `~/.machines/agents.ts` and the nearest project
`.machines/agents.ts`:

```bash
machine agents
```

To use another configured preset for a Machine role, alias it only for that invocation:

```bash
machine run worktree-task \
  --agent default=strongPi \
  -- "Describe the task"
```

The current Dev Machines use the unnamed `default` role. The launcher validates both the
role and preset before creating a worktree or making another workflow change. Coding Agents
can discover the same information through `machine list` and `machine agents`; they should
select from configured presets rather than inventing inline harness or model options.

## Launch from Pi

With the Machines Pi extension installed, ask Pi naturally:

```text
Use the worktree-task Machine to add the empty state and its tests.
```

Pi discovers Machines and Agent presets, starts the run asynchronously, and remains available
for conversation. When the Machine needs Human input, Pi opens a native selector. Selecting
`approve` or another suggestion sends it directly to the exact waiting run; `Other…` opens
direct feedback input. Cancel the dialog when you want to inspect or discuss the result with
Pi first. The Machine, not the extension, still owns revision, merge, cleanup, and completion.

The extension also directs Pi to discover Machines before delegated or multi-step work,
without requiring the user to name one. Reuse a suitable definition, or create a scoped
Machine when sequencing, checks, or Human decisions help even a one-off task. Small edits
and single commands remain direct. A missing runtime or no safe fit should produce an
explicit fallback, not silent bypass or extra model spending. Authoring stays within the
user's task; global installation remains a separate Human choice. A worker already inside
a Machine should complete its assigned state rather than recursively delegate it again.
See the runtime's [agent defaults](../machines/docs/integrations.md#agent-defaults).

## Smoke test

Install the permanent smoke Machine as an instant runtime health check:

```bash
mkdir -p ~/.machines
ln -s /home/user/projects/dev-machines/smoke.ts ~/.machines/smoke.ts
machine run smoke "Hello from Dev Machines."
```

## Worktree task

Install it globally without copying it out of this repository:

```bash
mkdir -p ~/.machines
ln -s /home/user/projects/dev-machines/worktree-task.ts ~/.machines/worktree-task.ts
```

From a clean Git checkout on a branch:

```bash
machine run worktree-task "Describe the task"
```

The Machine creates a temporary branch and worktree from the current `HEAD`,
runs implementation and one advisory Agent review there, and asks for human
approval or free-form revision feedback. Approval fast-forwards the original
branch, removes the worktree and temporary branch, and then reaches `done`.
The Human gate shows a compact automated-review summary. Choose `details` to put
the full report in the next Human prompt, `approve` to merge, or enter revision
feedback.
Interactive worktree creation, merge, and cleanup messages are short indented notes;
redirected output retains their complete machine-readable wording.

## Implement and review

For a deliberately smaller workflow that edits the current directory directly:

```bash
machine run implement-review "Describe the task"
```

It runs one Agent implementation and then asks for Human review. Enter `approve`
to finish, or enter unrestricted feedback to run another implementation pass.
It does not create a worktree, commit, merge, or clean up changes.

Run the automated disposable-repository proof with:

```bash
npm test
```
