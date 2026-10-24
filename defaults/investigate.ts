import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_machine-shop/task.ts";

export const description = "Investigate a bug, architecture question, or technical choice, challenge its evidence, and return a bounded report.";
export const agentRoles = { investigator: "Investigates the scoped question without editing", reviewer: "Challenges unsupported conclusions and missing alternatives" };

export default function investigate(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent } = p;
  const work = taskRun("investigate", input, { trusted: true, git: "snapshot" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "investigate" }),
      investigate: agent(() => work.prompt("Investigate this question without editing the checkout. Read actual code and relevant primary sources available within scope. Return evidence, plausible alternatives, uncertainties, a recommendation or diagnosis, and the smallest discriminating next step. Do not claim an unperformed experiment succeeded.", "investigation", { trusted: "investigator" }), {
        completed: { target: "investigateReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "investigateReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "investigator", cwd: work.workspace }),
      investigateReport: operation(() => work.reported("investigation"), { sendBack: "investigate", completed: "researchIntegrity", blocked: "failure" }),
      researchIntegrity: operation(work.unchanged, { unchanged: "challenge", changed: "failure" }),
      challenge: agent(() => work.prompt("Challenge the investigation without editing. Check evidence against the source, distinguish facts from assumptions, consider alternatives and the user's constraints. Return approved when the report is useful and qualified, revise for concrete missing evidence, or blocked.", "challenge"), {
        approved: { target: "challengeReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        revise: { target: "challengeReport", actions: ({ event }: { event: Event }) => work.receive(event) },
        blocked: { target: "challengeReport", actions: ({ event }: { event: Event }) => work.receive(event) },
      }, { using: "reviewer", cwd: work.workspace }),
      challengeReport: operation(() => work.reported("challenge"), { sendBack: "challenge", approved: "challengeResult", revise: "challengeResult", blocked: "challengeResult" }),
      challengeResult: operation(work.review, { approved: "deliver", revise: "deliver", blocked: "failure" }),
      deliver: operation(work.deliverInvestigation, { delivered: "success" }),
      ...resultStates(work, p),
    },
  });
}
