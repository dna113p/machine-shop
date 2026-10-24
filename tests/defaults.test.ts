import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { brief, firstLine } from "../defaults/_machine-shop/brief.ts";
// Read through the namespace so an export a test needs and the module lacks fails that test alone.
import * as brief_ from "../defaults/_machine-shop/brief.ts";
// Read through the namespace so an export a test needs and the module lacks fails that test alone.
import * as task from "../defaults/_machine-shop/task.ts";
import { taskRun } from "../defaults/_machine-shop/task.ts";
import { runtime } from "./runtime.ts";

const names = ["verify-checks", "implement-task", "fix-bug", "refactor", "add-tests", "review-code", "investigate", "update-docs", "upgrade-dependency", "prepare-release", "retrospective", "audit-project"];
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
  const directory = join(cwd, ".machine-runs/machine-shop");
  return readdirSync(directory).map(id => JSON.parse(readFileSync(join(directory, id, "result.json"), "utf8")));
}

test("all defaults export discoverable metadata and construct without effects", context => {
  const cwd = repo(context);
  for (const name of names) {
    const mod = modules[name];
    assert.match(mod.description, /\S/u); assert.doesNotMatch(mod.description, /\n/u);
    const data = input(cwd, ["review-code", "investigate"].includes(name) ? { checks: [] } : {});
    if (name === "fix-bug") Object.assign(data, { regression: { ...command(), failureExitCode: 1, failureIncludes: "assertion" } });
    const definition = mod.default(runtime, name === "retrospective" ? { workspaces: [cwd] } : name === "audit-project" ? { project: cwd } : data);
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

test("every gate runs even after one fails, and the repair prompt names each failure", async context => {
  const cwd = repo(context); let prompt = "";
  const checks = [
    { name: "lint", command: [process.execPath, "-e", "process.exit(1)"] },
    { name: "types", command: [process.execPath, "-e", "console.log('ok')"] },
    { name: "tests", command: [process.execPath, "-e", "process.exit(2)"] },
  ];
  const result = await execute("implement-task", input(cwd, { maxRepairs: 1, checks }), {
    implementer: request => { prompt = request.prompt; return ok(); }, reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "blocked");
  // Each round runs every gate, then each failed gate once more by itself.
  assert.deepEqual(result.output.checks.map(c => [c.name, c.passed]), [
    ["lint", false], ["types", true], ["tests", false], ["lint", false], ["tests", false],
    ["lint", false], ["types", true], ["tests", false], ["lint", false], ["tests", false],
  ]);
  assert.match(prompt, /2 checks did not meet their expected results: lint \(inspect [^)]*\/1\.log[^)]*\/4\.log\), tests \(inspect [^)]*\/3\.log[^)]*\/5\.log\)/u);
  assert.match(result.output.reason, /2 checks did not meet/u);
});

