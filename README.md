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
The Human gate shows a compact automated-review summary. Enter `details` to print
the full report, `approve` to merge, or any other text as revision feedback.
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
