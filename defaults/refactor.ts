import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_machine-shop/task.ts";

export const description = "Establish a green baseline, refactor without changing behavior, then verify and review.";
export const agentRoles = { implementer: "Performs the scoped change", reviewer: "Reviews evidence and the resulting change without editing" };

export default function workflow(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("refactor", input, { checks: true, git: "clean" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "baseline" }),
      baseline: operation(() => work.checks("baseline"), { passed: "change", failed: "failure" }),
      change: agent(() => work.prompt("Refactor only the requested structure while preserving externally observable behavior. Use the green baseline as the contract; do not quietly change tests to accept regressions."), {
        completed: { target: "verify", actions: ({ event }: { event: Event }) => work.capture("change", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("change", event) },
      }, { using: "implementer", cwd: work.workspace }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Review the current diff and verification evidence. Do not edit any file. Check acceptance criteria, regressions, scope, and whether tests actually establish the intended behavior. Return approved, revise with actionable findings, or blocked."), {
        approved: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
        revise: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
        blocked: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
      }, { using: "reviewer", cwd: work.workspace }),
      reviewResult: operation(work.review, { approved: "success", revise: "repairBudget", blocked: "failure" }),
      repairBudget: operation(work.repair, { retry: "change", exhausted: "failure" }),
      ...resultStates(work, p),
    },
  });
}