test("a failed check can be repaired only by rerunning it on the changed candidate", async context => {
  const cwd = repo(context); let calls = 0;
  const result = await execute("implement-task", input(cwd, { checks: [command('process.exit(require("fs").readFileSync("code.txt", "utf8") === "fixed" ? 0 : 1)')] }), {
    implementer: request => { calls++; if (calls === 2) { assert.match(request.prompt, /Current failure/u); writeFileSync(join(cwd, "code.txt"), "fixed"); } return ok(); },
    reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done"); assert.equal(calls, 2);
  assert.deepEqual(result.output.checks.map(c => c.passed), [false, false, true]);
});

/** A gate that fails its first `fails` runs and passes after them, printing and counting each run in a file outside the checkout. */
function counted(context: TestContext, name: string, fails: number) {
  const directory = mkdtempSync(join(tmpdir(), "dev-default-runs-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "runs");
  const code = `const fs = require("fs"); const runs = (fs.existsSync(process.argv[1]) ? Number(fs.readFileSync(process.argv[1], "utf8")) : 0) + 1;
fs.writeFileSync(process.argv[1], String(runs)); console.log(${JSON.stringify(name)} + " run " + runs); process.exit(runs <= ${fails} ? 1 : 0);`;
  return { gate: { name, command: [process.execPath, "-e", code, file] }, runs: () => existsSync(file) ? Number(readFileSync(file, "utf8")) : 0 };
}
type Entry = { name: string; passed: boolean; log: string; flaky?: boolean; rerun?: boolean };

test("a gate that fails and then passes when run once more by itself counts as passed, is marked flaky in the receipt with both outputs, and costs no repair round or Agent call", async context => {
  const cwd = repo(context); const tests = counted(context, "tests", 1); let edits = 0; let reviewed = "";
  const result = await execute("implement-task", input(cwd, { checks: [tests.gate] }), {
    implementer: () => { edits++; writeFileSync(join(cwd, "change.txt"), "change"); return ok(); },
    reviewer: request => { reviewed = request.prompt; return ok("approved"); },
  });
  assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
  assert.equal(result.output.checksPassed, true);
  assert.deepEqual([edits, tests.runs(), result.output.repairs, result.output.agentInvocations], [1, 2, 0, 2]);
  const receipt = JSON.parse(readFileSync(result.output.report, "utf8")); assert.deepEqual(receipt, result.output);
  assert.deepEqual(receipt.checks.map((c: Entry) => [c.name, c.passed, c.flaky]), [["tests", false, true], ["tests", true, true]]);
  const [first, second] = receipt.checks as Entry[];
  assert.notEqual(first!.log, second!.log);
  assert.match(readFileSync(first!.log, "utf8"), /tests run 1/u); assert.match(readFileSync(second!.log, "utf8"), /tests run 2/u);
  // The first run's failure does not stand as current feedback once the gate has passed.
  assert.doesNotMatch(reviewed, /did not meet its expected result/u);
});

test("a gate that fails again when run by itself is a failure with both outputs, and the repair round sees it as today", async context => {
  const cwd = repo(context); const prompts: string[] = [];
  const result = await execute("implement-task", input(cwd, { maxRepairs: 1, checks: [command('process.exit(require("fs").readFileSync("code.txt", "utf8") === "fixed" ? 0 : 1)')] }), {
    implementer: request => { if (prompts.push(request.prompt) === 2) writeFileSync(join(cwd, "code.txt"), "fixed"); return ok(); },
    reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done", result.output?.reason);
  assert.deepEqual([prompts.length, result.output.repairs], [2, 1]);
  const checks = result.output.checks as Entry[];
  assert.deepEqual(checks.map(c => [c.passed, c.flaky === true, c.rerun === true]), [[false, false, false], [false, false, true], [true, false, false]]);
  assert.ok(checks.every(c => existsSync(c.log)));
  const feedback = prompts[1]!.split("Current failure/feedback: ")[1] ?? "";
  assert.ok(feedback.startsWith("verify: tests did not meet its expected result; inspect "), feedback);
  for (const entry of checks.slice(0, 2)) assert.ok(feedback.includes(entry.log), entry.log);
});

test("flaky status describes only the latest check round while earlier evidence remains intact", context => {
  const cwd = repo(context); const tests = counted(context, "tests", 1);
  const saved = task.taskData();
  const work = taskRun("flaky-rounds", input(cwd, { checks: [tests.gate] }), { checks: true, git: "clean" }, saved);
  work.start();
  assert.equal(work.checks("baseline").type, "passed");
  assert.deepEqual(saved.flaky, ["tests"]);
  assert.equal(saved.reason, "");
  assert.equal(work.checks().type, "passed");
  assert.deepEqual(saved.flaky, []);
  assert.deepEqual(saved.evidence.map(entry => [entry.phase, entry.passed, entry.flaky === true]), [
    ["baseline", false, true], ["baseline", true, true], ["verify", true, false],
  ]);
  // Runs saved before this field existed can still verify and initialize it.
  const legacy = JSON.parse(JSON.stringify(saved)); delete legacy.flaky;
  const resumed = taskRun("flaky-rounds", input(cwd, { checks: [tests.gate] }), { checks: true, git: "clean" }, legacy);
  assert.equal(resumed.checks().type, "passed");
  assert.deepEqual(legacy.flaky, []);
  assert.equal(tests.runs(), 4);
});

test("only failed gates are run again, each once, after every gate has run", async context => {
  const cwd = repo(context);
  const [lint, tests, types] = [counted(context, "lint", 0), counted(context, "tests", 1), counted(context, "types", 99)];
  await assert.rejects(execute("verify-checks", input(cwd, { checks: [lint.gate, tests.gate, types.gate] })), /Required checks failed/u);
  const [receipt] = receipts(cwd);
  assert.deepEqual(receipt.checks.map((c: Entry) => [c.name, c.passed, c.flaky === true, c.rerun === true]), [
    ["lint", true, false, false], ["tests", false, true, false], ["types", false, false, false], ["tests", true, true, false], ["types", false, false, true],
  ]);
  assert.deepEqual([lint.runs(), tests.runs(), types.runs()], [1, 2, 2]);
  assert.equal(receipt.checksPassed, false);
  // The flaky gate passed, so only the gate that failed twice is named, with both of its outputs.
  assert.ok(receipt.reason.includes(receipt.checks[2].log) && receipt.reason.includes(receipt.checks[4].log), receipt.reason);
  assert.equal(receipt.reason.includes(receipt.checks[1].log), false, receipt.reason);
});

test("rerunFailedChecks: false runs each gate once, as today", async context => {
  const cwd = repo(context); let prompt = "";
  const checks = [
    { name: "lint", command: [process.execPath, "-e", "process.exit(1)"] },
    { name: "types", command: [process.execPath, "-e", "console.log('ok')"] },
    { name: "tests", command: [process.execPath, "-e", "process.exit(2)"] },
  ];
  const result = await execute("implement-task", input(cwd, { maxRepairs: 1, checks, rerunFailedChecks: false }), {
    implementer: request => { prompt = request.prompt; return ok(); }, reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.output.checks.map(c => [c.name, c.passed]), [["lint", false], ["types", true], ["tests", false], ["lint", false], ["types", true], ["tests", false]]);
  assert.match(prompt, /2 checks did not meet their expected results: lint \(inspect .*1\.log\), tests \(inspect .*3\.log\)/u);
  // A gate that would pass the second time is not given one.
  const other = repo(context); const flaky = counted(context, "tests", 1);
  await assert.rejects(execute("verify-checks", input(other, { checks: [flaky.gate], rerunFailedChecks: false })), /Required checks failed/u);
  const [receipt] = receipts(other);
  assert.deepEqual([flaky.runs(), receipt.checks.map((c: Entry) => [c.passed, c.flaky === true])], [1, [[false, false]]]);
  // On, as by default, the same gate passes as flaky.
  const third = repo(context); const again = counted(context, "tests", 1);
  assert.equal((await execute("verify-checks", input(third, { checks: [again.gate], rerunFailedChecks: true }))).state, "done");
  assert.equal(again.runs(), 2);
});

test("a non-boolean rerunFailedChecks is refused before execution", context => {
  const cwd = repo(context);
  for (const value of ["no", 0, null]) {
    assert.throws(() => modules["implement-task"].default(runtime, input(cwd, { rerunFailedChecks: value })), /rerunFailedChecks must be a boolean/u);
  }
  assert.equal(existsSync(join(cwd, ".machine-runs")), false);
});

test("read-only workflows refuse rerunFailedChecks, since they run no checks", context => {
  const cwd = repo(context);
  for (const name of ["review-code", "investigate"]) {
    assert.throws(() => modules[name].default(runtime, input(cwd, { checks: [], rerunFailedChecks: false })), name);
  }
  assert.equal(existsSync(join(cwd, ".machine-runs")), false);
});

/** A blocking review finding of one kind; a kind left out stands for `other`. */
const blocker = (text: string, kind?: string) => ({ severity: "blocker", ...(kind === undefined ? {} : { kind }), text, where: "code.txt:1" });
const revise = (summary: string, findings: unknown[]) => ({ type: "revise", summary, findings });

test("a regression blocker in review causes one repair, fresh checks and another review", async context => {
  const cwd = repo(context); let edits = 0; let reviews = 0;
  const result = await execute("implement-task", input(cwd), {
    implementer: request => { if (++edits === 2) assert.match(request.prompt, /Handle the empty case/u); return ok(); },
    reviewer: () => ++reviews === 1 ? revise("Handle the empty case", [blocker("Handle the empty case", "regression")]) : ok("approved"),
  });
  assert.equal(result.state, "done", result.output?.reason); assert.equal(edits, 2); assert.equal(reviews, 2);
  assert.equal(result.output.checks.length, 2);
  assert.deepEqual([result.output.repairs, result.output.reviewRounds], [0, 1]);
});

test("a review blocker that stands after the one review round ends completed with green checks, its findings in reviewNotes and needs", async context => {
  const cwd = repo(context);
  const result = await execute("implement-task", input(cwd), {
    implementer: () => ok(), reviewer: () => revise("Handle the empty case", [blocker("Handle the empty case", "regression")]),
  });
  assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
  assert.equal(result.output.checksPassed, true); assert.equal(result.output.agentInvocations, 4);
  assert.deepEqual([result.output.repairs, result.output.reviewRounds], [0, 1]);
  assert.ok(Array.isArray(result.output.reviewNotes) && JSON.stringify(result.output.reviewNotes).includes("Handle the empty case"), "the standing finding is in reviewNotes");
  assert.ok(Array.isArray(result.output.needs) && JSON.stringify(result.output.needs).includes("Handle the empty case"), "the standing finding is in needs");
  assert.deepEqual(JSON.parse(readFileSync(result.output.report, "utf8")), result.output);
});

for (const kind of ["other", undefined]) {
  test(`implement-task: a review whose one blocker is ${kind === undefined ? "without a kind" : `kind ${kind}`} is advisory: the run completes with that finding in reviewNotes, without a repair`, async context => {
    const cwd = repo(context); let edits = 0; let reviews = 0;
    const result = await execute("implement-task", input(cwd), {
      implementer: () => { edits++; writeFileSync(join(cwd, "change.txt"), "change"); return ok(); },
      reviewer: () => { reviews++; return revise("Rename the helper", [blocker("Rename the helper for clarity", kind)]); },
    });
    assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
    assert.equal(result.output.checksPassed, true);
    assert.deepEqual([edits, reviews, result.output.agentInvocations, result.output.repairs, result.output.reviewRounds], [1, 1, 2, 0, 0]);
    const notes = result.output.reviewNotes as { severity: string; text: string }[];
    assert.ok(Array.isArray(notes), "the result has reviewNotes");
    assert.ok(notes.some(note => note.severity === "blocker" && note.text === "Rename the helper for clarity"), JSON.stringify(notes));
    assert.equal(result.output.reason, "");
    assert.deepEqual(JSON.parse(readFileSync(result.output.report, "utf8")).reviewNotes, notes);
  });
}

for (const kind of ["acceptance", "regression", "safety"]) {
  for (const second of ["approved", "revise"]) {
    test(`implement-task: a blocker of kind ${kind} repairs once, then the run ends completed when the second review is ${second}`, async context => {
      const cwd = repo(context); const prompts: string[] = []; let reviews = 0;
      const text = `The ${kind} defect at code.txt:1`;
      const result = await execute("implement-task", input(cwd), {
        implementer: request => { prompts.push(request.prompt); writeFileSync(join(cwd, "change.txt"), String(prompts.length)); return ok(); },
        reviewer: () => ++reviews === 1 || second === "revise" ? revise(text, [blocker(text, kind)]) : ok("approved"),
      });
      assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
      assert.equal(result.output.checksPassed, true);
      assert.deepEqual([prompts.length, reviews, result.output.agentInvocations, result.output.repairs, result.output.reviewRounds], [2, 2, 4, 0, 1]);
      assert.ok(prompts[1]!.includes(text), "the repair prompt carries the blocker");
      if (second === "revise") {
        assert.ok(JSON.stringify(result.output.reviewNotes ?? []).includes(text), "the standing blocker is in reviewNotes");
        assert.ok(JSON.stringify(result.output.needs ?? []).includes(text), "the standing blocker is in needs");
      }
    });
  }
}

test("an unstructured revise goes back to the reviewer once, and a second one stands as advisory notes", async context => {
  const cwd = repo(context); let edits = 0; const prompts: string[] = [];
  const result = await execute("implement-task", input(cwd), {
    implementer: () => { edits++; writeFileSync(join(cwd, "change.txt"), "change"); return ok(); },
    reviewer: request => { prompts.push(request.prompt); return ok("revise", "Consider the empty case"); },
  });
  assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
  assert.deepEqual([edits, prompts.length, result.output.repairs, result.output.reviewRounds], [1, 2, 0, 0]);
  assert.doesNotMatch(prompts[0]!, /Your last report was malformed/u);
  assert.match(prompts[1]!, /Your last report was malformed/u);
  assert.ok(JSON.stringify(result.output.reviewNotes ?? []).includes("Consider the empty case"), "the revise stands as a note");
});

test("an editing report's assumptions and scopeAdditions are carried into the result", async context => {
  const cwd = repo(context);
  const assumption = { question: "Which locale?", answer: "en-US, as the fixtures use", why: "Reversible: one constant" };
  const addition = { path: "docs/guide.md", why: "The guide documents the changed behaviour" };
  const result = await execute("implement-task", input(cwd), {
    implementer: () => { writeFileSync(join(cwd, "change.txt"), "change"); return { ...ok(), assumptions: [assumption], scopeAdditions: [addition] }; },
    reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done", result.output?.reason);
  assert.deepEqual(result.output.assumptions, [assumption]);
  assert.deepEqual(result.output.scopeAdditions, [addition]);
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

for (const verdict of ["revise", "approved"]) {
  test(`investigate delivers the investigator's report in one round when the challenger returns ${verdict}${verdict === "revise" ? ", with the challenge appended" : ""}`, async context => {
    const cwd = repo(context); let investigations = 0; let reviews = 0;
    const report = "The cause is the cache key at code.txt:1";
    const challenge = "Check the call site before blaming the cache";
    const result = await execute("investigate", input(cwd, { checks: [] }), {
      investigator: () => { investigations++; return ok("completed", report); },
      reviewer: () => { reviews++; return verdict === "revise" ? ok("revise", challenge) : ok("approved", "The report is qualified"); },
    });
    assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
    assert.deepEqual([investigations, reviews, result.output.agentInvocations], [1, 1, 2]);
    assert.equal(result.output.challenged, verdict === "revise");
    assert.equal(typeof result.output.investigation, "string", "the result names the delivered report");
    const delivered = readFileSync(result.output.investigation, "utf8");
    assert.ok(delivered.includes(report), delivered);
    const appended = section(delivered, "Challenge");
    if (verdict === "revise") {
      assert.ok(appended !== undefined && appended.includes(challenge), delivered);
      assert.ok(delivered.indexOf(report) < delivered.indexOf("## Challenge"), "the challenge follows the report");
    } else assert.equal(appended, undefined, delivered);
    assert.deepEqual(JSON.parse(readFileSync(result.output.report, "utf8")), result.output);
  });
}

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

/** What a send-back tells the Agent: the fault exactly as its validator gave it. */
const sentBack = (fault: string) => `Your last report was malformed: ${fault}. Return it again in the required shape.`;
const summaryFault = (stage: string) => `Agent ${stage} must return a non-empty summary of at most 16000 characters`;
/** The evidence files of a run, other than its result receipt, that hold this text. */
function kept(report: string, text: string) {
  const directory = join(report, "..");
  return readdirSync(directory).filter(name => name !== "result.json" && readFileSync(join(directory, name), "utf8").includes(text));
}
/** Each default's Agents as they answer in a run that succeeds, with its input and the Human answer it needs. */
function succeeding(name: string, cwd: string) {
  const change = (text: string) => () => { writeFileSync(join(cwd, "change.txt"), text); return ok(); };
  switch (name) {
    case "review-code": return { data: input(cwd, { checks: [] }), agents: { reviewer: () => ok("reviewed") } };
    case "investigate": return { data: input(cwd, { checks: [] }), agents: { investigator: () => ok(), reviewer: () => ok("approved") } };
    case "fix-bug": return { data: input(cwd, { regression: regression() }), agents: {
      tester: () => ok(), implementer: () => { writeFileSync(join(cwd, "code.txt"), "fixed"); return ok(); }, reviewer: () => ok("approved") } };
    case "upgrade-dependency": return { data: input(cwd), human: () => "approve", agents: {
      analyst: () => ok("completed", "Proposed version and migration evidence"), implementer: change("upgraded"), reviewer: () => ok("approved") } };
    case "prepare-release": return { data: input(cwd), human: () => "approve", agents: { reviewer: () => ok("approved", "Draft release notes") } };
    case "update-docs": return { data: input(cwd), agents: { writer: change(name), reviewer: () => ok("approved") } };
    case "add-tests": return { data: input(cwd), agents: { tester: change(name), reviewer: () => ok("approved") } };
    default: return { data: input(cwd), agents: { implementer: change(name), reviewer: () => ok("approved") } };
  }
}
// Every Agent report a default validates, by the role that gives it, the outcome it claims, and the stage it is captured as.
for (const [name, role, type, stage] of [
  ["review-code", "reviewer", "reviewed", "review"],
  ["implement-task", "implementer", "completed", "change"], ["implement-task", "reviewer", "approved", "review"],
  ["refactor", "implementer", "completed", "change"], ["refactor", "reviewer", "revise", "review"],
  ["add-tests", "tester", "completed", "change"], ["add-tests", "reviewer", "approved", "review"],
  ["update-docs", "writer", "completed", "change"], ["update-docs", "reviewer", "approved", "review"],
  ["investigate", "investigator", "completed", "investigation"], ["investigate", "reviewer", "approved", "challenge"],
  ["fix-bug", "tester", "completed", "regression"], ["fix-bug", "implementer", "completed", "fix"], ["fix-bug", "reviewer", "approved", "review"],
  ["upgrade-dependency", "analyst", "completed", "proposal"], ["upgrade-dependency", "implementer", "completed", "upgrade"], ["upgrade-dependency", "reviewer", "approved", "review"],
  ["prepare-release", "reviewer", "approved", "release-review"],
] as const) {
  test(`${name}: a malformed ${role} report goes back once to the ${role} with its exact fault, which is kept in the evidence, and a valid second report continues`, async context => {
    const cwd = repo(context); const run = succeeding(name, cwd); const prompts: string[] = [];
    const agents: Record<string, (request: { prompt: string }) => unknown> = { ...run.agents };
    const valid = agents[role]!;
    agents[role] = request => { prompts.push(request.prompt); return prompts.length === 1 ? { type } : valid(request); };
    const result = await execute(name, run.data, agents, run.human ? { human: run.human } : {});
    assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0]!, /Your last report was malformed/u);
    assert.ok(prompts[1]!.includes(sentBack(summaryFault(stage))), prompts[1]);
    assert.notDeepEqual(kept(result.output.report, summaryFault(stage)), [], "the fault is kept in the evidence");
    // The send-back spends no budget.
    assert.deepEqual([result.output.repairs, result.output.reviewRounds], [0, 0]);
  });
}

test("a default's second malformed report from the same entry still fails the run, after one send-back", async context => {
  const cwd = repo(context); const prompts: string[] = [];
  await assert.rejects(execute("review-code", input(cwd, { checks: [] }), {
    reviewer: (request: { prompt: string }) => { prompts.push(request.prompt); return { type: "reviewed" }; },
  }), /non-empty summary/u);
  assert.equal(prompts.length, 2); assert.ok(prompts[1]!.includes(sentBack(summaryFault("review"))));
});

test("a default sends back once per entry into a stage: a later entry gets its own send-back", async context => {
  const cwd = repo(context); const prompts: string[] = []; let reviews = 0;
  const result = await execute("implement-task", input(cwd), {
    implementer: (request: { prompt: string }) => {
      prompts.push(request.prompt);
      if (prompts.length % 2 === 1) return { type: "completed", summary: " " };
      writeFileSync(join(cwd, "change.txt"), String(prompts.length)); return ok();
    },
    reviewer: () => ++reviews === 1 ? revise("Handle the empty case", [blocker("Handle the empty case", "regression")]) : ok("approved"),
  });
  assert.equal(result.state, "done", result.output?.reason);
  assert.deepEqual([prompts.length, reviews], [4, 2]);
  for (const index of [1, 3]) assert.ok(prompts[index]!.includes(sentBack(summaryFault("change"))), `call ${index + 1}`);
  assert.doesNotMatch(prompts[2]!, /Your last report was malformed/u);
  assert.deepEqual([result.output.repairs, result.output.reviewRounds], [0, 1]);
});

test("the shared send-back helper is part of every task run", context => {
  const work = taskRun("helper-test", input(repo(context)), { checks: true, git: "clean" }) as unknown as Record<string, unknown>;
  assert.equal(typeof work.sendBack, "function");
});

test("the exported sendBack helper keeps the caller's allowance across valid reports until explicitly reset", () => {
  const allowance = { returned: false, feedback: "" };
  const fault = 'criteria[0]: expected "met".\nKeep the exact diagnostic';
  const invalid = () => { throw new Error(fault); };
  assert.deepEqual(task.sendBack(invalid, allowance), { type: "sendBack", fault, feedback: sentBack(fault) });
  assert.equal(allowance.returned, true);
  const report = { criteria: [] };
  assert.deepEqual(task.sendBack(() => report, allowance), { type: "valid", report });
  assert.equal(allowance.feedback, "");
  assert.deepEqual(task.sendBack(invalid, allowance), { type: "invalid", fault, feedback: sentBack(fault) });
  allowance.returned = false;
  assert.equal(task.sendBack(invalid, allowance).type, "sendBack");
});

/** The text of a level-two or level-three section, up to the next heading of the same or a higher level. */
function section(text: string, heading: string) {
  const start = text.search(new RegExp(`^(#{2,3}) ${heading}\\b`, "mu"));
  if (start < 0) return undefined;
  const level = /^#+/u.exec(text.slice(start))![0].length;
  const rest = text.slice(start).split("\n").slice(1).join("\n");
  const end = rest.search(new RegExp(`^#{1,${level}} `, "mu"));
  return end < 0 ? rest : rest.slice(0, end);
}

test("docs/catalog.md has a Recovery section that names the send-back helper, says why with the counts, and shows a custom Machine using it", () => {
  const recovery = section(readFileSync(resolve("docs/catalog.md"), "utf8"), "Recovery");
  assert.ok(recovery !== undefined, "docs/catalog.md has no Recovery section");
  const prose = recovery.replace(/\s+/gu, " ");
  assert.match(prose, /`(?:work\.)?sendBack`/u, "the section names the helper");
  assert.match(prose, /\bonce\b/iu, "the section says a report goes back once");
  assert.ok(prose.includes("Return it again in the required shape"), "the section gives the wording the Agent receives");
  assert.match(prose, /\b(?:about )?(?:eight|8)\b[^.]*\bruns?\b|\bruns?\b[^.]*\b(?:eight|8)\b/iu, "the section gives the count of stopped runs as its reason");
  const example = /```(?:ts|typescript)\n([\s\S]*?)```/u.exec(recovery)?.[1];
  assert.ok(example, "the section has a TypeScript usage example");
  assert.match(example, /sendBack|reported/u, "the example uses the helper");
});

for (const page of ["ticket-task", "add-tests", "fix-bug", "implement-task", "investigate", "prepare-release", "refactor", "review-code", "update-docs", "upgrade-dependency"]) {
  test(`docs/workflows/${page}.md links to the catalog's Recovery section`, () => {
    assert.ok(readFileSync(resolve("docs/workflows", `${page}.md`), "utf8").includes("../catalog.md#recovery"));
  });
}

test("docs/catalog.md's Recovery section describes running a failed check once more by itself, why, and the switch that turns it off", () => {
  const recovery = section(readFileSync(resolve("docs/catalog.md"), "utf8"), "Recovery");
  assert.ok(recovery !== undefined, "docs/catalog.md has no Recovery section");
  const prose = recovery.replace(/\s+/gu, " ");
  assert.ok(prose.includes("`rerunFailedChecks: false`"), "the section names the switch as it is written in the input");
  assert.ok(prose.includes("`repository.rerunFailedChecks`"), "the section names ticket-task's place for the switch");
  assert.match(prose, /`flaky`/u, "the section names the receipt's mark");
  assert.match(prose, /\bonce more\b|\bonce again\b|\bran once\b|\brun once\b/iu, "the section says a failed gate runs once more");
  assert.match(prose, /\bload\b/iu, "the section gives as its reason the checks that failed under load");
  assert.match(prose, /\brepair round\b/iu, "the section says the rerun costs no repair round");
});

// Each gate-running default documents the switch in its input table, and ticket-task under repository.
for (const [page, field] of [
  ...["verify-checks", "implement-task", "fix-bug", "refactor", "add-tests", "update-docs", "upgrade-dependency", "prepare-release"].map(page => [page, "rerunFailedChecks"]),
  ["ticket-task", "repository.rerunFailedChecks"],
]) {
  test(`docs/workflows/${page}.md documents ${field}`, () => {
    const row = readFileSync(resolve("docs/workflows", `${page}.md`), "utf8").split("\n").find(line => line.startsWith(`| \`${field}\` |`));
    assert.ok(row, `no input table row for ${field}`);
    assert.match(row, /`true`/u, "the row gives the default");
  });
}

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
  ["excess output", command('process.stdout.write("x".repeat(20*1024*1024))')],
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

test("a captured Agent message stands in for a missing summary, and an absent report still fails", async context => {
  const cwd = repo(context);
  const result = await execute("review-code", input(cwd, { checks: [] }), {
    reviewer: () => ({ type: "reviewed", message: "Findings written as prose" }),
  });
  assert.equal(result.output.agents[0].summary, "Findings written as prose");
  await assert.rejects(
    execute("review-code", input(cwd, { checks: [] }), { reviewer: () => ({ type: "reviewed", summary: " " }) }),
    /must return a non-empty summary/u,
  );
});

test("a report captured as a JSON object yields its summary, and any other text is kept as written", async context => {
  for (const [message, summary] of [
    [JSON.stringify({ outcome: "reviewed", summary: "Findings inside a report" }, null, 2), "Findings inside a report"],
    ['{"outcome":"reviewed","summary":" "}', '{"outcome":"reviewed","summary":" "}'],
    ["{braces} open this prose, which is not JSON", "{braces} open this prose, which is not JSON"],
    ['The report was {"summary":"quoted"}', 'The report was {"summary":"quoted"}'],
  ] as const) {
    const result = await execute("review-code", input(repo(context), { checks: [] }), { reviewer: () => ({ type: "reviewed", message }) });
    assert.equal(result.output.agents[0].summary, summary);
  }
});

test("brief keeps the decision to 100 characters on its first line, cut after a whole word with an ellipsis", () => {
  // A first sentence of more than ten words, such as a spent budget with its conflict, is kept whole.
  for (const decision of ["Decide", "Repair budget used up (3 of 3) with 1 unsettled conflict in README.md.", "x".repeat(100)]) {
    assert.equal(firstLine(brief({ decision, standing: "Standing", evidence: [] })), decision);
  }
  for (const count of [1, 10, 11, 20, 40]) {
    const words = Array.from({ length: count }, (_, index) => `word${index}`);
    const whole = words.join(" ");
    const note = brief({ decision: words.join(" \n "), standing: "Standing", evidence: [] });
    const first = firstLine(note);
    assert.equal(note.split("\n")[1], "");
    assert.ok(first.length <= 100, first);
    if (whole.length <= 100) { assert.equal(first, whole); continue; }
    // As many whole words as fit with the ellipsis, and no more.
    assert.ok(first.endsWith("…"), first);
    const kept = first.slice(0, -1);
    assert.ok(whole.startsWith(`${kept} `), first);
    assert.ok(`${kept} ${words[kept.split(" ").length]}…`.length > 100, first);
  }
  assert.equal(firstLine("First\r\nSecond"), "First");
});

test("opening splits a text after its first sentence or line, and gives the whole text as the rest when that sentence is cut", () => {
  const opening = (brief_ as Record<string, unknown>).opening as (text: string) => { first: string; rest: string };
  assert.equal(typeof opening, "function", "brief.ts exports opening");
  // A period ends the sentence only before whitespace or the end, so a field name or a path stays in it.
  assert.deepEqual(opening("The falsify report was malformed twice: questions[0].why must be a non-empty string. The report is kept in /x/falsify-2.json."),
    { first: "The falsify report was malformed twice: questions[0].why must be a non-empty string.", rest: "The report is kept in /x/falsify-2.json." });
  assert.deepEqual(opening("Malformed review report: criteria must be an array."), { first: "Malformed review report: criteria must be an array.", rest: "" });
  assert.deepEqual(opening("Acceptance criteria are missing\nSay which file holds them."), { first: "Acceptance criteria are missing", rest: "Say which file holds them." });
  const long = `Paths outside the ticket Scope after change: ${Array.from({ length: 8 }, (_, index) => `"docs/page-${index}.md"`).join(", ")}. Scope: greeting.txt.`;
  const cut = opening(long);
  assert.ok(cut.first.length <= 100 && cut.first.endsWith("…"), cut.first);
  assert.equal(cut.rest, long); assert.ok(long.startsWith(cut.first.slice(0, -1)), cut.first);
});

test("brief includes each part once and puts recommended options first without mutating them", () => {
  const parts = {
    decision: "Choose the next step", standing: "The criterion is unmet", changed: "The check now passes",
    needs: "Which locale?", evidence: ["/worktree", "ticket/branch", "/evidence"],
    options: [{ name: "retry", does: "Try again" }, { name: "hand off", does: "Keep the candidate", recommended: true }, { name: "discard", does: "Confirm removal" }],
  };
  const before = structuredClone(parts);
  assert.equal(brief(parts), [
    parts.decision, "", parts.standing, `Since last time: ${parts.changed}`, `Needs: ${parts.needs}`, ...parts.evidence,
    "hand off: Keep the candidate (recommended)", "retry: Try again", "discard: Confirm removal",
  ].join("\n"));
  assert.deepEqual(parts, before);
  assert.equal(brief({ decision: "Decide", standing: "Ready", evidence: [] }), "Decide\n\nReady");
});

test("taskRun resets both independent budgets and records their cumulative counts", context => {
  const workspace = repo(context);
  const work = taskRun("budget-test", { task: "Budget test", workspace, maxRepairs: 1, maxReviewRounds: 2 }, { git: "none" });
  work.start(); work.block("Standing finding");
  assert.equal(work.repair().type, "retry");
  assert.equal(work.reviewRound().type, "retry"); assert.equal(work.reviewRound().type, "retry");
  assert.equal(work.reviewRound().type, "exhausted");
  assert.deepEqual(work.status(), { reason: "Review budget exhausted (2). Standing finding", repairs: 1, totalRepairs: 1, maxRepairs: 1, reviewRounds: 2, totalReviewRounds: 2, maxReviewRounds: 2 });
  work.renew();
  assert.deepEqual(work.status(), { reason: "Standing finding", repairs: 0, totalRepairs: 1, maxRepairs: 1, reviewRounds: 0, totalReviewRounds: 2, maxReviewRounds: 2 });
  assert.equal(work.repair().type, "retry"); assert.equal(work.reviewRound().type, "retry");
  assert.equal(work.repair().type, "exhausted"); assert.equal(work.status().reason, "Repair budget exhausted (1). Standing finding");
  work.renew(); assert.equal(work.status().reason, "Standing finding");
  work.finish("blocked");
  assert.equal(work.output()!.repairs, 2); assert.equal(work.output()!.reviewRounds, 3);
  const receipt = JSON.parse(readFileSync(String(work.output()!.report), "utf8"));
  assert.equal(receipt.repairs, 2); assert.equal(receipt.reviewRounds, 3);
});

test("taskRun keeps its working data in the saved data it is given, so a helper built again on a JSON copy carries on the same evidence", context => {
  const cwd = repo(context);
  const saved = task.taskData();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved)), saved);
  const first = taskRun("saved-test", input(cwd), { checks: true, git: "clean" }, saved);
  first.start(); assert.equal(first.checks().type, "passed"); first.capture("change", ok());
  const directory = first.open();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved)), saved);
  assert.equal(saved.directory, directory); assert.equal(saved.reports.length, 1); assert.equal(saved.evidence.length, 1);
  // A continued run gets its data back as JSON, and the helper made from it is the one that stopped.
  const again = taskRun("saved-test", input(cwd), { checks: true, git: "clean" }, JSON.parse(JSON.stringify(saved)));
  assert.equal(again.open(), directory);
  assert.equal(again.accept(), true);
  again.capture("review", ok("approved", "Looks right"));
  assert.ok(existsSync(join(directory, "agent-2.json")));
  assert.equal(again.checks().type, "passed"); assert.ok(existsSync(join(directory, "2.log")));
  assert.equal(again.finish("completed").type, "completed");
  const [receipt, ...others] = receipts(cwd); assert.deepEqual(others, []);
  assert.deepEqual(receipt.agents.map((report: { stage: string }) => report.stage), ["change", "review"]);
  assert.equal(receipt.checks.length, 2); assert.equal(receipt.checksPassed, true);
  assert.equal(receipt.startedAt, JSON.parse(readFileSync(join(directory, "started.json"), "utf8")).startedAt);
});

test("reopen clears the accepted latch so drift counts again, reopen(true) records failed checks, and a baseline alone still establishes nothing", context => {
  /** A run whose candidate passed verification and was accepted, as a workflow that commits it itself leaves the helper. */
  const verified = () => {
    const cwd = repo(context); const work = taskRun("reopen-test", input(cwd), { checks: true, git: "clean" });
    work.start(); assert.equal(work.checks().type, "passed"); assert.equal(work.accept(), true);
    return { cwd, work, finish: () => [work.finish("completed").type, work.output()!.checksPassed] };
  };
  // As before: once accepted, what the workflow does to its own checkout is not drift.
  const latched = verified(); writeFileSync(join(latched.cwd, "code.txt"), "moved by the workflow"); assert.deepEqual(latched.finish(), ["completed", true]);
  // Reopened, the tree that passed is still the tree that passed.
  const same = verified(); same.work.reopen(); assert.deepEqual(same.finish(), ["completed", true]);
  // But a change after that is drift again, as it was before the candidate was accepted.
  const drifted = verified(); drifted.work.reopen(); writeFileSync(join(drifted.cwd, "code.txt"), "edited after the commit was undone"); assert.deepEqual(drifted.finish(), ["blocked", false]);
  const retired = verified(); retired.work.reopen(); writeFileSync(join(retired.cwd, "code.txt"), "edited after the commit was undone"); retired.work.retire(); assert.deepEqual(retired.finish(), ["blocked", false]);
  // A failed reverify or setup after the commit: nothing passed on this tree, drifted or not.
  const failed = verified(); failed.work.reopen(true); assert.deepEqual(failed.finish(), ["blocked", false]);
  // Verification on the repaired candidate establishes it again.
  const repaired = verified(); repaired.work.reopen(true); assert.equal(repaired.work.accept(), false);
  assert.equal(repaired.work.checks().type, "passed"); assert.equal(repaired.work.accept(), true); assert.deepEqual(repaired.finish(), ["completed", true]);
  // The phases checks already had are untouched: a baseline alone establishes nothing.
  const cwd = repo(context); const baseline = taskRun("reopen-test", input(cwd), { checks: true, git: "clean" });
  baseline.start(); assert.equal(baseline.checks("baseline").type, "passed");
  assert.equal(baseline.finish("blocked").type, "blocked"); assert.equal(baseline.output()!.checksPassed, null);
});

for (const maxReviewRounds of [0, 5]) {
  test(`implement-task spends maxReviewRounds ${maxReviewRounds} on a standing review blocker, not its repair budget, and then completes`, async context => {
    const result = await execute("implement-task", input(repo(context), { maxRepairs: 1, maxReviewRounds }), {
      implementer: () => ok(), reviewer: () => revise("Handle the empty case", [blocker("Handle the empty case", "acceptance")]),
    });
    assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
    assert.deepEqual([result.output.repairs, result.output.reviewRounds, result.output.agentInvocations], [0, maxReviewRounds, 2 + 2 * maxReviewRounds]);
    assert.ok(JSON.stringify(result.output.needs ?? []).includes("Handle the empty case"));
  });
}

// Layered checks: `when`, `focused`, `group` and `after` choose and order the checks a round runs.

/** A gate that prints its name, so a log shows which check wrote it. */
const named = (name: string, extra = {}) => ({ name, command: [process.execPath, "-e", `console.log(${JSON.stringify(`${name} ran`)})`], ...extra });
/** Write a file under the checkout, creating its directories. */
function place(cwd: string, path: string, content = "export {};\n") {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), content);
}
type Round = { phase: string; kind: string; why: string; ran: { name: string; focused?: string[]; whole?: string }[]; skipped: { name: string; why: string }[]; passed: boolean };
const skippedWhen = "no changed path matched when";

test("a check with when runs only when a changed path matches it, and is recorded as skipped, not passed, otherwise", async context => {
  const checks = [named("build"), named("tests"), named("ui", { when: ["web/**"] })];
  for (const [changed, ran] of [["src/app.ts", ["build", "tests"]], ["web/page.html", ["build", "tests", "ui"]]] as const) {
    const cwd = repo(context);
    const result = await execute("implement-task", input(cwd, { checks }), {
      implementer: () => { place(cwd, changed); if (changed.startsWith("web/")) git(cwd, "add", changed); return ok(); },
      reviewer: () => ok("approved"),
    });
    assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.checksPassed, true);
    // A skipped check is not evidence that it passed.
    assert.deepEqual(result.output.checks.map((c: Entry) => [c.name, c.passed]), ran.map(name => [name, true]), changed);
    for (const entry of result.output.checks as Entry[]) assert.match(readFileSync(entry.log, "utf8"), new RegExp(`${entry.name} ran`, "u"));
    const rounds = result.output.checkRounds as Round[];
    assert.ok(Array.isArray(rounds), "the receipt records each check round");
    assert.equal(rounds.length, 1); assert.equal(rounds[0]!.phase, "verify"); assert.equal(rounds[0]!.passed, true);
    assert.deepEqual(rounds[0]!.ran.map(entry => entry.name), ran, changed);
    assert.deepEqual(rounds[0]!.skipped, ran.length === 3 ? [] : [{ name: "ui", why: skippedWhen }], changed);
    assert.deepEqual(JSON.parse(readFileSync(result.output.report, "utf8")).checkRounds, rounds, "result.json says the same");
  }
});

