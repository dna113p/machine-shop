# Dev Machines

Dev Machines is our collection of development workflow definitions for the
[Machines](../machines) runtime.

This repository owns workflow policy. It does not own the runtime, agent
harnesses, or the global `~/.machines` installation directory.

Each Machine should remain a small, readable TypeScript file built from the
runtime's `agent`, `human`, `operation`, and `final` primitives.

## Smoke test

Run the permanent smoke Machine directly from this repository:

```bash
/home/user/projects/machines/machine run ./smoke.ts "Hello from Dev Machines."
```

## Worktree task

Install it globally without copying it out of this repository:

```bash
mkdir -p ~/.machines
ln -s /home/user/projects/dev-machines/worktree-task.ts ~/.machines/worktree-task.ts
```

From a clean Git checkout on a branch:

```bash
/home/user/projects/machines/machine run worktree-task "Describe the task"
```

The Machine creates a temporary branch and worktree from the current `HEAD`,
runs implementation and one advisory Agent review there, and asks for human
approval or free-form revision feedback. Approval fast-forwards the original
branch, removes the worktree and temporary branch, and then reaches `done`.

Run the automated disposable-repository proof with:

```bash
npm test
```
