import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { runtime } from "./runtime.ts";

const names = ["verify-checks", "implement-task", "fix-bug", "refactor", "add-tests", "review-code", "investigate", "update-docs", "upgrade-dependency", "prepare-release"];
const modules = Object.fromEntries(await Promise.all(names.map(async name => [name, await import(pathToFileURL(resolve("defaults", `${name}.ts`)).href)])));
const ok = (type = "completed", summary = "Evidence from the bounded fake runner") => ({ type, summary });
const command = (code = 'console.log("check passed")', extra = {}) => ({ name: "tests", command: [process.execPath, "-e", code], ...extra });
const input = (workspace: string, extra = {}) => ({ task: "A bounded test assignment", workspace, checks: [command()], ...extra });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo(context: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "dev-default-test-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "config", "user.name", "Fixture");
  writeFileSync(join(cwd, ".gitignore"), ".machine-runs/\n");
  writeFileSync(join(cwd, "code.txt"), "old");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "baseline");
  return cwd;
}
async function execute(name: string, assignment: unknown, agents = {}, options = {}) {
  const states: string[] = [];
  const result = await runtime.run(modules[name].default(runtime, assignment), {
    agents, human: () => { throw new Error("Unexpected Human request"); },
    onState: state => states.push(String(state)), ...options,
  });
  return { state: result.value, output: result.output as any, states };
}
function receipts(cwd: string) {
  const directory = join(cwd, ".machine-runs/dev-machines");
  return readdirSync(directory).map(id => JSON.parse(readFileSync(join(directory, id, "result.json"), "utf8")));
}

