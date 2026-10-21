/** A no-model ticket in its own process, with bounded, parent-controlled Operation barriers. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runtime, runtimeLocation } from "../runtime.ts";
import "./runtime-imports.ts";

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const { createRunStatusPublisher } = await import(runtimeLocation.endsWith(".ts")
  ? new URL("run-status.ts", runtimeLocation).href
  : import.meta.resolve("@dna113p/machines/run-status"));
const publisher = createRunStatusPublisher({
  id: process.env.MACHINES_RUN_PARENT!, machine: "ticket-task", path: resolve("ticket-task.ts"), cwd: process.cwd(),
});
const published = () => existsSync(process.env.MACHINES_RUN_STATUS_DIR!)
  ? readdirSync(process.env.MACHINES_RUN_STATUS_DIR!).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(process.env.MACHINES_RUN_STATUS_DIR!, name), "utf8"))) : [];
const ticketTask = (await import(pathToFileURL(resolve("ticket-task.ts")).href)).default;
const counts: Record<string, number> = {};
const releases = new Map<string, () => void>();
let state = "";
let live: any;
const send = (message: object) => process.send?.(message);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function point(stage: string, when: string) {
  const stem = `${stage}:${when}`;
  const key = `${stem}:${counts[stem] = (counts[stem] ?? 0) + 1}`;
  const held = config.hold.includes(key);
  // Install the listener before publishing the point so a fast parent cannot lose a release.
  const released = held ? new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Parent did not release ${key}`)), 20_000);
    releases.set(key, () => { clearTimeout(timeout); resolve(); });
  }) : undefined;
  send({ type: "point", key, held, data: live });
  if (released) await released;
}

process.on("message", (message: any) => {
  if (message.type === "release") { releases.get(message.key)?.(); releases.delete(message.key); }
  if (message.type === "inspect") {
    send({ type: "inspection", request: message.request, state, published: published() });
  }
});

const primitives = {
  ...runtime,
  // Wire the public workflow status channel to the real publisher, as the launcher does.
  status: (change: Parameters<typeof runtime.status>[0]) => {
    runtime.status(change);
    if (change.now !== undefined) publisher.update({ now: change.now ?? undefined });
  },
  data: <T extends object>(initial: T): T => { live = runtime.data(initial); return live; },
  operation: ((run: (...args: any[]) => any, on: any, options: any) => runtime.operation(async (...args: any[]) => {
    // As in execute() in ticket-task.test.ts, state observers catch up before the Operation starts.
    await Promise.resolve();
    const stage = state;
    await point(stage, "before");
    const event = await run(...args);
    await point(stage, "after");
    return event;
  }, on, options)) as typeof runtime.operation,
};
const ok = (type: string, summary: string) => ({ type, summary });
const reviewer = () => ({
  type: "approved", summary: "The scripted edit matches the criterion",
  criteria: [{ text: "greeting.txt contains hello", met: true, evidence: "greeting.txt:1" }],
  findings: [], newSinceLastRound: "none",
});
const staged = (role: string) => async (request: { cwd: string }) => {
  await Promise.resolve();
  await point(state, "agent");
  if (state === "falsify") return ok("sound", "The file and criterion are explicit");
  if (state === "plan") return ok("planned", "Change only the assigned greeting line and run the gate");
  if (state === "planReview") return ok("approved", "The plan covers the ticket");
  if (role === "reviewer") return reviewer();
  if (role !== "implementer") throw new Error(`Unexpected ${role} in ${state}`);
  const file = join(request.cwd, "greeting.txt");
  const before = readFileSync(file, "utf8");
  if (!before.includes(config.from)) throw new Error(`Missing scripted line ${config.from}`);
  writeFileSync(file, before.replace(config.from, config.to));
  return ok("completed", "Changed the assigned greeting line");
};

try {
  const result = await runtime.run(ticketTask(primitives, config.assignment), {
    agents: Object.fromEntries(["investigator", "tester", "implementer", "reviewer"].map(role => [role, staged(role)])),
    human: () => { throw new Error("A repository turn must not ask a person"); },
    onState: value => { state = String(value); publisher.update({ state: value }); send({ type: "state", state }); },
  });
  publisher.finish({ state: result.value });
  send({ type: "result", state: result.value, output: result.output, data: live,
    published: published(),
    commit: git(config.assignment.repository.path, "rev-parse", config.branch) });
} catch (error) {
  publisher.finish({ error: String(error) });
  send({ type: "error", message: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
