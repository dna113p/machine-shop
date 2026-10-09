import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_dev-machines/task.ts";

export const description = "Update documentation or examples, run explicit validation, and check factual consistency.";
export const agentRoles = { writer: "Performs the scoped change", reviewer: "Reviews evidence and the resulting change without editing" };

export default function workflow(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("update-docs", input, { checks: true, git: "clean" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "change" }),
      change: agent(() => work.prompt("Update only the requested documentation and examples. Read the source of truth. Verify documented commands and API names; distinguish verified behavior from assumptions. Do not alter production behavior."), {
        completed: { target: "verify", actions: ({ event }: { event: Event }) => work.capture("change", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("change", event) },
      }, { using: "writer", cwd: work.workspace }),
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