/** One round of a focused test check on a copy of tests/fixtures/focused, after one of its files changes. */
async function focusedRound(context: TestContext, changed: string, check: Record<string, unknown> = {}, phase = "verify") {
  const cwd = repo(context);
  cpSync(resolve("tests/fixtures/focused"), cwd, { recursive: true });
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "focused fixture");
  const argv = [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "tests/*.test.ts"];
  const saved = task.taskData();
  const work = taskRun("focused-test", input(cwd, { checks: [{ name: "tests", command: argv, focused: true, ...check }] }), { checks: true, git: "clean" }, saved);
  work.start();
  writeFileSync(join(cwd, changed), `${readFileSync(join(cwd, changed), "utf8")}// changed\n`);
  assert.equal((await work.checks(phase)).type, "passed");
  const entry = saved.evidence.at(-1) as unknown as Entry & { phase: string; command: string[]; focused?: string[]; whole?: string };
  const round = ((saved as unknown as { checkRounds: Round[] }).checkRounds ?? []).at(-1);
  assert.ok(round, "the round is recorded");
  assert.equal(round.phase, phase);
  return { entry, round, ran: JSON.parse(readFileSync(entry.log, "utf8")) as string[], argv };
}

test("a focused test check runs the test named after a changed file and every test that imports it, in place of its trailing glob", async context => {
  const { entry, round, ran, argv } = await focusedRound(context, "src/pairing.ts");
  const selected = ["tests/pairing.test.ts", "tests/uses-pairing.test.ts"];
  assert.deepEqual([...ran].sort(), selected, "tests/other.test.ts neither is named after nor imports src/pairing.ts");
  assert.deepEqual(entry.command.slice(0, 3), argv.slice(0, 3)); assert.deepEqual(entry.command.slice(3).sort(), selected);
  assert.deepEqual([...(entry.focused ?? [])].sort(), selected); assert.equal(entry.whole, undefined);
  assert.deepEqual(round.ran.map(item => [item.name, [...(item.focused ?? [])].sort()]), [["tests", selected]], "the receipt says which files the check was focused to");
});