test("all defaults export discoverable metadata and construct without effects", context => {
  const cwd = repo(context);
  for (const name of names) {
    const mod = modules[name];
    assert.match(mod.description, /\S/u); assert.doesNotMatch(mod.description, /\n/u);
    const data = input(cwd, ["review-code", "investigate"].includes(name) ? { checks: [] } : {});
    if (name === "fix-bug") Object.assign(data, { regression: { ...command(), failureExitCode: 1, failureIncludes: "assertion" } });
    const definition = mod.default(runtime, data);
    assert.deepEqual(runtime.requiredAgentNames(definition), Object.keys(mod.agentRoles ?? {}).sort());
  }
  assert.equal(existsSync(join(cwd, ".machine-runs")), false);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

for (const [name, role] of [["implement-task", "implementer"], ["refactor", "implementer"], ["add-tests", "tester"], ["update-docs", "writer"]]) {
  test(`${name} changes, verifies, reviews, and returns inspectable evidence without commits`, async context => {
    const cwd = repo(context); const head = git(cwd, "rev-parse", "HEAD");
    const result = await execute(name!, input(cwd), {
      [role!]: request => { assert.equal(request.cwd, cwd); writeFileSync(join(cwd, "change.txt"), name!); return ok(); },
      reviewer: request => { assert.match(request.prompt, /Do not edit/u); return ok("approved"); },
    });
    assert.equal(result.state, "done"); assert.equal(result.output.outcome, "completed");
    assert.equal(result.output.checksPassed, true); assert.equal(result.output.agentInvocations, 2);
    assert.equal(git(cwd, "rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(cwd, "change.txt"), "utf8"), name);
    assert.deepEqual(JSON.parse(readFileSync(result.output.report, "utf8")), result.output);
    assert.ok(result.output.checks.every(c => c.exitCode === 0 && existsSync(c.log)));
    if (["refactor", "add-tests"].includes(name!)) assert.ok(result.states.indexOf("baseline") < result.states.indexOf("change"));
  });
}

for (const name of ["refactor", "add-tests", "upgrade-dependency"]) {
  test(`${name} fails its baseline before any model or Human work`, async context => {
    const cwd = repo(context); let calls = 0;
    const agents = Object.fromEntries(Object.keys(modules[name].agentRoles).map(role => [role, () => { calls++; return ok(); }]));
    const result = await execute(name, input(cwd, { checks: [command("process.exit(2)")] }), agents);
    assert.equal(result.state, "blocked"); assert.equal(calls, 0);
    assert.equal(result.output.checks[0].phase, "baseline");
  });
}

for (const maxRepairs of [0, 1, 3]) {
  test(`failed checks enforce a ${maxRepairs}-repair budget without reaching review`, async context => {
    const cwd = repo(context); let edits = 0; let reviews = 0;
    const result = await execute("implement-task", input(cwd, { maxRepairs, checks: [command("process.exit(1)")] }), {
      implementer: () => { edits++; return ok(); }, reviewer: () => { reviews++; return ok("approved"); },
    });
    assert.equal(result.state, "blocked"); assert.equal(result.output.outcome, "blocked");
    assert.equal(edits, 1 + maxRepairs); assert.equal(reviews, 0); assert.equal(result.output.checksPassed, false);
    assert.match(result.output.reason, /budget exhausted/iu);
  });
}

test("a failed check can be repaired only by rerunning it on the changed candidate", async context => {
  const cwd = repo(context); let calls = 0;
  const result = await execute("implement-task", input(cwd, { checks: [command('process.exit(require("fs").readFileSync("code.txt", "utf8") === "fixed" ? 0 : 1)')] }), {
    implementer: request => { calls++; if (calls === 2) { assert.match(request.prompt, /Current failure/u); writeFileSync(join(cwd, "code.txt"), "fixed"); } return ok(); },
    reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done"); assert.equal(calls, 2);
  assert.deepEqual(result.output.checks.map(c => c.passed), [false, true]);
});

test("review feedback causes fresh checks and another review", async context => {
  const cwd = repo(context); let edits = 0; let reviews = 0;
  const result = await execute("implement-task", input(cwd), {
    implementer: request => { if (++edits === 2) assert.match(request.prompt, /Handle the empty case/u); return ok(); },
    reviewer: () => ++reviews === 1 ? ok("revise", "Handle the empty case") : ok("approved"),
  });
  assert.equal(result.state, "done"); assert.equal(edits, 2); assert.equal(reviews, 2);
  assert.equal(result.output.checks.length, 2);
});

test("repeated review findings cannot create an unbounded loop", async context => {
  const cwd = repo(context);
  const result = await execute("implement-task", input(cwd), { implementer: () => ok(), reviewer: () => ok("revise") });
  assert.equal(result.state, "blocked"); assert.equal(result.output.agentInvocations, 4);
});

test("a reviewer changing the checkout cannot approve stale checks", async context => {
  const cwd = repo(context);
  const result = await execute("implement-task", input(cwd), {
    implementer: () => ok(), reviewer: () => { writeFileSync(join(cwd, "code.txt"), "unexpected"); return ok("approved"); },
  });
  assert.equal(result.state, "blocked"); assert.match(result.output.reason, /read-only stage/u);
  assert.equal(readFileSync(join(cwd, "code.txt"), "utf8"), "unexpected");
});

test("dirty editing checkout is rejected before effects", async context => {
  const cwd = repo(context); writeFileSync(join(cwd, "code.txt"), "user changes");
  await assert.rejects(execute("implement-task", input(cwd), { implementer: () => assert.fail(), reviewer: () => assert.fail() }), /clean checkout/u);
  assert.equal(existsSync(join(cwd, ".machine-runs")), false);
  assert.equal(readFileSync(join(cwd, "code.txt"), "utf8"), "user changes");
});

test("read-only reviews preserve existing dirty and untracked files", async context => {
  const cwd = repo(context); writeFileSync(join(cwd, "code.txt"), "user changes"); writeFileSync(join(cwd, "notes.txt"), "notes");
  const result = await execute("review-code", input(cwd, { checks: [] }), { reviewer: () => ok("reviewed", "One finding at code.txt:1") });
  assert.equal(result.state, "done"); assert.equal(result.output.checksPassed, null);
  assert.match(result.output.agents[0].summary, /code.txt:1/u);
  assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "notes");
});

test("read-only review detects changed untracked content", async context => {
  const cwd = repo(context); writeFileSync(join(cwd, "notes.txt"), "notes");
  const result = await execute("review-code", input(cwd, { checks: [] }), { reviewer: () => { writeFileSync(join(cwd, "notes.txt"), "changed"); return ok("reviewed"); } });
  assert.equal(result.state, "blocked");
});

test("investigation is evidence-challenged and bounded", async context => {
  const cwd = repo(context); let investigations = 0; let reviews = 0;
  const result = await execute("investigate", input(cwd, { checks: [] }), {
    investigator: request => { if (++investigations === 2) assert.match(request.prompt, /Check the call site/u); return ok(); },
    reviewer: () => ++reviews === 1 ? ok("revise", "Check the call site") : ok("approved"),
  });
  assert.equal(result.state, "done"); assert.equal(investigations, 2); assert.equal(reviews, 2);
});

test("investigation source edits block before a second agent runs", async context => {
  const cwd = repo(context);
  const result = await execute("investigate", input(cwd, { checks: [] }), {
    investigator: () => { writeFileSync(join(cwd, "code.txt"), "changed"); return ok(); }, reviewer: () => assert.fail(),
  });
  assert.equal(result.state, "blocked");
});

const regression = (code?: string) => ({ name: "regression", command: [process.execPath, "-e", code ?? 'if(require("fs").readFileSync("code.txt","utf8")!=="fixed"){console.error("expected behavior missing");process.exit(1)}'], failureExitCode: 1, failureIncludes: "expected behavior missing" });
test("bugfix establishes an exact red signal, green regression, full checks, then review", async context => {
  const cwd = repo(context);
  const result = await execute("fix-bug", input(cwd, { regression: regression() }), {
    tester: () => ok(), implementer: () => { writeFileSync(join(cwd, "code.txt"), "fixed"); return ok(); }, reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done");
  assert.deepEqual(result.output.checks.map(c => [c.phase, c.exitCode, c.passed]), [["regression-red", 1, true], ["regression-green", 0, true], ["verify", 0, true]]);
});
for (const [label, code] of [["already passing", "process.exit(0)"], ["wrong diagnostic", "process.exit(1)"], ["wrong exit", 'console.log("expected behavior missing");process.exit(2)']]) {
  test(`bugfix refuses ${label} as regression evidence`, async context => {
    const cwd = repo(context);
    const result = await execute("fix-bug", input(cwd, { regression: regression(code) }), { tester: () => ok(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    assert.equal(result.state, "blocked"); assert.equal(result.output.checks[0].passed, false);
  });
}

test("bugfix retry budget applies to a still-red regression", async context => {
  const cwd = repo(context);
  const result = await execute("fix-bug", input(cwd, { regression: regression() }), { tester: () => ok(), implementer: () => ok(), reviewer: () => assert.fail() });
  assert.equal(result.state, "blocked"); assert.equal(result.output.agentInvocations, 3);
});

for (const answer of ["approve", "reject"]) {
  test(`dependency upgrade ${answer} routes through the exact Human decision`, async context => {
    const cwd = repo(context); let edited = 0;
    const result = await execute("upgrade-dependency", input(cwd), {
      analyst: () => ok("completed", "Proposed version and migration evidence"),
      implementer: () => { edited++; writeFileSync(join(cwd, "code.txt"), "upgraded"); return ok(); },
      reviewer: () => ok("approved"),
    }, { human: request => { assert.deepEqual(request.choices, ["approve", "reject"]); assert.match(request.prompt, /Proposed version/u); return answer; } });
    assert.equal(result.state, answer === "approve" ? "done" : "rejected");
    assert.equal(edited, answer === "approve" ? 1 : 0);
    assert.equal(result.output.decisions[0].response, answer);
  });
}

test("upgrade approval is invalidated by concurrent source changes", async context => {
  const cwd = repo(context);
  const result = await execute("upgrade-dependency", input(cwd), { analyst: () => ok(), implementer: () => assert.fail(), reviewer: () => assert.fail() }, {
    human: () => { writeFileSync(join(cwd, "code.txt"), "concurrent"); return "approve"; },
  });
  assert.equal(result.state, "blocked");
});

for (const answer of ["approve", "reject"]) {
  test(`release candidate ${answer} produces a receipt, never a commit or publication`, async context => {
    const cwd = repo(context); const head = git(cwd, "rev-parse", "HEAD");
    const result = await execute("prepare-release", input(cwd), { reviewer: () => ok("approved", "Draft release notes and checklist") }, { human: () => answer });
    assert.equal(result.state, answer === "approve" ? "done" : "rejected");
    assert.equal(git(cwd, "rev-parse", "HEAD"), head); assert.equal(git(cwd, "status", "--porcelain"), "");
  });
}

test("release cannot complete when its candidate changes while awaiting approval", async context => {
  const cwd = repo(context);
  const result = await execute("prepare-release", input(cwd), { reviewer: () => ok("approved") }, {
    human: () => { writeFileSync(join(cwd, "code.txt"), "different candidate"); return "approve"; },
  });
  assert.equal(result.state, "blocked"); assert.match(result.output.reason, /no longer matches/u);
});

test("release checks block before review or Human approval", async context => {
  const cwd = repo(context);
  const result = await execute("prepare-release", input(cwd, { checks: [command("process.exit(2)")] }), { reviewer: () => assert.fail() });
  assert.equal(result.state, "blocked");
});

test("Agent blockers are returned with their evidence", async context => {
  const cwd = repo(context);
  const result = await execute("implement-task", input(cwd), { implementer: () => ok("blocked", "Required API specification unavailable"), reviewer: () => assert.fail() });
  assert.equal(result.state, "blocked"); assert.match(result.output.reason, /specification unavailable/u);
});

test("malformed Agent output fails rather than manufacturing success", async context => {
  const cwd = repo(context);
  await assert.rejects(execute("review-code", input(cwd, { checks: [] }), { reviewer: () => ({ type: "reviewed" }) }), /non-empty summary/u);
});

for (const [label, fields] of [
  ["empty checks", { checks: [] }], ["relative workspace", { workspace: "." }], ["unbounded retries", { maxRepairs: 4 }],
  ["shell command string", { checks: [{ name: "tests", command: "npm test" }] }],
  ["unknown field", { autoApprove: true }], ["duplicate checks", { checks: [command(), command()] }],
  ["invalid timeout", { checks: [command("", { timeoutMs: 0 })] }],
]) {
  test(`invalid ${label} is rejected before execution`, context => {
    const cwd = repo(context);
    assert.throws(() => modules["implement-task"].default(runtime, input(cwd, fields)));
    assert.equal(existsSync(join(cwd, ".machine-runs")), false);
  });
}

test("verify-checks is model-free, accepts JSON text, and retains distinct receipts", async context => {
  const cwd = repo(context);
  const first = await execute("verify-checks", JSON.stringify(input(cwd)));
  const second = await execute("verify-checks", input(cwd));
  assert.equal(first.state, "done"); assert.equal(first.output.agentInvocations, 0);
  assert.notEqual(first.output.report, second.output.report); assert.equal(receipts(cwd).length, 2);
});

for (const [label, check] of [
  ["nonzero exit", command("process.exit(2)")],
  ["missing executable", { name: "missing", command: ["/definitely/missing/dev-machine-test"] }],
  ["timeout", command("setInterval(()=>{},100)", { timeoutMs: 25 })],
  ["excess output", command('process.stdout.write("x".repeat(2*1024*1024))')],
]) {
  test(`verify-checks records ${label} and fails its run`, async context => {
    const cwd = repo(context);
    await assert.rejects(execute("verify-checks", input(cwd, { checks: [check] })), /Required checks failed/u);
    const receipt = receipts(cwd)[0]; assert.equal(receipt.outcome, "blocked"); assert.equal(receipt.checksPassed, false);
    assert.equal(receipt.checks[0].passed, false);
  });
}

test("evidence directories cannot redirect writes through a symlink", async context => {
  const cwd = repo(context); const other = mkdtempSync(join(tmpdir(), "dev-default-other-"));
  context.after(() => rmSync(other, { recursive: true, force: true }));
  symlinkSync(other, join(cwd, ".machine-runs"), "dir");
  await assert.rejects(execute("verify-checks", input(cwd)), /Unsafe evidence directory/u);
  assert.deepEqual(readdirSync(other), []);
});

test("source-mutating validation cannot establish a green baseline", async context => {
  const cwd = repo(context);
  const result = await execute("refactor", input(cwd, {
    checks: [command('require("fs").writeFileSync("code.txt","mutated by check")')],
  }), { implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "blocked");
  assert.match(result.output.reason, /check changed the checkout/u);
});

test("regression evidence is rejected when the command changes source", async context => {
  const cwd = repo(context);
  const red = regression('require("fs").writeFileSync("code.txt","changed");console.log("expected behavior missing");process.exit(1)');
  const result = await execute("fix-bug", input(cwd, { regression: red }), {
    tester: () => ok(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  });
  assert.equal(result.state, "blocked");
  assert.match(result.output.reason, /regression command changed/u);
});

test("source drift at Human approval invalidates checksPassed in the receipt", async context => {
  const cwd = repo(context);
  const result = await execute("prepare-release", input(cwd), { reviewer: () => ok("approved") }, {
    human: () => { writeFileSync(join(cwd, "code.txt"), "changed"); return "approve"; },
  });
  assert.equal(result.output.checksPassed, false);
  assert.equal(result.output.outcome, "blocked");
});

test("workers receive their exact evidence directory", async context => {
  const cwd = repo(context);
  const result = await execute("review-code", input(cwd, { checks: [] }), {
    reviewer: request => {
      const match = request.prompt.match(/Read this run's check logs and stage reports in (.+)\. They are evidence/u);
      assert.ok(match); assert.equal(existsSync(join(match[1]!, "started.json")), true);
      return ok("reviewed");
    },
  });
  assert.equal(result.state, "done");
});

test("compatibility symlinks can identify the actual workspace", async context => {
  const cwd = repo(context);
  const alias = `${cwd}-alias`;
  symlinkSync(cwd, alias, "dir"); context.after(() => rmSync(alias));
  const result = await execute("review-code", input(alias, { checks: [] }), { reviewer: () => ok("reviewed") });
  assert.equal(result.state, "done");
});

test("documented JSON examples match their selected input contracts", () => {
  const examples = { verify: "verify-checks", implementation: "implement-task", bugfix: "fix-bug", review: "review-code", release: "prepare-release", upgrade: "upgrade-dependency" };
  for (const [example, name] of Object.entries(examples)) {
    const data = JSON.parse(readFileSync(resolve("examples", `${example}.json`), "utf8"));
    assert.doesNotThrow(() => modules[name].default(runtime, data));
  }
});
