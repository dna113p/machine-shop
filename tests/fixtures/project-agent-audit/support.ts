import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The fixture pins the version-one JSON wire contract, not a helper export API.
export type Observation = {
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
};
export type AgentAudit = {
  observation: Observation | null;
  findings: { reason: string }[];
  nextActions: { command: string[]; effects: string; display: string }[];
};

export function adapter(base: string, config: Record<string, unknown> = {}, args: string[] = []) {
  mkdirSync(base, { recursive: true });
  const path = fileURLToPath(new URL("./adapter.mjs", import.meta.url));
  const calls = join(base, "inspection-calls.jsonl");
  const setupCalls = join(base, "setup-calls.jsonl");
  const sentinel = join(base, "setup-was-executed");
  const inspectConfig = join(base, "inspection-config.json");
  const setupConfig = join(base, "setup-config.json");
  writeFileSync(inspectConfig, JSON.stringify({ ...config, calls }));
  writeFileSync(setupConfig, JSON.stringify({ mode: "setup", calls: setupCalls, sentinel }));
  const integration = {
    inspect: [process.execPath, path, inspectConfig, ...args],
    setup: {
      command: [process.execPath, path, setupConfig, "a project with spaces", "owner's binding"],
      effects: "Creates or repairs the shared binding; may start a service, provision a manager, grant writes or incur model charges. Invoke separately under its permission contract.",
    },
  };
  return {
    integration, inspectConfig, calls, setupCalls, sentinel,
    invocations: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as { cwd: string; argv: string[] }) : [],
    assertNoSetup: () => {
      assert.equal(existsSync(sentinel), false, "audit must never execute setup");
      assert.equal(existsSync(setupCalls), false, "no setup or manager request is authorized by audit acceptance");
    },
  };
}

export function agentAudit(value: unknown): AgentAudit {
  assert.ok(value !== null && typeof value === "object" && "projectAgent" in value, "configured integration must appear as projectAgent in each JSON artifact");
  const section = (value as { projectAgent: AgentAudit }).projectAgent;
  assert.ok(section && typeof section === "object", "inspection has a deterministic assessment");
  assert.ok(Array.isArray(section.findings), "project-agent findings are separate from analyst route/gate findings");
  assert.ok(Array.isArray(section.nextActions), "setup is a separate next action");
  return section;
}

export function needsAttention(section: AgentAudit, expected: RegExp) {
  assert.ok(section.findings.length > 0, "unverifiable or unhealthy evidence must be an actionable finding");
  assert.match(section.findings.map(item => item.reason).join("\n"), expected);
  for (const finding of section.findings) assert.match(finding.reason, /\S.{10}/u, "a finding explains the problem and next step");
  const assessment = section as AgentAudit & { status?: string; healthy?: boolean; repaired?: boolean };
  assert.notEqual(assessment.healthy, true);
  assert.notEqual(assessment.repaired, true);
  assert.ok(!["ready", "healthy", "repaired"].includes(assessment.status ?? ""), "failure must not be labelled ready, healthy or repaired");
}

export function setupAction(section: AgentAudit, supplied: ReturnType<typeof adapter>["integration"]) {
  assert.equal(section.nextActions.length, 1, "show the one caller-supplied supported setup route");
  const action = section.nextActions[0]!;
  assert.deepEqual(action.command, supplied.setup.command, "only trusted input supplies the exact argv");
  assert.equal(action.effects, supplied.setup.effects);
  assert.match(action.display, /\S/u, "include shell-safe display separately from executable argv");
  return action;
}