for (const [label, changed, check, phase, why] of [
  ["a changed file that nothing names or imports", "src/lonely.ts", {}, "verify", /nothing|no test/iu],
  ["a command with no trailing glob argument", "src/pairing.ts", { command: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))"] }, "verify", /glob/iu],
  ["more selected files than focusedLimit", "src/pairing.ts", { focusedLimit: 1 }, "verify", /focusedLimit|limit/iu],
  ["a changed test file with no production counterpart", "tests/other.test.ts", {}, "verify", /counterpart|production|test file/iu],
  ["a reverify round", "src/pairing.ts", {}, "reverify", /reverify/iu],
] as const) {
  test(`a focused test check runs whole, and says why, for ${label}`, async context => {
    const { entry, round, ran, argv } = await focusedRound(context, changed, check, phase);
    const whole = "command" in check ? check.command : argv;
    assert.deepEqual(entry.command, whole, "the check ran with its own argv");
    assert.deepEqual(ran, whole.slice(3));
    assert.equal(entry.focused, undefined);
    assert.equal(typeof entry.whole, "string"); assert.match(entry.whole!, why);
    assert.deepEqual(round.ran.map(item => [item.name, item.focused, item.whole]), [["tests", undefined, entry.whole]], "the receipt says why it ran whole");
  });
}

