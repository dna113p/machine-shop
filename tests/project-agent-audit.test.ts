import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditPage, parseAuditInput, type Inventory } from "../defaults/_machine-shop/audit.ts";
import { assessProjectAgent, type ProjectAgentAudit } from "../defaults/_machine-shop/project-agent.ts";
import { adapter, agentAudit, needsAttention, setupAction } from "./fixtures/project-agent-audit/support.ts";
import { runtime, runtimeLocation } from "./runtime.ts";

function fixture(context: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "project-agent-audit-"));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const shop = join(base, "shop");
  const home = join(base, "empty-home");
  cpSync(resolve("tests/fixtures/audit-project"), project, { recursive: true });
  mkdirSync(shop);
  mkdirSync(home);
  for (const name of ["defaults", "scripts", "package.json"]) cpSync(resolve(name), join(shop, name), { recursive: true });
  const runtimeRoot = runtimeLocation.endsWith(".ts")
    ? dirname(dirname(fileURLToPath(runtimeLocation)))
    : dirname(dirname(dirname(fileURLToPath(runtimeLocation))));
  for (const root of [project, shop]) {
    mkdirSync(join(root, "node_modules/@dna113p"), { recursive: true });
    symlinkSync(runtimeRoot, join(root, "node_modules/@dna113p/machines"), "dir");
  }
  const previous = process.env.MACHINES_USER_HOME;
  process.env.MACHINES_USER_HOME = home;
  context.after(() => {
    if (previous === undefined) delete process.env.MACHINES_USER_HOME;
    else process.env.MACHINES_USER_HOME = previous;
  });
  return { base, project, shop };
}

async function inspect(context: TestContext, config: Record<string, unknown>, args: string[] = [], change?: (integration: ReturnType<typeof adapter>["integration"]) => void) {
  const f = fixture(context);
  const a = adapter(f.base, config, args);
  change?.(a.integration);
  const mod = await import(pathToFileURL(join(f.shop, "defaults/audit-project.ts")).href);
  let calls = 0;
  const started = Date.now();
  const result = await runtime.run(mod.default(runtime, { project: f.project, projectAgent: a.integration }), {
    agents: { analyst: request => {
      calls++;
      // No presets, tools, paid Agents or live services are needed for this proposal.
      const inventory = JSON.parse(request.prompt.trim().split("\n").at(-1)!);
      return { type: "proposed", summary: JSON.stringify({
        defaults: inventory.defaults.map((item: { name: string }) => ({ name: item.name, action: "leave", reason: "Read-only fixture audit" })),
        routes: [], gates: inventory.gates, findings: [],
      }) };
    } },
    human: () => "skip",
  });
  const elapsed = Date.now() - started;
  a.assertNoSetup();
  assert.equal(result.value, "skipped", JSON.stringify(result.output));
  assert.equal(calls, 1, "provider failure does not hide the ordinary workflow audit");
  const root = join(f.project, ".machine-runs/machine-shop");
  const folders = readdirSync(root);
  assert.equal(folders.length, 1);
  const folder = join(root, folders[0]!);
  const read = (name: string) => JSON.parse(readFileSync(join(folder, name), "utf8"));
  const inventory = read("inventory.json");
  const report = read("audit.json");
  const receipt = read("result.json");
  const page = readFileSync(join(folder, "audit.html"), "utf8");
  const section = agentAudit(inventory);
  assert.deepEqual(agentAudit(report), section, "report and inventory must agree on the inspected evidence");
  assert.deepEqual(agentAudit(receipt), section, "result JSON retains the same findings and next actions");
  assert.ok(inventory.gates.found.some((gate: { class: string }) => gate.class === "tests"));
  assert.equal(a.invocations().length, a.integration.inspect[0] === process.execPath ? 1 : 0);
  assert.ok(Buffer.byteLength(page) < 200_000);
  return { ...f, ...a, section, inventory, report, receipt, page, elapsed, result, folder };
}

test("optional caller argv and setup effects survive object and JSON audit input parsing", () => {
  const projectAgent = {
    inspect: [process.execPath, "/trusted adapter.mjs", "literal;argument", ""],
    setup: { command: ["provider-adapter", "setup", "owner's project"], effects: "Creates a binding and may start a service; separate authorization is required." },
  };
  for (const input of [{ project: "/tmp/project", projectAgent }, JSON.stringify({ project: "/tmp/project", projectAgent })]) {
    const parsed = parseAuditInput(input) as ReturnType<typeof parseAuditInput> & { projectAgent?: unknown };
    assert.deepEqual(parsed.projectAgent, projectAgent);
  }
  assert.doesNotThrow(() => parseAuditInput({ project: "/tmp/project", projectAgent: { inspect: ["provider-adapter", "inspect"] } }));
});

