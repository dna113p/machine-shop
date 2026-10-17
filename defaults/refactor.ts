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
      change: agent(() => work.prompt("Refactor only the requested structure while preserving externally observable behavior. Use the green baseline as the contract; do not quietly change tests to accept regressions.", "change"), {
        completed: { target: "changeReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "changeReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "implementer", cwd: work.workspace }),
      changeReport: operation(() => work.reported("change"), { sendBack: "change", completed: "verify", blocked: "failure" }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Review the current diff and verification evidence. Do not edit any file. Check acceptance criteria, regressions, scope, and whether tests actually establish the intended behavior. Return approved, revise with actionable findings, or blocked.", "review"), {
        approved: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        revise: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "reviewer", cwd: work.workspace }),
      reviewReport: operation(() => work.reported("review"), { sendBack: "review", approved: "reviewResult", revise: "reviewResult", blocked: "reviewResult" }),
      reviewResult: operation(work.review, { approved: "success", revise: "repairBudget", blocked: "failure" }),
      repairBudget: operation(work.repair, { retry: "change", exhausted: "failure" }),
      ...resultStates(work, p),
    },
  });
}
