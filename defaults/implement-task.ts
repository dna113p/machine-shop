import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_machine-shop/task.ts";

export const description = "Implement a bounded feature, verify it with explicit checks, and review with a bounded repair loop.";
export const agentRoles = { implementer: "Performs the scoped change", reviewer: "Reviews evidence and the resulting change without editing" };

export default function workflow(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("implement-task", input, { checks: true, git: "clean" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "change" }),
      change: agent(() => work.prompt("Implement the requested feature and its tests. Keep the change focused. Do not weaken checks or expand scope.", "change"), {
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
