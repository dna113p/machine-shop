import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_machine-shop/task.ts";

export const description = "Establish a green baseline, add focused regression/coverage tests, then verify and review.";
export const agentRoles = { tester: "Performs the scoped change", reviewer: "Reviews evidence and the resulting change without editing" };

export default function workflow(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("add-tests", input, { trusted: true, checks: true, git: "clean" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "baseline" }),
      baseline: operation(() => work.checks("baseline"), { passed: "change", failed: "failure" }),
      change: agent(() => work.prompt("Add tests for the requested behaviors and boundary cases. Leave production behavior unchanged. Explain why the new assertions would catch a real regression; do not inflate coverage with vacuous tests.", "change", { trusted: "editor" }), {
        completed: { target: "changeReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "changeReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "tester", cwd: work.workspace }),
      changeReport: operation(() => work.reported("change"), { sendBack: "change", completed: "verify", blocked: "changeBlocked" }),
      changeBlocked: operation(() => work.mechanical("change"), { continue: "change", verifyBase: "changeBase", blocked: "failure" }),
      changeBase: operation(work.verifyBase, { confirmed: "failure", refuted: "change", unrunnable: "change" }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Review the current diff and verification evidence. Do not edit any file. Check acceptance criteria, regressions, scope, and whether tests actually establish the intended behavior. Return approved, revise with actionable findings, or blocked.", "review", { trusted: "reviewer" }), {
        approved: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        revise: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "reviewReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "reviewer", cwd: work.workspace }),
      reviewReport: operation(() => work.reviewed("review"), { sendBack: "review", approved: "reviewResult", revise: "reviewResult", blocked: "reviewResult" }),
      reviewResult: operation(work.review, { approved: "success", revise: "reviewBudget", blocked: "failure" }),
      reviewBudget: operation(work.reviewRound, { retry: "change", exhausted: "success" }),
      repairBudget: operation(work.repair, { retry: "change", exhausted: "failure" }),
      ...resultStates(work, p),
    },
  });
}
