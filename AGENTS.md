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

<!-- drip:reporting -->
## Reporting through Drip

Use Drip for work that may outlast the person's attention: more than a few
minutes, or started from Drip or a phone. Read the `drip-briefing` skill
before reporting; use `drip_guide` if the skill is unavailable. At the start,
use `drip_projects` to find the registered project holding this folder, then
open a thread with `drip_open`. Keep the person's ask in their own words.
If no project matches, say which folder needs registration and continue.
Keep the thread's recap current with `drip_recap`: on opening, after each
milestone, before each question, and when the work drifts from the ask.
Write its `now` as a sentence about where the work stands, never a name and
state label. Say what changed and what the person needs to do. Ask blocking
questions with `drip_ask`; distinguish restricted choices from suggestions,
and explain each choice's effect and your recommendation. Attach a page to
its recap or question when useful; keep the text able to stand alone.
Read and answer the person's messages returned by the tools. When finished,
close the thread with `drip_close` and a final result. Say "Nothing needed."
once when there is nothing for the person to do.
<!-- /drip:reporting -->