test("integration rejects shell strings, invalid argv, omitted effects and adapter-selected permissions before execution", () => {
  const invalid = [
    null, [], "provider inspect", {},
    { inspect: "provider inspect" }, { inspect: [] }, { inspect: [""] }, { inspect: ["   "] },
    { inspect: ["provider", 7] }, { inspect: ["provider", "bad\0argument"] },
    { inspect: ["provider"], shell: true }, { inspect: ["provider"], env: { TOKEN: "credential" } },
    { inspect: ["provider"], permissions: ["write"] },
    { inspect: ["provider"], setup: { command: ["provider", "setup"] } },
    { inspect: ["provider"], setup: { command: "provider setup", effects: "Creates a binding" } },
    { inspect: ["provider"], setup: { command: [], effects: "Creates a binding" } },
    { inspect: ["provider"], setup: { command: ["provider", "bad\0argument"], effects: "Creates a binding" } },
    { inspect: ["provider"], setup: { command: ["provider"], effects: " " } },
  ];
  for (const projectAgent of invalid) assert.throws(() => parseAuditInput({ project: "/tmp/project", projectAgent }));
});

test("a setup route whose shell quoting would overwhelm HTML is rejected before inspection", () => {
  assert.throws(() => parseAuditInput({ project: "/tmp/project", projectAgent: {
    inspect: ["trusted-adapter", "inspect"],
    setup: { command: ["trusted-adapter", "'".repeat(2000)], effects: "Repair the shared binding separately" },
  } }), /display budget/u);
});

test("waiting cannot rehabilitate an observation that was future-dated at inspection", () => {
  const now = Date.now();
  const input = { inspect: ["trusted-adapter", "inspect"] };
  const audit: ProjectAgentAudit = {
    inspectedAt: new Date(now).toISOString(), status: "unverifiable", findings: [], nextActions: [],
    observation: {
      version: 1, project: realpathSync(process.cwd()), observedAt: new Date(now + 60_000).toISOString(),
      provider: { id: "fixture", name: "Fixture" }, agent: { id: "shared", name: "Shared agent" },
      binding: { reference: "fixture://binding", revision: "42" }, capabilities: [], limits: [],
      state: "ready", explanation: "A future claim is not fresh inspection evidence",
    },
  };
  for (const time of [now, now + 61_000]) needsAttention(assessProjectAgent(audit, input, process.cwd(), time), /future/iu);
});

for (const state of ["missing", "ready", "offline", "wrong-project", "unsupported"] as const) {
  test(`local adapter ${state} evidence is reported without a service dependency`, async context => {
    const run = await inspect(context, { snapshot: { state } });
    assert.equal(run.section.observation?.state, state);
    assert.equal(run.section.observation.project, realpathSync(run.project));
    assert.match(run.page, new RegExp(state, "u"));
    if (state === "ready") {
      assert.deepEqual(run.section.findings, []);
      assert.deepEqual(run.section.nextActions, []);
    } else {
      needsAttention(run.section, new RegExp(state.replace("-", "[- ]"), "iu"));
      setupAction(run.section, run.integration);
      assert.match(run.page, /setup|repair/iu);
    }
  });
}

test("ready observation preserves the actual provider, shared agent, binding revision, capabilities and limits", async context => {
  const run = await inspect(context, {});
  const observation = run.section.observation!;
  assert.equal(observation.version, 1);
  assert.deepEqual(observation.provider, { id: "fixture-provider", name: "Fixture provider" });
  assert.deepEqual(observation.agent, { id: "fixture-shared-agent", name: "Fixture shared agent" });
  assert.deepEqual(observation.binding, { reference: "fixture://project-agent/binding-17", revision: "revision-42" });
  assert.deepEqual(observation.capabilities, ["feedback", "read-project"]);
  assert.deepEqual(observation.limits, ["Observation only; no write-access or enforcement guarantee"]);
  assert.ok(Number.isFinite(Date.parse(observation.observedAt)));
  for (const fact of ["fixture-provider", "fixture-shared-agent", "revision-42", "binding-17", "feedback", "no write-access or enforcement guarantee"]) assert.ok(run.page.includes(fact), `HTML retains ${fact}`);
  assert.match(run.page, /observ(?:ed|ation)|snapshot/iu, "a snapshot does not establish enforcement");
});

