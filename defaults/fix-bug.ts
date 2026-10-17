import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_machine-shop/task.ts";

export const description = "Prove a specific regression fails, repair it, prove it passes, then run required checks and review.";
export const agentRoles = { tester: "Writes a focused reproducing regression test", implementer: "Repairs the demonstrated bug", reviewer: "Reviews the fix and regression evidence without editing" };

export default function fixBug(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("fix-bug", input, { checks: true, git: "clean", regression: true });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "writeRegression" }),
      writeRegression: agent(() => work.prompt("Write a focused regression test for this bug before changing production code. The supplied regression command must fail for the stated reason with the configured exit code and diagnostic. Do not break infrastructure or the test runner to manufacture a red test.", "regression"), {
        completed: { target: "writeRegressionReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "writeRegressionReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "tester", cwd: work.workspace }),
      writeRegressionReport: operation(() => work.reported("regression"), { sendBack: "writeRegression", completed: "proveRed", blocked: "failure" }),
      proveRed: operation(() => work.regression(true), { passed: "fix", failed: "failure" }),
      fix: agent(() => work.prompt("Fix the demonstrated bug or address review/check feedback. Keep the reproducing regression test meaningful; do not remove it or weaken its assertions. Preserve unrelated behavior.", "fix"), {
        completed: { target: "fixReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "fixReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "implementer", cwd: work.workspace }),
      fixReport: operation(() => work.reported("fix"), { sendBack: "fix", completed: "proveGreen", blocked: "failure" }),
      proveGreen: operation(() => work.regression(false), { passed: "verify", failed: "repairBudget" }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Review the bug fix without editing. Read the red and green regression logs and the original task. Check that the regression was not disabled, the fix addresses the cause, and unrelated behavior is preserved. Return approved, revise, or blocked.", "review"), {
        approved: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        revise: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "reviewer", cwd: work.workspace }),
      reviewReport: operation(() => work.reported("review"), { sendBack: "review", approved: "reviewResult", revise: "reviewResult", blocked: "reviewResult" }),
      reviewResult: operation(work.review, { approved: "success", revise: "repairBudget", blocked: "failure" }),
      repairBudget: operation(work.repair, { retry: "fix", exhausted: "failure" }),
      ...resultStates(work, p),
    },
  });
}
