/** Resume without sharing any checkpoint or module state with the original run. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runtime } from "../runtime.ts";
import "./runtime-imports.ts";

const { assignment, answer } = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const ticketTask = (await import(pathToFileURL(resolve("ticket-task.ts")).href)).default;
const states: string[] = []; const prompts: string[] = []; const questions: unknown[] = [];
const ok = (type: string) => ({ type, summary: "The fake runner covers the greeting criterion" });
try {
  const result = await runtime.run(ticketTask(runtime, assignment), {
    agents: {
      investigator: request => { prompts.push(request.prompt); return ok("planned"); },
      tester: () => { throw new Error("Resume must use redGreen: false"); },
      implementer: request => { writeFileSync(join(request.cwd, "greeting.txt"), "hello\n"); return ok("completed"); },
      reviewer: async () => {
        await Promise.resolve();
        return states.at(-1) === "planReview" ? ok("approved") : { ...ok("approved"),
          criteria: [{ text: "greeting.txt contains hello", met: true, evidence: "greeting.txt:1" }],
          findings: [], newSinceLastRound: "none" };
      },
    },
    human: request => { questions.push(request); return answer; },
    ...(answer === undefined ? { onHumanSleep: (request: unknown) => { questions.push(request); } } : {}),
    onState: state => { states.push(String(state)); },
  });
  process.send?.({ state: result.value, states, prompts, questions });
} catch (error) {
  process.send?.({ error: String(error) }); process.exitCode = 1;
} finally { process.disconnect?.(); }