const failures: [string, Record<string, unknown>, RegExp][] = [
  ["malformed JSON", { mode: "malformed" }, /JSON|malformed|invalid/iu],
  ["unsupported schema version", { snapshot: { version: 99 } }, /version|schema|unsupported/iu],
  ["malformed schema", { snapshot: { capabilities: "all permissions" } }, /schema|capabilit|invalid|malformed/iu],
  ["ready without binding identity", { snapshot: { binding: null } }, /binding|identity|invalid/iu],
  ["ready without revision", { snapshot: { binding: { reference: "fixture://binding" } } }, /revision|binding|invalid/iu],
  ["ready without an agent", { snapshot: { agent: null } }, /agent|identity|invalid/iu],
  ["unknown state", { snapshot: { state: "approved-and-enforced" } }, /state|invalid|unsupported/iu],
  ["different project despite ready claim", { snapshot: { project: "/tmp/a-different-project", state: "ready" } }, /project|mismatch/iu],
  ["relative project identity", { snapshot: { project: "." } }, /project|identity|invalid/iu],
  ["stale observation", { offsetMs: -301_000 }, /stale|expir|old|fresh/iu],
  ["future observation", { offsetMs: 60_000 }, /future|time|invalid/iu],
  ["invalid inspection time", { snapshot: { observedAt: "yesterday" } }, /time|observedAt|invalid/iu],
  ["timeout", { mode: "timeout" }, /time(?:d? ?out|out)|deadline/iu],
  ["oversized stdout", { mode: "oversized" }, /output|size|limit|64/iu],
  ["oversized combined output", { mode: "combined-output" }, /output|size|limit|64/iu],
  ["unsuccessful exit with a ready stdout claim", { mode: "exit" }, /exit|failed|unsuccess/iu],
];
for (const [name, config, reason] of failures) {
  test(`${name} becomes an actionable finding while workflow inventory remains available`, { timeout: 18_000 }, async context => {
    const run = await inspect(context, config);
    needsAttention(run.section, reason);
    setupAction(run.section, run.integration);
    assert.ok(run.elapsed < 13_000, "inspection has a ten-second deadline, including failures that leave the adapter alive");
    assert.doesNotMatch(JSON.stringify([run.inventory, run.report, run.receipt, run.page]), /FIXTURE_RAW_CREDENTIAL_DO_NOT_PUBLISH/u);
    assert.match(run.page, reason);
  });
}

test("an unavailable inspection executable is a finding, not a lost workflow audit", async context => {
  const run = await inspect(context, {}, [], integration => {
    integration.inspect = ["/definitely-unavailable-project-agent-adapter", "inspect"];
  });
  needsAttention(run.section, /unavailable|launch|executable|ENOENT|not found/iu);
  setupAction(run.section, run.integration);
});

test("inspection without a supplied setup route reports the gap without inventing a command", async context => {
  const run = await inspect(context, { snapshot: { state: "missing" } }, [], integration => {
    Reflect.deleteProperty(integration, "setup");
  });
  needsAttention(run.section, /missing/iu);
  assert.deepEqual(run.section.nextActions, [], "only the caller may supply a supported setup command");
  assert.match(run.page, /missing/iu);
});

