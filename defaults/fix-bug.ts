import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_dev-machines/task.ts";

export const description = "Prove a specific regression fails, repair it, prove it passes, then run required checks and review.";
export const agentRoles = { tester: "Writes a focused reproducing regression test", implementer: "Repairs the demonstrated bug", reviewer: "Reviews the fix and regression evidence without editing" };

export default function fixBug(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("fix-bug", input, { checks: true, git: "clean", regression: true });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "writeRegression" }),
      writeRegression: agent(() => work.prompt("Write a focused regression test for this bug before changing production code. The supplied regression command must fail for the stated reason with the configured exit code and diagnostic. Do not break infrastructure or the test runner to manufacture a red test."), {
        completed: { target: "proveRed", actions: ({ event }: { event: Event }) => work.capture("regression", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("regression", event) },
      }, { using: "tester", cwd: work.workspace }),
      proveRed: operation(() => work.regression(true), { passed: "fix", failed: "failure" }),
      fix: agent(() => work.prompt("Fix the demonstrated bug or address review/check feedback. Keep the reproducing regression test meaningful; do not remove it or weaken its assertions. Preserve unrelated behavior."), {
        completed: { target: "proveGreen", actions: ({ event }: { event: Event }) => work.capture("fix", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("fix", event) },
      }, { using: "implementer", cwd: work.workspace }),
      proveGreen: operation(() => work.regression(false), { passed: "verify", failed: "repairBudget" }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Review the bug fix without editing. Read the red and green regression logs and the original task. Check that the regression was not disabled, the fix addresses the cause, and unrelated behavior is preserved. Return approved, revise, or blocked."), {
        approved: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
        revise: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
        blocked: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
      }, { using: "reviewer", cwd: work.workspace }),
      reviewResult: operation(work.review, { approved: "success", revise: "repairBudget", blocked: "failure" }),
      repairBudget: operation(work.repair, { retry: "fix", exhausted: "failure" }),
      ...resultStates(work, p),
    },
  });
}
