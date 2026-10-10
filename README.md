# Machine Shop

A selective starter library of **ten software-task Machines**: implementation,
bug fixing, refactoring, tests, review, investigation, documentation, dependency
upgrades, release preparation, and model-free verification.

This is the independent `machine-shop` Git repository in Machines Org. It owns
reusable workflow policy, not the Machines runtime, Agent harnesses, scheduling,
or the global `~/.machines` directory. The defaults are portable TypeScript
definitions with explicit states, real check gates,
bounded repairs, and retrievable JSON evidence.

## Choose a workflow

| Default | Purpose |
| --- | --- |
| `verify-checks` | Run explicit project checks without a model |
| `implement-task` | Implement a feature, verify it, and review it |
| `fix-bug` | Prove a regression red, fix it, prove green, and review |
| `refactor` | Preserve behavior against a passing baseline |
| `add-tests` | Add meaningful tests without changing production behavior |
| `review-code` | Return evidence-backed review findings without edits |
| `investigate` | Investigate and challenge a diagnosis or technical choice |
| `update-docs` | Update docs/examples and validate against the source |
| `upgrade-dependency` | Assess compatibility, get approval, upgrade, and verify |
| `prepare-release` | Check a candidate and obtain sign-off; never publish |

Read the [catalog](docs/catalog.md) for state sequences, role bindings, costs,
input contracts, exact results, and limitations. These are starting points, not
an install-everything suite. The project orchestrator selects or adapts the ones
that fit its actual work, then records routes in the project's `.machines/README.md`.
Use the runtime's `machine-project-setup` skill for that decision and
`machine-delegation` for normal assignments. An existing worker should not repeat
setup or recursively delegate the same assignment.

## Install selected defaults into a project

Requires Node 24 or later. From this repository:

```sh
node scripts/install.mjs --list
node scripts/install.mjs --target /absolute/project \
  --workflow verify-checks --workflow implement-task --workflow review-code --dry-run

# Apply the same selected copy after inspecting the plan:
node scripts/install.mjs --target /absolute/project \
  --workflow verify-checks --workflow implement-task --workflow review-code
```

The installer copies selected definitions as `.machines/dev-<name>.ts`, plus the
small relative helper at `.machines/_machine-shop/task.ts`. Copies work after moving
the project and can be adapted locally. The `dev-` prefix avoids clobbering project
names. Identical reinstalls are no-ops; customized/conflicting files are refused
before normal writes. There is no force-overwrite option, automatic update,
implicit install-all, global installation, Agent configuration, or dependency install.
Existing instruction files, presets, and workflow maps are preserved.

A new `.machines/` directory hides ancestor catalogs. The installer refuses that
unless `--allow-shadowing` is explicitly supplied after examining the inherited
routes. It also rejects symlink destinations. For a shared-helper upgrade, compare
changes manually or install into a fresh project; never overwrite a customized
helper. A concurrent filesystem error may leave some newly created files; inspect
the printed paths before retrying. Existing files are never intentionally replaced.

Keep `.machine-runs/` out of source control in the target project. Review and save
setup changes before starting a default that requires a clean Git checkout.

## Run

Install/configure the Machines runtime separately, then discover in the target:

```sh
cd /absolute/project
machine list
machine agents
```

These commands use the target's presets. Missing named roles are intentional until
you choose real bindings; the library never installs fake presets into a live catalog.
The built-in `codex` preset is read-only, so it is suitable for review, not editing.
The `default` preset uses the locally configured Pi ACP harness; it still requires
that harness, credentials, permissions, and an authorized model budget.

Use [examples/verify.json](examples/verify.json) after replacing its workspace and
commands with actual project checks:

```sh
machine run dev-verify-checks --input-file /absolute/assignment.json
```

For an implementation, supply the complete task and real checks using the same
JSON input shape, then bind the roles to names returned by `machine agents`:

```sh
machine run dev-implement-task \
  --agent implementer=default --agent reviewer=codex \
  --input-file /absolute/assignment.json
```

This last example requires both presets to be configured and authorized; it is not
an installation or permission grant. MCP/Pi accept the same structured input.
Set launch `cwd` and input `workspace` to the same project. The coordinator must
read both the final state and JSON output, including blockers and result evidence.
A Machine that ends in `blocked` is not a successfully fulfilled software task.

Direct source execution also works without copying the defaults:

```sh
machine run /absolute/machine-shop/defaults/verify-checks.ts \
  --input-file /absolute/assignment.json
```

Runtime type imports are erased during workflow execution; the definitions do not
import a sibling runtime's private source. A runtime installation is still needed
to launch them. See the Machines runtime's authoring/integration documentation for
MCP, Pi, presets, and the public package interface.

## Local development and proof

In the Machines Org checkout, the tests and type checker can reuse the sibling
Machines development checkout and its installed dependencies:

```sh
npm run check
npm run smoke:install
```

From the umbrella, `npm run verify -- machine-shop` runs the verification Machine
and retains a check receipt. In a standalone checkout, install this repository's
development dependencies first. For runtime changes not yet published, use a built
Machines tarball rather than assuming the registry has the local version.

Tests use the real runtime, fake Agent runners, temporary Git projects, and actual
local check commands. They exercise success and failure branches, bounded retries,
Human rejection, stale candidate protection, installation conflicts, relocation,
and CLI failure exits. No paid model or production operation is needed. Live-model
instruction-following and task-solving quality are not established by these tests.

