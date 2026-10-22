import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Caller-owned commands. Adapter output is evidence and can never supply these. */
export interface ProjectAgentInput {
  inspect: string[];
  setup?: { command: string[]; effects: string };
}
export interface ProjectAgentObservation {
  version: 1;
  project: string;
  observedAt: string;
  binding: { reference: string; revision: string } | null;
  provider: { id: string; name: string };
  agent: { id: string; name: string } | null;
  capabilities: string[];
  limits: string[];
  state: "missing" | "ready" | "offline" | "wrong-project" | "unsupported";
  explanation: string;
}
export interface ProjectAgentAudit {
  inspectedAt: string;
  status: "inspected" | "setup-needed" | "unverifiable";
  observation: ProjectAgentObservation | null;
  findings: { reason: string }[];
  nextActions: { command: string[]; effects: string; display: string }[];
}
const timeoutMs = 10_000;
const outputLimit = 65_536;
const freshnessMs = 300_000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 4000 && !value.includes("\0");
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function argv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && text(value[0])
    && value.every(part => typeof part === "string" && !part.includes("\0")) && Buffer.byteLength(JSON.stringify(value)) <= 8000;
}
export function parseProjectAgentInput(value: unknown): ProjectAgentInput {
  if (!object(value) || !keys(value, ["inspect", "setup"]) || !argv(value.inspect)) throw new Error("projectAgent needs caller-supplied inspect argv; shell, env and permissions are not accepted");
  const inspect = [...value.inspect];
  if (value.setup === undefined) return { inspect };
  const setup = value.setup;
  if (!object(setup) || !keys(setup, ["command", "effects"]) || !argv(setup.command) || !text(setup.effects)) {
    throw new Error("projectAgent.setup needs command argv and a non-empty effects description");
  }
  // Reserve a bounded section for the complete route, including shell quoting and HTML expansion.
  const displayBytes = (value: string) => Buffer.byteLength(value.replace(/[&<>"']/gu, "&quot;"));
  if (displayBytes(displayArgv(setup.command)) + displayBytes(setup.effects) > 16_000) throw new Error("projectAgent.setup command and effects exceed the 16,000-byte escaped display budget");
  // Own the arrays, including across a caller's later mutations.
  return { inspect, setup: { command: [...setup.command], effects: setup.effects } };
}
/** POSIX shell display only, never an execution input. Quote every word, including empty ones. */
export const displayArgv = (command: string[]) => command.map(part => `'${part.replaceAll("'", "'\"'\"'")}'`).join(" ");

function observation(value: unknown): ProjectAgentObservation {
  // Reject extensions (especially credentials/commands), rather than persisting raw provider data.
  if (!object(value) || !keys(value, ["version", "project", "observedAt", "binding", "provider", "agent", "capabilities", "limits", "state", "explanation"])) throw new Error("Invalid project-agent schema; use only documented credential-free fields");
  if (value.version !== 1) throw new Error("Unsupported project-agent schema version; use version 1");
  const identity = (item: unknown) => object(item) && keys(item, ["id", "name"]) && text(item.id) && text(item.name);
  const strings = (item: unknown) => Array.isArray(item) && item.length <= 100 && item.every(text);
  if (!text(value.project) || !isAbsolute(value.project)) throw new Error("Invalid project identity; supply the canonical absolute project path");
  if (!text(value.observedAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value.observedAt)
    || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString().slice(0, 19) !== value.observedAt.slice(0, 19)) throw new Error("Invalid observedAt time; supply a valid UTC ISO timestamp");
  if (!identity(value.provider) || (value.agent !== null && !identity(value.agent))) throw new Error("Invalid provider or agent identity");
  if (value.binding !== null && (!object(value.binding) || !keys(value.binding, ["reference", "revision"]) || !text(value.binding.reference) || !text(value.binding.revision))) throw new Error("Invalid binding identity; supply reference and revision or explicit null");
  if (!["missing", "ready", "offline", "wrong-project", "unsupported"].includes(value.state as string)) throw new Error("Invalid project-agent state");
  if (value.state === "ready" && (value.binding === null || value.agent === null)) throw new Error("Ready evidence requires binding reference, revision and agent identity");
  if (!strings(value.capabilities) || !strings(value.limits) || !text(value.explanation)) throw new Error("Invalid project-agent capabilities, limits or explanation schema");
  return value as unknown as ProjectAgentObservation;
}

/** Reassess the persisted snapshot on report/resume. This never invokes the provider. */
export function assessProjectAgent(audit: ProjectAgentAudit, input: ProjectAgentInput, project: string, now = Date.now()): ProjectAgentAudit {
  const observed = audit.observation;
  let reason = audit.findings[0]?.reason ?? "Project-agent inspection is unavailable; inspect with the supported provider interface";
  let status: ProjectAgentAudit["status"] = "unverifiable";
  if (observed) {
    const age = now - Date.parse(observed.observedAt);
    let canonical: string | null = null;
    try { canonical = realpathSync(project); } catch { /* Unavailable identity is a finding too. */ }
    if (canonical === null || observed.project !== canonical) reason = "Project-agent project identity unavailable or mismatch; inspect the binding for this audited project";
    else if (age < 0 || Date.parse(observed.observedAt) > Date.parse(audit.inspectedAt)) reason = "Project-agent observation time is in the future of inspection; correct the adapter clock and inspect again";
    else if (!Number.isFinite(age) || age > freshnessMs) reason = "Project-agent observation is stale (five-minute freshness limit); inspect again before relying on readiness";
    else if (observed.state === "ready") return { inspectedAt: audit.inspectedAt, status: "inspected", observation: observed, findings: [], nextActions: [] };
    else {
      status = "setup-needed";
      reason = `Project-agent binding is ${observed.state}: ${observed.explanation} Use the supported setup/repair route separately, or check provider availability and inspect again.`;
    }
  }
  return { inspectedAt: audit.inspectedAt, status, observation: observed, findings: [{ reason }], nextActions: input.setup ? [{ ...input.setup, command: [...input.setup.command], display: displayArgv(input.setup.command) }] : [] };
}

/** One bounded read-only inspection, no shell, no stdin, no raw failure output in evidence. */
export async function inspectProjectAgent(project: string, input: ProjectAgentInput): Promise<ProjectAgentAudit> {
  const executed = await new Promise<{ stdout?: string; failure?: string }>(resolve => {
    let child: ReturnType<typeof spawn>;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => stop("Project-agent inspection timed out after 10 seconds; check the supported adapter and retry"), timeoutMs);
    const complete = (result: { stdout?: string; failure?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (failure: string) => {
      if (settled) return;
      // Kill the local inspection group too, so descendants cannot hold output pipes open.
      if (child?.pid) {
        try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      child?.stdout?.destroy(); child?.stderr?.destroy();
      complete({ failure });
    };
    try {
      child = spawn(input.inspect[0]!, input.inspect.slice(1), { cwd: project, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      const consume = (chunk: Buffer, stdout: boolean) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > outputLimit) return stop("Project-agent inspection exceeded the 64 KiB combined output limit; reduce adapter output and inspect again");
        if (stdout) chunks.push(chunk);
      };
      child.stdout!.on("data", (chunk: Buffer) => consume(chunk, true));
      child.stderr!.on("data", (chunk: Buffer) => consume(chunk, false));
      child.stdout!.on("error", () => stop("Project-agent inspection output unavailable; check the supported adapter and inspect again"));
      child.stderr!.on("error", () => stop("Project-agent inspection output unavailable; check the supported adapter and inspect again"));
      child.on("error", () => stop("Project-agent inspection executable unavailable or launch failed; verify the caller-supplied supported adapter"));
      child.on("close", code => {
        if (code !== 0) return complete({ failure: "Project-agent inspection exited unsuccessfully; check provider availability and inspect again" });
        try { complete({ stdout: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) }); }
        catch { complete({ failure: "Invalid project-agent JSON encoding; supply UTF-8 and inspect again" }); }
      });
    } catch { stop("Project-agent inspection executable unavailable or launch failed; verify the caller-supplied supported adapter"); }
  });
  let observed: ProjectAgentObservation | null = null;
  let failure = executed.failure;
  if (!failure) {
    let parsed: unknown;
    try { parsed = JSON.parse(executed.stdout!); } catch { failure = "Malformed project-agent JSON; fix the adapter contract and inspect again"; }
    if (!failure) try { observed = observation(parsed); } catch (error) { failure = `${(error as Error).message}; fix the adapter contract and inspect again`; }
  }
  return assessProjectAgent({ inspectedAt: new Date().toISOString(), status: "unverifiable", observation: observed, findings: failure ? [{ reason: failure }] : [], nextActions: [] }, input, project);
}
