# Dev Machines

A selective starter library of **ten software-task Machines**: implementation,
bug fixing, refactoring, tests, review, investigation, documentation, dependency
upgrades, release preparation, and model-free verification.

This is the independent `dev-machines` Git repository in Machines Org, expanded
rather than duplicated. It owns reusable workflow policy, not the Machines runtime,
Agent harnesses, scheduling, or the global `~/.machines` directory. The new defaults
are portable TypeScript definitions with explicit states, real check gates,
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
small relative helper at `.machines/_dev-machines/task.ts`. Copies work after moving
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
machine run /absolute/dev-machines/defaults/verify-checks.ts \
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

From the umbrella, `npm run verify -- dev-machines` runs the verification Machine
and retains a check receipt. In a standalone checkout, install this repository's
development dependencies first. For runtime changes not yet published, use a built
Machines tarball rather than assuming the registry has the local version.

Tests use the real runtime, fake Agent runners, temporary Git projects, and actual
local check commands. They exercise success and failure branches, bounded retries,
Human rejection, stale candidate protection, installation conflicts, relocation,
and CLI failure exits. No paid model or production operation is needed. Live-model
instruction-following and task-solving quality are not established by these tests.

## Earlier workflows retained

The existing root definitions remain unchanged in behavior for compatibility:

- [smoke.ts](smoke.ts): one instant no-model Operation, accepting text input.
- [implement-review.ts](implement-review.ts): direct editing and a Human feedback
  loop, accepting text. Its checks are Agent-reported, not independent gates.
- [worktree-task.ts](worktree-task.ts): isolated implementation, advisory review,
  Human approval, fast-forward merge, and cleanup. It commits and merges by design;
  use only within an assignment authorizing those effects. It requires a clean
  source branch. `details` expands review findings; free-form feedback revises.

Existing global symlinks to these files remain valid. They are not silently
replaced by the new defaults, and the selective installer does not install them.
New editing defaults leave their changes uncommitted in the supplied checkout.
