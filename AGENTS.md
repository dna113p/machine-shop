# Machine Shop contributor guidance

This independent repository is the software-workflow starter library for Machines.
Keep workflow policy here, not in the runtime. Read README.md and docs/catalog.md
before choosing a default. Root definitions are standalone workflows the installer
does not copy; selectable defaults live in defaults/ with mechanical helpers in
`defaults/_machine-shop/`. Helpers do not choose workflow transitions.

Use the Machines project-setup, builder, and delegation skills when available.
The project orchestrator selects and adapts a small relevant subset rather than
installing every default. Definitions must work after selective copying into a
project; use public runtime type imports and relative local helper imports.

Required checks run as Operations and gate success. Keep Agent invocations bounded,
require useful summaries, and distinguish completed, blocked, and rejected output.
Never manufacture Human approval. Do not start paid agents, publish, merge, or
install global configuration merely to validate the library. Test with fake
runners, real local commands, and disposable Git repositories.

Run `npm run check` and `npm run smoke:install`. From the umbrella, use its
`npm run verify -- machine-shop` Machine. Tests may resolve a sibling runtime for
checkout development; distributed workflow definitions may not import its src/.
Preserve existing user files, installed/customized definitions, and other agents'
work. The installer must be selective, repeatable, and refuse conflicting edits.
