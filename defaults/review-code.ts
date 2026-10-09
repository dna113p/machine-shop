import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_dev-machines/task.ts";

export const description = "Review code or an existing diff without source edits and return evidence-backed findings.";
export const agentRoles = { reviewer: "Reviews the specified code without changing the checkout" };

export default function reviewCode(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("review-code", input, { git: "snapshot" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "review" }),
      review: agent(() => work.prompt("Review the requested code/diff without editing. Prioritize concrete correctness, regression, and security findings. Cite paths/lines, impact, and evidence. Separate confirmed problems from questions; state explicitly when no actionable finding is supported. Return reviewed to deliver the report, not to certify the code bug-free; return blocked if the assignment cannot be evaluated."), {
        reviewed: { target: "integrity", actions: ({ event }: { event: Event }) => work.capture("review", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("review", event) },
      }, { using: "reviewer", cwd: work.workspace }),
      integrity: operation(work.unchanged, { unchanged: "success", changed: "failure" }),
      ...resultStates(work, p),
    },
  });
}