test("checks in one group run concurrently, after waits for the checks it names, and a check without a group still waits its turn", async context => {
  const cwd = repo(context);
  const timed = (name: string, ms: number, extra = {}) => ({ name, ...extra, command: [process.execPath, "-e",
    `console.log("start " + Date.now()); setTimeout(() => console.log("end " + Date.now()), ${ms});`] });
  const checks = [timed("a", 1500, { group: "slow" }), timed("b", 1500, { group: "slow" }), timed("c", 10, { group: "slow", after: ["a"] }), timed("d", 10)];
  const began = Date.now();
  const result = await execute("verify-checks", input(cwd, { checks }));
  const elapsed = Date.now() - began;
  assert.equal(result.state, "done", result.output?.reason);
  assert.ok(elapsed < 3000, `two 1500 ms checks in one group finished in ${elapsed} ms, less than the 3000 ms they take one after another`);
  // One log per check, numbered in list order.
  const entries = result.output.checks as Entry[];
  assert.deepEqual(entries.map(entry => [entry.name, entry.passed, entry.log.split("/").at(-1)]), [["a", true, "1.log"], ["b", true, "2.log"], ["c", true, "3.log"], ["d", true, "4.log"]]);
  const times = Object.fromEntries(entries.map(entry => {
    const log = readFileSync(entry.log, "utf8");
    return [entry.name, { start: Number(/start (\d+)/u.exec(log)![1]), end: Number(/end (\d+)/u.exec(log)![1]) }];
  }));
  assert.ok(times.b!.start < times.a!.end && times.a!.start < times.b!.end, "a and b overlap");
  assert.ok(times.c!.start >= times.a!.end, "c starts after a, which it names in after, has finished");
  assert.ok(times.d!.start >= Math.max(times.a!.end, times.b!.end, times.c!.end), "d, outside the group, starts after the group has finished");
});

/** The layered list the repair-round tests share: two always-checks, one of them not fast, a failing target, and a when check. */
function layered(context: TestContext) {
  const gates = { fast: counted(context, "fast", 0), slow: counted(context, "slow", 0), target: counted(context, "target", 2), ui: counted(context, "ui", 0) };
  const checks = [gates.fast.gate, { ...gates.slow.gate, fastMs: 1 }, gates.target.gate, { ...gates.ui.gate, when: ["src/**"] }];
  return { gates, checks, runs: () => Object.fromEntries(Object.entries(gates).map(([name, gate]) => [name, gate.runs()])) };
}

