---
name: machine-builder
description: Select and adapt Dev Machines software-task defaults, or build a project-specific Machine when no existing workflow fits. Use the runtime machine-builder and project-setup skills when available.
---

# Build with Dev Machines

The project orchestrator starts with [the catalog](../../docs/catalog.md), reads
candidate sources and project commands, and selects a useful subset. This library
is not a mandatory suite. Use the runtime's machine-project-setup skill for project
coverage and machine-delegation for execution; do not repeat setup inside workers.

Reuse or adapt an appropriate default instead of creating a duplicate prompt
wrapper. Within the assigned scope, author local workflows without asking the user
to enumerate each definition. Keep trivial tasks direct. New definitions use public
`@dna113p/machines` type imports and relative helpers, never a sibling src/ import.

Keep transitions explicit in each Machine. Operations own real mechanical checks;
Agents own bounded judgment or edits; Human states own genuine decisions. Required
checks must gate completion. Carry task context and inspectable output, bound repair
loops, and distinguish blocked/rejected from successful completion. An Agent claim
or catalog readiness is not verification. Preserve existing scope and model budgets.

Use [the selective installer](../../scripts/install.mjs) only for the defaults the
project needs, inspect conflicts, and preserve customized definitions and global
settings. Set actual commands, roles, permissions, and an ignored evidence directory.
Run `npm run check` and `npm run smoke:install` with fake runners and temporary
projects; never spend model credits merely to demonstrate setup. Live-agent quality
must be validated separately within an authorized task.
