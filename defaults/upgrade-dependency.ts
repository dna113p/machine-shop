import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_machine-shop/task.ts";

export const description = "Check the baseline, assess an upgrade, obtain Human approval, then update, verify, and review without publishing.";
export const agentRoles = { analyst: "Assesses compatibility and proposes the bounded upgrade", implementer: "Updates the approved dependency and affected code", reviewer: "Reviews compatibility and upgrade scope without editing" };

export default function upgradeDependency(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent, human } = p;
  const work = taskRun("upgrade-dependency", input, { checks: true, git: "clean" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "baseline" }),
      baseline: operation(() => work.checks("baseline"), { passed: "sealPlan", failed: "failure" }),
      sealPlan: operation(work.seal, { sealed: "assess" }),
      assess: agent(() => work.prompt("Assess the requested dependency upgrade without editing. Confirm the current and proposed versions from available primary sources, compatibility, migration steps, lockfile effects, and the validation plan. Do not choose an unverified latest version. Include risks and rollback guidance in the proposal; return blocked for unavailable version evidence."), {
        completed: { target: "planIntegrity", actions: ({ event }: { event: Event }) => work.capture("proposal", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("proposal", event) },
      }, { using: "analyst", cwd: work.workspace }),
      planIntegrity: operation(work.unchanged, { unchanged: "approval", changed: "failure" }),
      approval: human(() => work.humanPrompt("Approve this dependency upgrade plan before files are changed?"), {
        submitted: [
          { guard: ({ event }: { event: Event }) => event.value === "approve", target: "approvalIntegrity", actions: ({ event }: { event: Event }) => work.decision("upgrade-plan", event) },
          { target: "rejection", actions: ({ event }: { event: Event }) => work.decision("upgrade-plan", event) },
        ],
      }, { choices: ["approve", "reject"] }),
      approvalIntegrity: operation(work.unchanged, { unchanged: "upgrade", changed: "failure" }),
      upgrade: agent(() => work.prompt("Implement only the Human-approved upgrade plan and address relevant check/review feedback. Keep dependency and lockfile changes consistent. Do not perform unrelated upgrades, deployments, or production migrations. Block if the approved plan needs a material scope change."), {
        completed: { target: "verify", actions: ({ event }: { event: Event }) => work.capture("upgrade", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("upgrade", event) },
      }, { using: "implementer", cwd: work.workspace }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Review the upgrade without editing: compare it with the approved plan, check versions and lockfile, compatibility changes, and test evidence. Return approved, revise, or blocked."), {
        approved: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
        revise: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
        blocked: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("review", event) },
      }, { using: "reviewer", cwd: work.workspace }),
      reviewResult: operation(work.review, { approved: "success", revise: "repairBudget", blocked: "failure" }),
      repairBudget: operation(work.repair, { retry: "upgrade", exhausted: "failure" }),
      ...resultStates(work, p),
    },
  });
}