## Ticket delivery

[ticket-task.ts](ticket-task.ts) is a workflow at the repository root. It
is not one of the ten defaults and the selective installer does not install it;
run it from source or wrap it in a project Machine that supplies trusted paths
and commands. It takes one local ticket for one Git repository and carries it
from an isolated worktree to a delivered branch, patch, or draft pull request,
stopping for a person only when the work is stuck:

```sh
machine run /absolute/machine-shop/ticket-task.ts \
  --agent investigator=codex --agent implementer=default --agent reviewer=codex \
  --input-file /absolute/ticket.json
```

Unlike the ten defaults, **it commits**: one commit on a new
`ticket/<id-slug>-<title-slug>` branch after the required checks pass and the
reviewer approves. With `"output": "pr"` it also pushes that branch and opens a
pull request with `gh`, after checking with the remote that the base is already
published there.
Use it only where the assignment authorizes those effects. It never merges,
tags, force-pushes, or pushes any other ref, and never modifies the source
checkout's working tree, index, or current branch.

A ticket run can wait for a person. Failed checks and review findings are
repaired within `maxRepairs`, which defaults to 3 here (0-3 accepted). When that
budget is exhausted, or triage, the implementer, or the reviewer reports a
blocker or a read-only stage edits the worktree, the run enters the Human state
`decide` instead of ending. Its prompt gives the ticket, the reason, the repair
rounds used, the worktree, and the branch, and offers exactly four choices:

- `more rounds`: restart the repair budget and send the standing findings back
  to the implementer. It can be chosen every time the budget runs out.
- `hand off`: end `handedOff` with the worktree and branch kept, uncommitted,
  for another workflow or a person.
- `archive`: commit what delivery would have committed and keep that commit as
  the branch `archive/<slug>`, where `<slug>` is what follows `ticket/` in the
  ticket branch name, then remove the worktree and delete the ticket branch;
  ends `abandoned`. Ignored files are not kept, exactly as they are not
  delivered. An archive branch that already exists, or a candidate that does
  not differ from its base commit, ends `blocked` with nothing removed. The
  workflow never deletes an archive branch.
- `discard`: remove the worktree and delete the branch without saving anything;
  ends `abandoned`. Nothing is removed until a second Human state,
  `confirmDiscard`, is answered `confirm discard`; `go back` returns to the
  decision unchanged.

Failures while preparing the worktree, committing, or delivering still end
`blocked` without asking. `"resume": true` starts a new run in the uncommitted
worktree a `hand off` left behind: it skips triage and setup, and goes straight
to the checks, review, commit, and delivery with a fresh repair budget. The
base branch may have moved forward in the meantime: the ticket branch must point
at the base commit or an ancestor of it, with no commit of its own, and the run
delivers on the commit the branch is on without rebasing.

The run ends `delivered`, `handedOff`, `abandoned`, or `blocked`, and its output
is always exactly `{ "action": "hold", "summary": "..." }` so a Machines Dispatch
ticket stays open until a person merges or closes it. The workflow never
relaunches itself or another Machine and never edits a ticket. See the
[catalog](docs/catalog.md#ticket-delivery) for the input contract, evidence, and
limits.

## ChatGPT thread

[chatgpt-thread.ts](chatgpt-thread.ts) is a root workflow that keeps one ChatGPT
web chat going through Human replies. It is not one of the ten defaults and the
selective installer does not install it; run it from source. Its input is text:

```sh
# Start a fresh chat for a task in the current directory:
machine run /absolute/machine-shop/chatgpt-thread.ts "Add a health endpoint"

# Or adopt an existing conversation; nothing is sent until you reply:
machine run /absolute/machine-shop/chatgpt-thread.ts "https://chatgpt.com/c/<id>"
```

After each rig-bridge handoff a Human state shows its reason and summary and the
conversation URL. Any reply is sent to the chat unchanged; `done` ends the run,
whose output is the conversation URL and the last handoff reason and summary. A
reply that fails comes back to the Human state with the error and the reply
quoted, and is never resent automatically.

It needs the `chatgpt-web` Agent, a running rig-bridge, and a signed-in
automation browser profile. **It types into your own ChatGPT account**: the task
and every reply are submitted as you, in a real browser, and count against that
account. Run it only where that is intended. The package
`@dna113p/machines/chatgpt-web` must resolve from this checkout for replies to
be sent. See the [catalog](docs/catalog.md#chatgpt-thread) for states,
requirements, and limits.

## Other root workflows

Three more root definitions take plain text input:

- [smoke.ts](smoke.ts): one instant no-model Operation, accepting text input.
- [implement-review.ts](implement-review.ts): direct editing and a Human feedback
  loop, accepting text. Its checks are Agent-reported, not independent gates.
- [worktree-task.ts](worktree-task.ts): isolated implementation, advisory review,
  Human approval, fast-forward merge, and cleanup. It commits and merges by design;
  use only within an assignment authorizing those effects. It requires a clean
  source branch. `details` expands review findings; free-form feedback revises.

The selective installer does not install them; global `~/.machines` symlinks may
point at these files. Unlike `worktree-task`, the editing defaults leave their
changes uncommitted in the supplied checkout.
