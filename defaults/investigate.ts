import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_dev-machines/task.ts";

export const description = "Investigate a bug, architecture question, or technical choice, challenge its evidence, and return a bounded report.";
export const agentRoles = { investigator: "Investigates the scoped question without editing", reviewer: "Challenges unsupported conclusions and missing alternatives" };

export default function investigate(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("investigate", input, { git: "snapshot" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "investigate" }),
      investigate: agent(() => work.prompt("Investigate this question without editing the checkout. Read actual code and relevant primary sources available within scope. Return evidence, plausible alternatives, uncertainties, a recommendation or diagnosis, and the smallest discriminating next step. Do not claim an unperformed experiment succeeded."), {
        completed: { target: "researchIntegrity", actions: ({ event }: { event: Event }) => work.capture("investigation", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("investigation", event) },
      }, { using: "investigator", cwd: work.workspace }),
      researchIntegrity: operation(work.unchanged, { unchanged: "challenge", changed: "failure" }),
      challenge: agent(() => work.prompt("Challenge the investigation without editing. Check evidence against the source, distinguish facts from assumptions, consider alternatives and the user's constraints. Return approved when the report is useful and qualified, revise for concrete missing evidence, or blocked."), {
        approved: { target: "challengeResult", actions: ({ event }: { event: Event }) => work.capture("challenge", event) },
        revise: { target: "challengeResult", actions: ({ event }: { event: Event }) => work.capture("challenge", event) },
        blocked: { target: "challengeResult", actions: ({ event }: { event: Event }) => work.capture("challenge", event) },
      }, { using: "reviewer", cwd: work.workspace }),
      challengeResult: operation(work.review, { approved: "success", revise: "repairBudget", blocked: "failure" }),
      repairBudget: operation(work.repair, { retry: "investigate", exhausted: "failure" }),
      ...resultStates(work, p),
    },
  });
}
