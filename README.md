# Dev Machines

Dev Machines is our collection of development workflow definitions for the
[Machines](../machines) runtime.

This repository owns workflow policy. It does not own the runtime, agent
harnesses, or the global `~/.machines` installation directory.

Each Machine should remain a small, readable TypeScript file built from the
runtime's `agent`, `human`, `operation`, and `final` primitives.

Run the permanent smoke Machine directly from this repository:

```bash
/home/user/projects/machines/machine run ./smoke.ts "Hello from Dev Machines."
```
