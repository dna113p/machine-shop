---
name: machine-builder
description: Build, edit, or describe TypeScript workflow definitions for the Machines runtime. Use when creating a Machine, adding its discovery description, choosing among Agent/Human/Operation states, expressing workflow transitions, or testing and installing a Machine definition. Do not use for unrelated XState applications or agent-harness implementation.
---

# Build Machines

Build the smallest readable state machine that completes the requested workflow.
Keep workflow policy in the Machine file and keep the Machines runtime generic.

## Start from the current interface

Before editing, inspect the current `MachinePrimitives` definition and one nearby
Machine. In the Dev Machines repository:

- `../../smoke.ts` is the minimal executable example.
- `../../worktree-task.ts` shows Agent, Human, Operation, guards, feedback,
  merge, and cleanup in one workflow.

Treat those files as evidence of the current interface, not templates that every
workflow must copy.

## Model the policy first

Write the intended states and semantic events as a short transition chain before
writing TypeScript. For example:

```text
prepare --prepared--> implement --completed--> review
review --reviewed--> humanReview --submitted--> merge
merge --merged--> cleanup --cleaned--> done
```

Each state should answer one question: who or what acts next? Each event should
state what happened, not what state comes next.

Choose exactly one primitive for each action:

- **Agent**: open-ended work performed by an agent harness. Give it a bounded
  prompt; transition keys are the only allowed outcome types.
- **Human**: information or judgment supplied by a person. Suggestions may help,
  but unrestricted text input remains available. Show the exact artifact,
  evidence, and consequence the person is deciding about.
- **Operation**: trusted deterministic computation, such as a command, file
  check, worktree creation, merge, or cleanup. Return one semantic event.
- **Final**: all required terminal invariants have succeeded.

A Human is an input source, not a permanent approval role. Branch on the
submitted value when the policy needs approval, feedback, selection, or another
human-supplied result.

## Implement one definition

Default-export one factory receiving `MachinePrimitives` and the command input:

```ts
import type { MachinePrimitives } from "../machines/src/index.ts";

export const description = "Explains when to choose this Machine and what it does.";

export default function example(
  { final, machine, operation }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "run",
    states: {
      run: operation(
        () => ({ type: "completed", input }),
        { completed: "done" },
      ),
      done: final(),
    },
  });
}
```

Export one `description` string that fits on one line and tells a caller when or
why to choose the Machine. `machine list` is the discovery surface for humans and
Agents; keep the description concrete enough to select the right workflow.
Listing imports the module, so keep top-level evaluation side-effect free and put
all work inside the factory and its states.

Keep the definition in one TypeScript file while that remains readable. Extract
a helper only after a real second use or a genuinely distracting implementation
detail appears. Ordinary TypeScript imports are allowed.

Use a prompt function when an Agent needs data produced by an earlier state:

```ts
let feedback = "";

// A Human transition records feedback in the closure.
revise: agent(
  () => `Address this human feedback:\n${feedback}`,
  { completed: "humanReview" },
  { cwd: worktreeDirectory },
),
```

Use XState guards and transition actions directly for small policy decisions.
Keep provider selection, ACP mechanics, Pi configuration, and agent-profile
directories in the Agent runner binding rather than the Machine definition.

## Apply the simplicity gate

Every new concept must pay for itself in the workflow being built now.

- Put sequencing, review loops, Git policy, and completion conditions in the
  selected Machine.
- Change Machines core only when the workflow proves a missing generic primitive
  capability. Make the smallest interface change and add a focused runtime test.
- Keep each Machine independently useful and opt-in.
- Prefer explicit inputs, semantic events, and useful failures over registries,
  manifests, inheritance, installers, configuration layers, or ambient state.
- Let an Operation throw when an invariant fails. A failed merge or cleanup must
  remain non-final and preserve enough state for recovery.

Approval authorizes the next transition; it does not imply completion. Reach
`final()` only after every required post-approval Operation succeeds.

## Verify through the public seam

Verification is complete when all applicable checks below pass:

1. Type-check the Machine against the current runtime interface.
2. Confirm `machine list` shows its name, description, and resolved path.
3. Run it by exact path before adding discovery or installation behavior.
4. Test Agent states with a fake `AgentRunner` that records each request and
   returns only declared outcomes.
5. Test filesystem or Git Operations in a disposable directory or repository.
6. Prove the full transition sequence, including that failure cannot reach the
   final state.
7. Run one real harness and Human-input proof for workflows intended for
   interactive use.

Install a proven shared definition by symlinking that individual file into
`~/.machines/`. Keep `~/.machines` as a shared installation directory rather
than making it the source repository.
