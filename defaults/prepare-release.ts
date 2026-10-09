import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_dev-machines/task.ts";

export const description = "Verify a clean release candidate, prepare an evidence-backed checklist, and request Human sign-off; never publish.";
export const agentRoles = { reviewer: "Assesses release readiness and drafts a release checklist without source edits" };

export default function prepareRelease(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent, human } = p;
  const work = taskRun("prepare-release", input, { checks: true, git: "clean" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "verify" }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "failure" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Assess the current release candidate without editing. Check the requested scope, version consistency, change summary, compatibility, known risks, package/build evidence, and rollback notes. Put a concise release-note draft and readiness checklist in the summary. Return approved only when the supplied evidence supports Human consideration, otherwise blocked. Never tag, commit, push, publish, or deploy."), {
        approved: { target: "reviewResult", actions: ({ event }: { event: Event }) => work.capture("release-review", event) },
        blocked: { target: "failure", actions: ({ event }: { event: Event }) => work.capture("release-review", event) },
      }, { using: "reviewer", cwd: work.workspace }),
      reviewResult: operation(work.review, { approved: "approval", blocked: "failure" }),
      approval: human(() => work.humanPrompt("Sign off on this verified release candidate? This workflow does not publish it."), {
        submitted: [
          { guard: ({ event }: { event: Event }) => event.value === "approve", target: "success", actions: ({ event }: { event: Event }) => work.decision("release-candidate", event) },
          { target: "rejection", actions: ({ event }: { event: Event }) => work.decision("release-candidate", event) },
        ],
      }, { choices: ["approve", "reject"] }),
      ...resultStates(work, p),
    },
  });
}