test("inspection argv is literal, runs from the audited project, and setup display is shell-safe", async context => {
  const f = fixture(context);
  const marker = join(f.base, "shell-injection");
  const args = ["a literal space", "owner's project", `$(touch '${marker}')`, `; touch '${marker}'; #`, ""];
  // inspect owns its own disposable project; marker is only an injection sentinel.
  const run = await inspect(context, { snapshot: { state: "missing" } }, args, integration => {
    integration.setup.command.push(`$(touch '${marker}')`, "; echo unsafe", "");
  });
  assert.deepEqual(run.invocations(), [{ cwd: run.project, argv: args }]);
  assert.equal(existsSync(marker), false, "inspection must not invoke a shell");
  const action = setupAction(run.section, run.integration);
  // Parse the display with a harmless recorder as argv[0]. Never run setup.
  const recorder = join(run.base, "argv-recorder");
  writeFileSync(recorder, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  // All command words after the executable must round-trip, including quotes and empty arguments.
  // Extract only the displayed executable word; the rest remains exactly as rendered.
  const executable = action.display.match(/^(?:'[^']*'|"[^"]*"|\S+)/u)?.[0];
  assert.ok(executable);
  const displayWithRecorder = `'${recorder}'${action.display.slice(executable.length)}`;
  const recorded = execFileSync("/bin/sh", ["-c", displayWithRecorder], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(recorded), action.command.slice(1));
  assert.equal(existsSync(marker), false, "display must quote shell syntax as data");
  run.assertNoSetup();
});

test("adapter-supplied commands, credentials and permissions never become audit authority or persisted secrets", async context => {
  const run = await inspect(context, { snapshot: {
    state: "missing", token: "FIXTURE_RAW_CREDENTIAL_DO_NOT_PUBLISH",
    credentials: { apiKey: "FIXTURE_RAW_CREDENTIAL_DO_NOT_PUBLISH" },
    setup: { command: ["untrusted-manager", "start"], effects: "Grant all writes" },
    permissions: ["write-everywhere"], env: { TOKEN: "FIXTURE_RAW_CREDENTIAL_DO_NOT_PUBLISH" },
  } });
  needsAttention(run.section, /missing|schema|invalid|unsupported/iu);
  setupAction(run.section, run.integration);
  for (const name of readdirSync(run.folder)) {
    const path = join(run.folder, name);
    if (/\.(?:json|html|log|md|txt)$/u.test(name)) assert.doesNotMatch(readFileSync(path, "utf8"), /FIXTURE_RAW_CREDENTIAL_DO_NOT_PUBLISH|untrusted-manager|write-everywhere/u, `${name} must not persist adapter credentials or authority`);
  }
});

test("hostile provider strings are escaped data in a complete, bounded HTML report", async context => {
  const hostile = '<img src=x onerror="fixtureInjection()">&🛠️';
  const run = await inspect(context, { snapshot: {
    state: "offline", provider: { id: hostile, name: hostile }, agent: { id: hostile, name: hostile },
    binding: { reference: hostile, revision: hostile }, capabilities: [hostile], limits: [hostile],
    explanation: hostile.repeat(60),
  } }, [], integration => { integration.setup.effects = hostile; });
  const section = run.section;
  assert.equal(section.observation?.provider.id, hostile);
  assert.equal(section.observation?.binding?.revision, hostile);
  assert.equal(section.observation?.explanation, hostile.repeat(60));
  assert.ok(run.page.includes("&lt;img"));
  assert.doesNotMatch(run.page, /<img|<script|�/u);
  assert.equal((run.page.match(/<table\b/gu) ?? []).length, (run.page.match(/<\/table>/gu) ?? []).length);
  assert.ok(Buffer.byteLength(run.page) < 200_000);
  setupAction(section, run.integration);
});

test("saturated observation rendering reserves space for every contract field", () => {
  const now = new Date().toISOString();
  const limits = "Observation only; cannot enforce permissions or grant write access.";
  const explanation = "The shared agent is offline. Repair through the separately supplied setup route.";
  const inventory: Inventory = {
    project: process.cwd(), since: now, until: now, instructions: {}, scripts: {}, ci: {},
    gates: { found: [], missing: [] }, presets: [], bindings: { source: null, roles: {} },
    runtime: { pinned: null, installed: "fixture" }, catalogVersion: "fixture", defaults: [], custom: [],
    snapshot: "fixture", helpers: [], provenanceVersion: "fixture",
    runs: { stops: [], notEnded: [], unreadable: [], outcomes: {}, stopsByStage: {} },
  };
  for (const saturated of ['"'.repeat(500), '"'.repeat(4000), "<&🛠️>".repeat(500)]) {
    inventory.projectAgent = {
      inspectedAt: now, status: "setup-needed", findings: [], nextActions: [],
      observation: {
        version: 1, project: process.cwd(), observedAt: now, state: "offline",
        provider: { id: saturated, name: saturated }, agent: { id: saturated, name: saturated },
        binding: { reference: saturated, revision: saturated }, capabilities: [saturated],
        limits: [limits + saturated], explanation: explanation + saturated,
      },
    };
    const page = auditPage(inventory, { defaults: [], routes: [], gates: inventory.gates, findings: [] }, "skip");
    const observationTable = page.match(/<table><thead><tr><th>Observation<\/th>[\s\S]*?<\/table>/u)?.[0];
    assert.ok(observationTable);
    for (const field of ["Project", "Observed at", "State", "Provider", "Agent", "Binding reference", "Binding revision", "Capabilities", "Limits", "Explanation"]) {
      assert.ok(observationTable.includes(`<td>${field}</td><td>`), `HTML reserves a row for ${field}`);
    }
    assert.ok(observationTable.includes(limits));
    assert.ok(observationTable.includes(explanation));
    assert.ok(Buffer.byteLength(observationTable) <= 16_000);
    assert.ok(Buffer.byteLength(page) < 200_000);
    assert.equal((page.match(/<table\b/gu) ?? []).length, (page.match(/<\/table>/gu) ?? []).length);
    assert.doesNotMatch(page, /�/u);
  }
});

test("saturated observation fields cannot hide provider limits or explanation in HTML", async context => {
  const saturated = '"'.repeat(500);
  const limits = "Observation only; cannot enforce permissions or grant write access.";
  const explanation = "The shared agent is offline. Repair through the separately supplied setup route.";
  const run = await inspect(context, { snapshot: {
    state: "offline", provider: { id: saturated, name: saturated }, agent: { id: saturated, name: saturated },
    binding: { reference: saturated, revision: saturated }, capabilities: [saturated],
    limits: [limits + saturated], explanation: explanation + saturated,
  } });
  assert.deepEqual(run.section.observation?.limits, [limits + saturated]);
  assert.equal(run.section.observation?.explanation, explanation + saturated);
  const observationTable = run.page.match(/<table><thead><tr><th>Observation<\/th>[\s\S]*?<\/table>/u)?.[0];
  assert.ok(observationTable, "HTML includes the observation table");
  for (const field of ["Project", "Observed at", "State", "Provider", "Agent", "Binding reference", "Binding revision", "Capabilities", "Limits", "Explanation"]) {
    assert.ok(observationTable.includes(`<td>${field}</td><td>`), `HTML reserves a row for ${field}`);
  }
  assert.ok(observationTable.includes(limits), "provider limitations remain visible after saturated identity fields");
  assert.ok(observationTable.includes(explanation), "the actionable explanation remains visible in its observation row");
  assert.match(observationTable, /&quot;/u);
  assert.ok(Buffer.byteLength(observationTable) <= 16_000);
  assert.ok(Buffer.byteLength(run.page) < 200_000);
  setupAction(run.section, run.integration);
});

test("documentation exposes the optional adapter contract and separate supported setup route", () => {
  const guide = readFileSync(resolve("docs/workflows/audit-project.md"), "utf8");
  const examples = [...guide.matchAll(/```json\s*([\s\S]*?)```/gu)].flatMap(match => {
    try { return [JSON.parse(match[1]!)]; } catch { return []; }
  });
  assert.ok(examples.some(example => Array.isArray(example.projectAgent?.inspect) && Array.isArray(example.projectAgent?.setup?.command) && typeof example.projectAgent?.setup?.effects === "string"), "include a runnable generic JSON input example with caller argv and setup effects");
  for (const key of ["version", "project", "observedAt", "reference", "revision", "provider", "agent", "capabilities", "limits", "state", "explanation"]) assert.ok(guide.includes(key), `document adapter field ${key}`);
  assert.match(guide, /10[- ]second|10 seconds|10_000|10000/iu);
  assert.match(guide, /64\s*KiB|65[,_]?536/iu);
  assert.match(guide, /five[- ]minute|5[- ]minute|300[,_]?000/iu);
  assert.match(guide, /supported interface|supported.*(?:inspect|adapter)|discover/iu);
  assert.match(guide, /(?:never|not|separate)[^.\n]*(?:execut|setup)|setup[^.\n]*(?:separate|permission)/iu);
  assert.doesNotMatch(guide, /drip\s+[^\n`]*--(?:inspect|setup|project-agent)/iu, "use a generic example until Drip's installed contract is verified");
  for (const name of ["README.md", "docs/catalog.md"]) {
    const text = readFileSync(resolve(name), "utf8");
    assert.match(text, /projectAgent|project[- ]agent/iu, `${name} makes the optional integration discoverable`);
    assert.match(text, /audit-project\.md/u);
  }
});
