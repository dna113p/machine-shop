---
name: machine-builder
description: Build, edit, or describe TypeScript workflow definitions for the Machines runtime. Use when creating a Machine, when no existing Machine fits a reusable multi-step workflow, when adding its discovery description, choosing among Agent/Human/Operation states, expressing workflow transitions, or testing and installing a Machine definition. Do not use for unrelated XState applications or agent-harness implementation.
---

# Build Machines

Build the smallest readable state machine that completes the requested workflow.
Keep workflow policy in the Machine file and keep the Machines runtime generic.

## Confirm new workflow policy

Proceed immediately when the Human explicitly asked to create or edit a Machine. When you
independently recognize a possible new Machine, first inspect the available Machines. If none
fits and the workflow is reusable, show the Human a short state sequence and ask whether to
create it. Handle a one-off task normally. After confirmation, create the Machine in the
project's `.machines/` directory; use the global `~/.machines/` directory only when the Human
explicitly requests a global installation.

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

Choose the Human input mode deliberately: omit options for free-form input, use
`suggestions` for shortcuts plus automatic `Other…`, or use `choices` for a
restricted selector without `Other…`. Each value is submitted exactly as written,
so use strings the transition logic recognizes. Pipes and CI also enforce
restricted choices.

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

Every Machine must export one `description` string that fits on one line and tells
a caller when or why to choose it. Both `machine list` and `machine run` enforce
this contract. `machine list` is the discovery surface for humans and Agents; keep
the description concrete enough to select the right workflow.
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

When a Machine needs distinct Agent roles, declare each dependency with a one-line
description and select it with `using`:

```ts
export const agentRoles = {
  fastImplementer: "Handles routine implementation quickly",
  strongImplementer: "Handles escalated implementation work",
};

const implement = agent(
  "Implement the change",
  { completed: "done" },
  { using: "fastImplementer", cwd: worktreeDirectory },
);
```

Role names describe workflow needs, not providers. Put Pi directories, models, ACP
commands, and other harness choices in `~/.machines/agents.ts` or the nearest project
`.machines/agents.ts`. Those files default-export a function that receives installed
adapter constructors and returns named presets:

```ts
export default ({ acpAgent }) => ({
  strongPi: {
    description: "Strong Pi implementer for difficult changes",
    harness: "pi-acp",
    model: "gpt-5.6-sol",
    thinking: "high",
    runner: acpAgent("npx", ["-y", "pi-acp"], {
      harness: "pi-acp",
      env: { PI_CODING_AGENT_DIR: "/home/user/.agents/strong" },
    }),
  },
});
```

`description` and `runner` are required. `harness`, `model`, and `thinking` are optional
discovery labels. A project preset replaces a global preset with the same name. A preset
whose name matches a role binds automatically. Do not modify a user's presets unless the
task asks for that setup.

For one invocation, a caller may bind a Machine role to another configured preset:

```bash
machine run worktree-task --agent strongImplementer=strongPi -- "Implement the change"
```

This is a role-to-preset alias, not Machine input and not inline provider configuration.
The launcher validates the role and preset before any Operation runs.

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
2. Confirm `machine list` shows its name, description, resolved path, and missing roles.
3. Run `machine agents` to inspect the resolved presets and their source files.
4. Run it by exact path before adding discovery or installation behavior.
5. Test Agent states with named fake `AgentRunner` bindings that record each request and
   return only declared outcomes. Prove every named role is available before Operations run.
6. When supporting caller selection, prove `--agent role=preset` uses the selected preset
   and rejects unknown roles and presets before Operations run.
7. Test filesystem or Git Operations in a disposable directory or repository.
8. Prove the full transition sequence, including that failure cannot reach the
   final state.
9. Run one real harness and Human-input proof for workflows intended for
   interactive use.

## Discover and invoke existing Machines

When acting as the caller rather than the author, do not guess Machine names, roles, or
Agent presets. In Pi with the Machines extension loaded, use `machine_list` and
`machine_agents`. Start the selected workflow with `machine_start`; it returns a run id while
the Machine continues asynchronously. Keep the conversation available and call
`machine_status` only when its state is relevant.

Pi presents Machine choices and free-form input directly to the Human and sends their response
to the exact waiting run. A canceled dialog leaves the Machine waiting. If the Human then
answers in conversation, call `machine_respond` with that run id and preserve the answer as
written. An approval, revision loop, merge, cleanup, or terminal condition is Machine policy;
reaching a Human request does not transfer that authority to Pi.

Outside Pi, discover through the CLI:

```bash
machine list
machine agents
```

Choose a Machine from its description. Use its exact declared role names and an available
preset name when a one-run override is useful. Then launch with `machine run`. The CLI blocks
until the Machine finishes or needs terminal input; only `machine_start` in Pi is async. Model,
thinking, environment, and harness fields belong in the selected preset rather than either
invocation.

Install a proven shared definition by symlinking that individual file into
`~/.machines/`. Keep `~/.machines` as a shared installation directory rather
than making it the source repository.
