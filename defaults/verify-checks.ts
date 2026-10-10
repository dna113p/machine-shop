import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, resultStates } from "./_machine-shop/task.ts";

export const description = "Run explicit local checks without an Agent and retain real exit codes, logs, and a result receipt.";

export default function verifyChecks(p: MachinePrimitives, input: unknown) {
  const { machine, operation } = p;
  const work = taskRun("verify-checks", input, { checks: true, git: "none" });
  return machine({
    initial: "start", output: work.output,
    states: {
      start: operation(work.start, { started: "verify" }),
      verify: operation(() => work.checks(), { passed: "success", failed: "checkFailure" }),
      checkFailure: operation(() => {
        work.finish("blocked");
        throw new Error(`Required checks failed; inspect ${String(work.output()?.report)}`);
      }, {}),
      ...resultStates(work, p),
    },
  });
}