test("a repair round after a failed check runs that check and the fast always-checks only, then the full layered round before it passes", async context => {
  const cwd = repo(context); const { checks, runs } = layered(context); let edits = 0;
  const result = await execute("implement-task", input(cwd, { checks }), {
    implementer: () => { place(cwd, `src/change-${++edits}.ts`); return ok(); },
    reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.checksPassed, true);
  assert.deepEqual([edits, result.output.repairs], [2, 1]);
  assert.deepEqual(result.output.checks.map((c: Entry) => [c.name, c.passed]), [
    // The first round: every check, then the failed target once more by itself.
    ["fast", true], ["slow", true], ["target", false], ["ui", true], ["target", false],
    // The repair round: the failed check and the always-check that finished under its fastMs; not slow (fastMs 1) nor ui (when).
    ["fast", true], ["target", true],
    // It passed, so the full layered round runs at once, and its result is the outcome.
    ["fast", true], ["slow", true], ["target", true], ["ui", true],
  ]);
  assert.deepEqual(runs(), { fast: 3, slow: 2, target: 4, ui: 2 });
  const rounds = result.output.checkRounds as Round[];
  assert.deepEqual(rounds.map(round => [round.phase, round.kind, round.passed]), [["verify", "layered", false], ["verify", "repair", true], ["verify", "layered", true]]);
  assert.deepEqual(rounds.map(round => round.ran.map(entry => entry.name)), [["fast", "slow", "target", "ui"], ["fast", "target"], ["fast", "slow", "target", "ui"]]);
  for (const round of rounds) assert.ok(typeof round.why === "string" && round.why.trim(), "each round says why it ran what it ran");
  assert.deepEqual(JSON.parse(readFileSync(result.output.report, "utf8")).checkRounds, rounds);
});

for (const between of ["reverify", "seal"] as const) {
  test(`after a failed verify round, ${between === "reverify" ? "the delivery reverify" : "a verify round after the candidate is sealed for review"} runs the full layered round, not a reduced one`, async context => {
    const cwd = repo(context); const { checks } = layered(context);
    const saved = task.taskData();
    const work = taskRun("repair-round", input(cwd, { checks }), { checks: true, git: "clean" }, saved);
    work.start(); place(cwd, "src/change.ts");
    assert.equal((await work.checks()).type, "failed");
    const from = saved.evidence.length;
    if (between === "seal") work.seal();
    const phase = between === "reverify" ? "reverify" : "verify";
    assert.equal((await work.checks(phase)).type, "passed");
    assert.deepEqual(saved.evidence.slice(from).map(entry => [entry.phase, entry.name, entry.passed]),
      ["fast", "slow", "target", "ui"].map(name => [phase, name, true]));
    const rounds = (saved as unknown as { checkRounds: Round[] }).checkRounds;
    assert.deepEqual(rounds.map(round => [round.phase, round.kind]), [["verify", "layered"], [phase, "layered"]]);
  });
}

test("a baseline and verify-checks run every check whole, when checks included, even with nothing changed", async context => {
  const checks = [named("tests"), named("ui", { when: ["web/**"] })];
  const cwd = repo(context);
  const result = await execute("add-tests", input(cwd, { checks }), {
    tester: () => { place(cwd, "tests/new.test.ts"); return ok(); }, reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done", result.output?.reason);
  assert.deepEqual(result.output.checks.map((c: Entry & { phase: string }) => [c.phase, c.name]), [["baseline", "tests"], ["baseline", "ui"], ["verify", "tests"]]);
  const rounds = result.output.checkRounds as Round[];
  assert.deepEqual(rounds.map(round => [round.phase, round.ran.map(entry => entry.name), round.skipped.map(entry => entry.name)]),
    [["baseline", ["tests", "ui"], []], ["verify", ["tests"], ["ui"]]]);
  const other = repo(context);
  const verified = await execute("verify-checks", input(other, { checks }));
  assert.equal(verified.state, "done");
  assert.deepEqual(verified.output.checks.map((c: Entry) => c.name), ["tests", "ui"]);
  assert.deepEqual((verified.output.checkRounds as Round[]).map(round => round.skipped), [[]]);
});

test("the layered fields are accepted on checks, and each misuse is refused by its own field before execution", context => {
  const cwd = repo(context);
  const valid = [named("build"), named("types", { group: "all" }), named("tests", { group: "all", focused: true, focusedLimit: 10 }),
    named("ui", { group: "all", when: ["web/**", "src/server.ts"] }), named("lint", { fastMs: 5000 }), named("smoke", { after: ["types", "tests", "ui"] })];
  assert.doesNotThrow(() => modules["implement-task"].default(runtime, input(cwd, { checks: valid })));
  for (const [label, checks, field] of [
    ["after naming no check", [named("a", { after: ["nope"] })], /after/u],
    ["after naming the check itself", [named("a", { after: ["a"] })], /after/u],
    ["after naming a later check outside the group", [named("a", { after: ["b"] }), named("b")], /after/u],
    ["after in a cycle", [named("a", { group: "g", after: ["b"] }), named("b", { group: "g", after: ["a"] })], /after|cycle/u],
    ["after that is not an array", [named("a"), named("b", { after: "a" })], /after/u],
    ["when that is not an array", [named("a", { when: "web/**" })], /when/u],
    ["an empty when", [named("a", { when: [] })], /when/u],
    ["a non-boolean focused", [named("a", { focused: "yes" })], /focused/u],
    ["focusedLimit without focused", [named("a", { focusedLimit: 5 })], /focusedLimit/u],
    ["fastMs beside when", [named("a", { when: ["src/**"], fastMs: 1000 })], /fastMs/u],
    ["fastMs beside focused", [named("a", { focused: true, fastMs: 1000 })], /fastMs/u],
    ["an empty group", [named("a", { group: "" })], /group/u],
  ] as const) {
    assert.throws(() => modules["implement-task"].default(runtime, input(cwd, { checks })),
      (error: Error) => field.test(error.message) && !error.message.startsWith("Unknown "), label);
  }
  // The regression command runs whole and alone: the fields are not part of it.
  assert.throws(() => modules["fix-bug"].default(runtime, input(cwd, { regression: { ...regression(), when: ["src/**"] } })), /when/u);
  assert.equal(existsSync(join(cwd, ".machine-runs")), false);
});

const layeredFields = ["when", "focused", "focusedLimit", "group", "after", "fastMs"];

test("docs/catalog.md's Common input documents the layered fields with Drip's check list as its example", context => {
  const common = section(readFileSync(resolve("docs/catalog.md"), "utf8"), "Common input");
  assert.ok(common !== undefined, "docs/catalog.md has no Common input section");
  for (const field of layeredFields) assert.ok(common.includes(`\`${field}\``), `Common input names ${field}`);
  const block = [...common.matchAll(/```json\n([\s\S]*?)```/gu)].map(match => match[1]!).find(text => text.includes("package-smoke"));
  assert.ok(block, "Common input has a JSON example with Drip's checks");
  const parsed = JSON.parse(block);
  const checks = (Array.isArray(parsed) ? parsed : parsed.checks) as { name: string; when?: string[]; focused?: boolean; group?: string; after?: string[] }[];
  assert.deepEqual(checks.map(check => check.name), ["build", "types", "tests", "linked-tests", "machine-tests", "ui", "remote-ui", "package-smoke"]);
  const byName = Object.fromEntries(checks.map(check => [check.name, check]));
  assert.equal(byName.build!.group, undefined, "build runs first, by itself");
  const members = ["types", "tests", "linked-tests", "machine-tests", "ui", "remote-ui"];
  const group = byName.types!.group;
  assert.ok(group, "the middle checks share a group");
  for (const name of members) assert.equal(byName[name]!.group, group, `${name} is in the group`);
  assert.equal(byName.tests!.focused, true);
  assert.deepEqual(byName.ui!.when, ["web/**", "src/server.ts"]);
  assert.ok(Array.isArray(byName["remote-ui"]!.when) && byName["remote-ui"]!.when.length > 0, "remote-ui runs only when its sources change");
  for (const name of members) assert.ok(byName["package-smoke"]!.after?.includes(name), `package-smoke runs after ${name}`);
  const data = Array.isArray(parsed) ? input(repo(context), { checks }) : parsed;
  assert.doesNotThrow(() => modules["implement-task"].default(runtime, data), "the example is valid input");
});

test("docs/catalog.md's Recovery section describes the reduced repair round and the full layered round after it", () => {
  const recovery = section(readFileSync(resolve("docs/catalog.md"), "utf8"), "Recovery");
  assert.ok(recovery !== undefined, "docs/catalog.md has no Recovery section");
  const prose = recovery.replace(/\s+/gu, " ");
  for (const field of ["fastMs", "when", "focused"]) assert.ok(prose.includes(`\`${field}\``), `Recovery names ${field}`);
  assert.match(prose, /\bfull (?:layered )?round\b/iu, "the section says the full round runs after a reduced one passes");
});

for (const page of ["verify-checks", "implement-task", "fix-bug", "refactor", "add-tests", "update-docs", "upgrade-dependency", "prepare-release", "ticket-task"]) {
  test(`docs/workflows/${page}.md documents each layered check field`, () => {
    const lines = readFileSync(resolve("docs/workflows", `${page}.md`), "utf8").split("\n");
    const prefix = page === "ticket-task" ? "repository\\.checks\\[\\]\\." : "(?:checks\\[\\]\\.)?";
    for (const field of layeredFields) {
      const row = lines.find(line => new RegExp(`^\\| \`${prefix}${field}\` \\|`, "u").test(line));
      assert.ok(row, `no input table row for ${field}`);
      if (field === "focusedLimit") assert.match(row, /\b40\b/u, "the row gives the default");
      if (field === "fastMs") assert.match(row, /\b90000\b|\b90 ?s\b/u, "the row gives the default");
    }
  });
}

test("a skipped first group member keeps the group's position and satisfies after", async context => {
  const cwd = repo(context);
  const markers = mkdtempSync(join(tmpdir(), "layered-markers-"));
  context.after(() => rmSync(markers, { recursive: true, force: true }));
  const command = (name: string, requires?: string) => [process.execPath, "-e",
    `const fs = require('node:fs'); ${requires ? `if (!fs.existsSync(${JSON.stringify(join(markers, requires))})) process.exit(7);` : ""} fs.writeFileSync(${JSON.stringify(join(markers, name))}, 'done');`];
  const saved = task.taskData();
  const work = taskRun("group-position", input(cwd, { checks: [
    { name: "skip", command: command("skip"), group: "g", when: ["web/**"] },
    { name: "serial", command: command("serial", "member") },
    { name: "member", command: command("member"), group: "g", after: ["skip"] },
  ] }), { checks: true, git: "clean" }, saved);
  work.start(); place(cwd, "src/change.ts");
  assert.equal((await work.checks()).type, "passed", work.status().reason);
  assert.equal(existsSync(join(markers, "skip")), false);
  assert.equal(existsSync(join(markers, "serial")), true);
  assert.deepEqual(saved.checkRounds[0]!.skipped, [{ name: "skip", why: skippedWhen }]);
  assert.deepEqual(saved.evidence.map(check => check.name), ["serial", "member"], "logs retain declaration order, even when the group runs first");
});

test("focused failed checks rerun alone with the exact selected argv and retain start paths after commit", async context => {
  const cwd = repo(context);
  cpSync(resolve("tests/fixtures/focused"), cwd, { recursive: true });
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "fixture");
  const target = counted(context, "tests", 1);
  const saved = task.taskData();
  const argv = [...target.gate.command, "tests/*.test.ts"];
  const work = taskRun("focused-rerun", input(cwd, { checks: [{ ...target.gate, command: argv, focused: true, when: ["src/**"] }] }), { checks: true, git: "clean" }, saved);
  work.start(); place(cwd, "src/pairing.ts", "export const pairing = 2;\n");
  assert.equal((await work.checks()).type, "passed");
  assert.deepEqual(saved.evidence.map(entry => [entry.command.slice(-2), entry.focused, entry.flaky]), [0, 1].map(() => [
    ["tests/pairing.test.ts", "tests/uses-pairing.test.ts"], ["tests/pairing.test.ts", "tests/uses-pairing.test.ts"], true,
  ]));
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "candidate");
  assert.equal((await work.checks("reverify")).type, "passed");
  assert.deepEqual(saved.evidence.at(-1)!.command, argv);
  assert.equal(saved.evidence.at(-1)!.whole, "reverify runs whole");
  assert.deepEqual(saved.checkRounds.at(-1)!.skipped, []);
});

test("an aborted group kills its children without starting serial reruns or later units", async context => {
  const cwd = repo(context);
  const markers = mkdtempSync(join(tmpdir(), "layered-abort-"));
  context.after(() => rmSync(markers, { recursive: true, force: true }));
  const marker = join(markers, "late");
  const saved = task.taskData();
  const work = taskRun("abort-group", input(cwd, { checks: [
    { name: "a", group: "g", command: [process.execPath, "-e", `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 2000)`] },
    { name: "b", group: "g", command: [process.execPath, "-e", "setTimeout(() => {}, 2000)"] },
    { name: "serial", command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'serial')`] },
  ] }), { checks: true, git: "none" }, saved);
  work.start();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(work.checks("verify", controller.signal) as Promise<unknown>, /abort/iu); }
  finally { clearTimeout(timer); }
  assert.equal(existsSync(marker), false);
  assert.equal(saved.checkRounds.length, 0);
  assert.equal(saved.lastChecksPassed, null);
});

// Mechanical blocks: a claimed base failure is verified on the start commit, and a scope miss is a scope addition.

/** An editing Agent's claim that a check already fails on the unchanged checkout. */
const baseFailing = (check = "tests") => ({ type: "blocked", summary: `The ${check} check already fails on the unchanged checkout, before any change of mine`,
  needs: [{ kind: "baseFailing", text: `${check} fails on the unchanged checkout`, check }] });
const worktrees = (cwd: string) => git(cwd, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "));

test("an implementer's blocked saying the checks fail on the unchanged checkout, where they do, ends blocked naming the base failure with no second Agent call", async context => {
  const cwd = repo(context); const head = git(cwd, "rev-parse", "HEAD"); let calls = 0;
  // Prints where it ran: the base check runs in a separate checkout of the start commit, not in the candidate.
  const gate = command('console.log(process.cwd()); process.exit(require("fs").readFileSync("code.txt", "utf8") === "fixed" ? 0 : 1)');
  const result = await execute("implement-task", input(cwd, { checks: [gate] }), {
    implementer: () => { calls++; writeFileSync(join(cwd, "code.txt"), "fixed"); return baseFailing(); },
    reviewer: () => assert.fail("no review after a confirmed base failure"),
  });
  assert.equal(result.state, "blocked"); assert.equal(result.output.outcome, "blocked");
  assert.equal(calls, 1, "no second Agent call");
  const reason = result.output.reason as string;
  assert.match(reason, /\bbase\b/iu, reason);
  assert.match(reason, /unchanged|start commit/iu, reason);
  assert.ok(reason.includes("tests"), reason);
  const log = /(\/\S+\.log)\b/u.exec(reason)?.[1];
  assert.ok(log && existsSync(log), `the reason names the base check's log: ${reason}`);
  assert.notEqual(readFileSync(log, "utf8").trim(), cwd, "the base check did not run in the candidate checkout");
  // The candidate is kept as it was, and the temporary checkout is gone.
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(cwd, "code.txt"), "utf8"), "fixed");
  assert.equal(worktrees(cwd).length, 1, worktrees(cwd).join("\n"));
});

/** A run whose check passes on the start commit and fails only on what the implementer's first call left, which the second call puts back. */
async function refuted(context: TestContext, prepare: (cwd: string) => void, gate: Record<string, unknown>) {
  const cwd = repo(context); prepare(cwd); const prompts: string[] = [];
  const result = await execute("implement-task", input(cwd, { checks: [gate] }), {
    implementer: request => {
      if (prompts.push(request.prompt) === 1) { writeFileSync(join(cwd, "code.txt"), "broken"); return baseFailing(); }
      writeFileSync(join(cwd, "code.txt"), "old"); writeFileSync(join(cwd, "change.txt"), "change"); return ok();
    },
    reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
  assert.equal(prompts.length, 2, "the Agent is asked once more");
  assert.doesNotMatch(prompts[0]!, /Current failure/u);
  assert.equal(worktrees(cwd).length, 1, worktrees(cwd).join("\n"));
  return { cwd, result, prompts };
}

test("an implementer's blocked saying the checks fail on the unchanged checkout, where they pass, asks the Agent once more with the evidence", async context => {
  const { result, prompts } = await refuted(context, () => {}, command('process.exit(require("fs").readFileSync("code.txt", "utf8") === "old" ? 0 : 1)'));
  const base = (result.output.checks as (Entry & { phase: string })[]).find(entry => entry.phase === "base");
  assert.ok(base, "the base check is in the receipt");
  assert.equal(base.passed, true);
  assert.ok(prompts[1]!.includes(base.log), "the second prompt points at the base check's log");
});

test("the base check runs with the candidate's ignored dependency directories linked in", async context => {
  const { cwd, result } = await refuted(context, cwd => {
    writeFileSync(join(cwd, ".gitignore"), ".machine-runs/\nnode_modules/\n");
    git(cwd, "add", "."); git(cwd, "commit", "-qm", "ignore dependencies");
    mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "dep", "index.js"), "module.exports = 'dep';\n");
  }, command('require("./node_modules/dep"); process.exit(require("fs").readFileSync("code.txt", "utf8") === "old" ? 0 : 1)'));
  const base = (result.output.checks as (Entry & { phase: string })[]).find(entry => entry.phase === "base");
  assert.ok(base, "the base check is in the receipt");
  assert.equal(base.passed, true, readFileSync(base.log, "utf8"));
  // Cleaning up the temporary checkout leaves the candidate's dependencies in place.
  assert.equal(readFileSync(join(cwd, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 'dep';\n");
});

test("a base check that cannot run on the start commit is not reported as a base failure: the Agent is asked once more", async context => {
  // The check's executable is an ignored file of the candidate's, absent from a checkout of the start commit.
  await refuted(context, cwd => {
    writeFileSync(join(cwd, ".gitignore"), ".machine-runs/\nrun-check.sh\n");
    git(cwd, "add", "."); git(cwd, "commit", "-qm", "ignore the check script");
    writeFileSync(join(cwd, "run-check.sh"), '#!/bin/sh\n[ "$(cat code.txt)" = old ]\n', { mode: 0o755 });
  }, { name: "tests", command: ["./run-check.sh"] });
});

test("a blocked naming a path outside the task's stated scope is a scope addition, and the Agent continues", async context => {
  const cwd = repo(context); let calls = 0;
  const result = await execute("implement-task", input(cwd, { task: "Change code.txt.\n\n## Scope\n\n- code.txt\n" }), {
    implementer: () => {
      if (++calls === 1) return { type: "blocked", summary: "The change also needs docs/guide.md, which is outside the scope",
        needs: [{ kind: "scope", text: "docs/guide.md documents the changed behaviour", paths: ["docs/guide.md"] }] };
      writeFileSync(join(cwd, "code.txt"), "new"); place(cwd, "docs/guide.md", "Guide\n"); return ok();
    },
    reviewer: () => ok("approved"),
  });
  assert.equal(result.state, "done", result.output?.reason); assert.equal(result.output.outcome, "completed");
  assert.equal(calls, 2);
  assert.ok((result.output.scopeAdditions as { path: string }[] | undefined)?.some(addition => addition.path === "docs/guide.md"), JSON.stringify(result.output.scopeAdditions));
});

// Prompts match the rule: editing Agents decide reversible questions themselves and run only focused tests; a reviewer blocks only on a blocker.

const ticketCannotRun = "Run the checks you can. If your environment cannot run them, as when a sandbox refuses to start processes, say which and why in your summary and still return completed: the workflow runs every required check itself after you return. Return blocked only for something a person must decide or supply.";

test("the shared prompt sentences say the rule", () => {
  const sentences = task as unknown as Record<string, unknown>;
  for (const name of ["cannotRun", "focusedTests", "assumptionsRule", "blockerRule"]) assert.equal(typeof sentences[name], "string", `task.ts exports ${name}`);
  assert.equal(sentences.cannotRun, ticketCannotRun, "the cannotRun sentence is ticket-task's, word for word");
  assert.match(sentences.focusedTests as string, /only the tests for what you changed/iu);
  assert.match(sentences.focusedTests as string, /every required check/iu);
  for (const word of [/decide/iu, /irreversible/iu, /`?assumptions`?/u, /`?scopeAdditions`?/u, /completed/u]) assert.match(sentences.assumptionsRule as string, word);
  for (const word of [/acceptance criterion/iu, /regression/iu, /safety/iu, /`?minor`?/u, /`?discussion`?/u]) assert.match(sentences.blockerRule as string, word);
});

for (const name of ["implement-task", "fix-bug", "refactor", "add-tests", "update-docs", "investigate", "upgrade-dependency", "prepare-release"]) {
  test(`${name}'s prompts ${["upgrade-dependency", "prepare-release"].includes(name) ? "are unchanged by the rule" : name === "investigate" ? "contain the assumptions instruction" : "contain the focused-tests sentence and the assumptions instruction, and its reviewer's the blocker definition"}`, async context => {
    const sentences = task as unknown as Record<string, string>;
    for (const key of ["cannotRun", "focusedTests", "assumptionsRule", "blockerRule"]) assert.equal(typeof sentences[key], "string", `task.ts exports ${key}`);
    const cwd = repo(context); const run = succeeding(name, cwd); const prompts: Record<string, string[]> = {};
    const agents = Object.fromEntries(Object.entries(run.agents).map(([role, answer]) => [role, (request: { prompt: string }) => {
      (prompts[role] ??= []).push(request.prompt); return (answer as (request: { prompt: string }) => unknown)(request);
    }]));
    const result = await execute(name, run.data, agents, run.human ? { human: run.human } : {});
    assert.equal(result.state, "done", result.output?.reason);
    const editors = { "implement-task": ["implementer"], "fix-bug": ["tester", "implementer"], refactor: ["implementer"], "add-tests": ["tester"], "update-docs": ["writer"] }[name] ?? [];
    for (const role of editors) for (const prompt of prompts[role]!) {
      for (const key of ["focusedTests", "assumptionsRule", "cannotRun"]) assert.ok(prompt.includes(sentences[key]!), `${role} prompt has ${key}`);
      assert.equal(prompt.includes(sentences.blockerRule!), false, `${role} prompt has no blockerRule`);
    }
    if (name === "investigate") for (const prompt of prompts.investigator!) assert.ok(prompt.includes(sentences.assumptionsRule!), "investigator prompt has assumptionsRule");
    if (editors.length) for (const prompt of prompts.reviewer!) assert.ok(prompt.includes(sentences.blockerRule!), "reviewer prompt has blockerRule");
    if (["upgrade-dependency", "prepare-release"].includes(name)) for (const prompt of Object.values(prompts).flat()) {
      for (const key of ["focusedTests", "assumptionsRule", "blockerRule"]) assert.equal(prompt.includes(sentences[key]!), false, `no ${key}`);
    }
  });
}

// A loud check is still judged by its exit code.

const overflow = "output exceeded 16 MiB";
for (const grouped of [false, true]) {
  const where = grouped ? " in a parallel group" : "";
  test(`a check that prints 2 MiB and exits 0 passes${where}`, async context => {
    const cwd = repo(context);
    const result = await execute("verify-checks", input(cwd, { checks: [command('process.stdout.write("x".repeat(2*1024*1024))', grouped ? { group: "g" } : {})] }));
    assert.equal(result.state, "done", result.output?.reason);
    const [entry, ...rest] = result.output.checks as (Entry & { error?: string })[];
    assert.deepEqual(rest, []);
    assert.equal(entry!.passed, true); assert.equal(entry!.error, undefined);
    assert.equal(statSync(entry!.log).size, 2 * 1024 * 1024, "the log holds the whole output");
  });

  test(`a check that prints 20 MiB is recorded as failed with the overflow reason, not as an error${where}`, async context => {
    const cwd = repo(context);
    await assert.rejects(execute("verify-checks", input(cwd, { checks: [command('process.stdout.write("x".repeat(20*1024*1024))', grouped ? { group: "g" } : {})] })), /Required checks failed/u);
    const [receipt] = receipts(cwd);
    assert.equal(receipt.checksPassed, false);
    assert.ok(receipt.checks.length >= 1);
    for (const entry of receipt.checks as (Entry & { error?: string })[]) {
      assert.equal(entry.passed, false);
      assert.equal(entry.error, undefined, "an overflow is a failed check, not an error");
      assert.ok(JSON.stringify(entry).includes(overflow), JSON.stringify(entry));
      assert.ok(statSync(entry.log).size > 1024 * 1024, "the log is written from what was captured");
    }
    assert.ok(receipt.reason.includes(overflow), receipt.reason);
  });
}

test("the repair prompt after a check's output overflows says what happened", async context => {
  const cwd = repo(context); const prompts: string[] = [];
  await execute("implement-task", input(cwd, { maxRepairs: 1, checks: [command('process.stdout.write("x".repeat(20*1024*1024))')] }), {
    implementer: request => { prompts.push(request.prompt); return ok(); }, reviewer: () => ok("approved"),
  });
  assert.equal(prompts.length, 2);
  assert.ok((prompts[1]!.split("Current failure/feedback: ")[1] ?? "").includes(overflow), prompts[1]);
});

// Additional edge cases for the shared recovery contract.
for (const field of ["assumptions", "scopeAdditions"]) {
  test(`a malformed ${field} is sent back before the editing report is accepted`, async context => {
    const cwd = repo(context); const prompts: string[] = [];
    const result = await execute("implement-task", input(cwd), {
      implementer: request => {
        prompts.push(request.prompt);
        return prompts.length === 1 ? { ...ok(), [field]: null } : ok();
      },
      reviewer: () => ok("approved"),
    });
    assert.equal(result.state, "done");
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1]!.includes(`${field} must be an array`));
  });
}

test("a scope recovery is bounded and preserves the first addition without duplicates", async context => {
  const cwd = repo(context); let calls = 0;
  const result = await execute("implement-task", input(cwd), {
    reviewer: () => assert.fail("a blocked editor does not reach review"),
    implementer: () => {
      calls++;
      return { type: "blocked", summary: "Need another file", needs: [{ kind: "scope", text: "Document this behavior", paths: ["docs/guide.md"] }] };
    },
  });
  assert.equal(result.state, "blocked");
  assert.equal(calls, 2);
  assert.deepEqual(result.output.scopeAdditions, [{ path: "docs/guide.md", why: "Document this behavior" }]);
});

test("a scope claim inside the stated scope is not automatically retried", async context => {
  const cwd = repo(context); let calls = 0;
  const result = await execute("implement-task", input(cwd, { task: "Change docs.\n\n## Scope\n- docs/**\n\n## Acceptance\n- Explain the change" }), {
    reviewer: () => assert.fail("a blocked editor does not reach review"),
    implementer: () => {
      calls++;
      return { type: "blocked", summary: "Need clarification", needs: [{ kind: "scope", text: "Document this behavior", paths: ["docs/guide.md"] }] };
    },
  });
  assert.equal(result.state, "blocked"); assert.equal(calls, 1);
  assert.deepEqual(result.output.scopeAdditions, []);
});

test("a confirmed base failure runs only the named check once, regardless of its layered selection", async context => {
  const cwd = repo(context);
  const result = await execute("implement-task", input(cwd, { checks: [
    command("process.exit(1)", { when: ["unrelated/**"], group: "g" }),
    command("process.exit(0)", { name: "other", group: "g" }),
  ] }), { implementer: () => baseFailing(), reviewer: () => assert.fail("confirmed base failure does not reach review") });
  assert.equal(result.state, "blocked");
  assert.match(result.output.reason, /base: tests fails/u);
  assert.deepEqual(result.output.checks.map((entry: { name: string; phase: string }) => [entry.name, entry.phase]), [["tests", "base"]]);
  assert.equal(worktrees(cwd).length, 1);
});

test("a missing base dependency is unrunnable and returns evidence to the implementer", async context => {
  const { result, prompts } = await refuted(context, cwd => {
    writeFileSync(join(cwd, ".gitignore"), ".machine-runs/\nlocal-dependency.js\n");
    git(cwd, "add", "."); git(cwd, "commit", "-qm", "ignore local dependency");
    writeFileSync(join(cwd, "local-dependency.js"), "module.exports = true;\n");
  }, command('require("./local-dependency.js"); process.exit(require("fs").readFileSync("code.txt", "utf8") === "old" ? 0 : 1)'));
  const base = result.output.checks.find((entry: { phase: string }) => entry.phase === "base");
  assert.equal(base.passed, false);
  assert.ok(prompts[1]!.includes(base.log));
  assert.match(prompts[1]!, /could not run reliably/u);
});

test("base verification runs configured setup and rejects setup that changes tracked source", context => {
  const cwd = repo(context);
  const work = taskRun("custom", input(cwd), { trusted: true, checks: true, git: "clean", setup: [
    { ...command('require("fs").writeFileSync("code.txt", "setup changed source")'), timeoutMs: 1000 },
  ] });
  work.start(); work.receive(baseFailing()); work.reported("change");
  assert.equal(work.mechanical("change").type, "verifyBase");
  assert.equal(work.verifyBase().type, "unrunnable");
  assert.match(work.status().reason, /could not verify/u);
  assert.equal(readFileSync(join(cwd, "code.txt"), "utf8"), "old");
  assert.equal(worktrees(cwd).length, 1);
  work.finish("blocked");
  assert.deepEqual((work.output()!.checks as { phase: string }[]).map(entry => entry.phase), ["base-setup"]);
});
