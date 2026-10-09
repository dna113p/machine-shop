import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { runtime } from "./runtime.ts";

const mod = await import(pathToFileURL(resolve("ticket-task.ts")).href);
const branch = "ticket/proj-12";
const url = "https://example.invalid/acme/widgets/pull/7";
const hosted = "https://example.invalid/acme/widgets";
const slug = "example.invalid/acme/widgets";
const ok = (type = "completed", summary = "Evidence from the bounded fake runner") => ({ type, summary });
const command = (code = 'console.log("check passed")', extra = {}) => ({ name: "tests", command: [process.execPath, "-e", code], ...extra });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dev-ticket-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "widgets"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  writeFileSync(join(repo, "code.txt"), "old");
  git(repo, "add", "."); git(repo, "commit", "-qm", "baseline");
  return { root, repo, head: git(repo, "rev-parse", "HEAD"), evidence: join(root, "evidence"), worktree: join(root, "worktrees", "widgets--proj-12") };
}
type Fixture = ReturnType<typeof fixture>;
const input = (f: Fixture, repository = {}, extra = {}) => ({
  ticket: { id: "PROJ-12", title: "Add a greeting", body: "Write hello to greeting.txt.", source: "tk", metadata: { priority: 2 } },
  repository: { name: "widgets", path: f.repo, checks: [command()], output: "branch", ...repository },
  worktreeRoot: join(f.root, "worktrees"), evidenceRoot: f.evidence, ...extra,
});
/** A local bare repository stands in for the remote; nothing leaves the machine. */
function remote(f: Fixture) {
  const bare = join(f.root, "remote.git");
  git(f.root, "init", "-q", "--bare", bare);
  // The remote names a hosted repository, as gh needs; Git itself is redirected to the local bare one.
  git(f.repo, "remote", "add", "origin", `${hosted}.git`); git(f.repo, "config", `url.${bare}.insteadOf`, `${hosted}.git`);
  return () => git(bare, "for-each-ref", "--format=%(refname) %(objectname)");
}
/** A recording gh placed first on PATH; the real gh is never started. */
function fakeGh(context: TestContext, f: Fixture, exitCode = 0) {
  const bin = join(f.root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\necho "Creating pull request for ${branch}"\necho ${url}\nexit ${exitCode}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  context.after(() => { process.env.PATH = path; });
  return () => existsSync(join(bin, "args")) ? readFileSync(join(bin, "args"), "utf8").trimEnd().split("\n") : undefined;
}
const implement = (request: { cwd: string }) => { writeFileSync(join(request.cwd, "greeting.txt"), "hello\n"); return ok(); };
type Ask = { prompt: string; choices?: readonly string[] };
/** Answers Human requests in order and keeps what each one showed; one more request than answers fails the run. */
function person(...answers: (string | (() => string))[]) {
  const requests: Ask[] = [];
  return Object.assign((request: Ask) => {
    requests.push(request);
    const next = answers.shift();
    if (next === undefined) throw new Error("Unexpected Human request");
    return typeof next === "string" ? next : next();
  }, { requests });
}
async function execute(assignment: unknown, agents = {}, human: (request: Ask) => string = person()) {
  const states: string[] = [];
  const result = await runtime.run(mod.default(runtime, assignment), {
    agents: { investigator: () => ok("ready", "Plan: add greeting.txt"), implementer: implement, reviewer: () => ok("approved", "Greeting matches the ticket"), ...agents },
    human, onState: state => states.push(String(state)),
  });
  return { state: result.value, output: result.output as any, states };
}
function evidence(f: Fixture) {
  const runs = join(f.evidence, ".machine-runs/dev-machines");
  const [id, ...others] = readdirSync(runs); assert.deepEqual(others, []);
  const read = (name: string) => JSON.parse(readFileSync(join(runs, id!, name), "utf8"));
  return { directory: join(runs, id!), result: read("result.json"), delivery: read("delivery.json") };
}
/** The source checkout keeps its branch, HEAD, index, and files; the run's evidence is elsewhere. */
function untouched(f: Fixture) {
  assert.equal(git(f.repo, "symbolic-ref", "--short", "HEAD"), "main"); assert.equal(git(f.repo, "rev-parse", "HEAD"), f.head);
  assert.equal(git(f.repo, "status", "--porcelain", "--untracked-files=all"), ""); assert.equal(readFileSync(join(f.repo, "code.txt"), "utf8"), "old");
}
/** Every ending is a strict hold: Machines Dispatch rejects extra fields and must not close the ticket. */
function held(f: Fixture, result: { output: any }, summary: RegExp) {
  assert.deepEqual(result.output, { action: "hold", summary: result.output.summary });
  assert.match(result.output.summary, summary); assert.doesNotMatch(result.output.summary, /\n/u);
  const run = evidence(f); assert.ok(result.output.summary.endsWith(`Evidence: ${run.directory}`));
  return run;
}
function blocked(f: Fixture, result: { state: unknown; output: any }, reason: RegExp, commits = 0) {
  assert.equal(result.state, "blocked");
  const run = held(f, result, reason); untouched(f);
  assert.equal(run.result.outcome, "blocked"); assert.equal(run.delivery.outcome, "blocked"); assert.match(run.delivery.reason, reason);
  assert.equal(git(f.repo, "rev-list", "--count", `main..${branch}`), String(commits));
  assert.ok(existsSync(join(f.worktree, "code.txt"))); assert.ok(result.output.summary.includes(`Worktree kept at ${f.worktree}.`));
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved], [true, false]);
  return run;
}
/** What a checkout holds beyond its HEAD: its status and every tracked or unignored file with its mode, leaving out run evidence. Ignored files count on request. */
function candidate(cwd: string, ignored = false) {
  const names = git(cwd, "ls-files", "--cached", "--others", ...(ignored ? [] : ["--exclude-standard"])).split("\n")
    .filter(name => name && !name.startsWith(".machine-runs/") && existsSync(join(cwd, name)));
  return {
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all", ...(ignored ? ["--ignored"] : []), "--", ".", ":(exclude).machine-runs"),
    files: [...new Set(names)].sort().map(name => [name, statSync(join(cwd, name)).mode & 0o111, readFileSync(join(cwd, name), "base64")]),
  };
}
/** A handed-off run went through the decision, not the failure path, and left the worktree on its uncommitted ticket branch. */
function handedOff(f: Fixture, result: { state: unknown; output: any; states: string[] }, reason: RegExp, human: { requests: Ask[] }) {
  assert.equal(result.state, "handedOff"); assert.deepEqual(result.states.slice(-3), ["decide", "handOff", "handedOff"]); assert.equal(result.states.includes("failure"), false);
  assert.match(human.requests.at(-1)!.prompt, reason);
  const run = held(f, result, reason); untouched(f);
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision], ["blocked", "handed-off", "hand off"]); assert.match(run.delivery.reason, reason);
  assert.equal(git(f.repo, "rev-parse", branch), f.head); assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
  assert.ok(result.output.summary.includes(`Decision: hand off. Worktree kept at ${f.worktree}. Evidence: `));
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.delivery.patch], [true, false, null, undefined]);
  return run;
}
/** An abandoned run leaves neither its worktree nor its branch, and the source checkout as it was. */
function abandoned(f: Fixture, result: { state: unknown; output: any; states: string[] }, decision: string) {
  assert.equal(result.state, "abandoned"); assert.deepEqual(result.states.slice(-3), ["remove", "abandon", "abandoned"]);
  const run = held(f, result, /^Abandoned: /u); untouched(f);
  assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision], ["blocked", "abandoned", decision]);
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit], [true, true, null]);
  assert.ok(result.output.summary.includes(`Decision: ${decision}.`)); assert.doesNotMatch(result.output.summary, /Worktree kept/u);
  return run;
}

test("construction has no effects and declares exactly the three roles", context => {
  const f = fixture(context);
  assert.match(mod.description, /\S/u); assert.doesNotMatch(mod.description, /\n/u);
  for (const data of [input(f, { output: "pr", setup: [command()] }), JSON.stringify(input(f))]) {
    assert.deepEqual(runtime.requiredAgentNames(mod.default(runtime, data)), ["implementer", "investigator", "reviewer"]);
  }
  assert.deepEqual(Object.keys(mod.agentRoles).sort(), ["implementer", "investigator", "reviewer"]);
  assert.deepEqual(readdirSync(f.root), ["widgets"]);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main"); untouched(f);
});

for (const output of ["branch", "patch", "pr"]) {
  test(`${output} delivery commits the reviewed candidate without touching the source checkout`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
    const result = await execute(input(f, { output }), {
      investigator: request => { assert.equal(request.cwd, f.worktree); assert.match(request.prompt, /Ticket PROJ-12: Add a greeting\n\nWrite hello/u); return ok("ready", "Plan: add greeting.txt"); },
      implementer: request => { assert.equal(request.cwd, f.worktree); assert.match(request.prompt, /Plan: add greeting\.txt/u); assert.match(request.prompt, /uncommitted/u); return implement(request); },
      reviewer: request => { assert.equal(request.cwd, f.worktree); assert.match(request.prompt, /Do not edit/u); return ok("approved", "Greeting matches the ticket"); },
    });
    assert.equal(result.state, "delivered");
    assert.deepEqual(result.states, ["prepare", "start", "triage", "triageResult", "change", "verify", "sealReview", "review", "reviewResult", "commit", "deliver", "success", "delivered"]);
    const commit = git(f.repo, "rev-parse", branch);
    const run = held(f, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
    assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", branch), "Add a greeting\nTicket: PROJ-12");
    assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.txt");
    assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello");
    assert.ok(run.directory.startsWith(join(f.evidence, ".machine-runs")));
    assert.equal(existsSync(join(f.repo, ".machine-runs")), false);
    assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
    assert.doesNotMatch(result.output.summary, /Worktree kept/u);
    assert.deepEqual(run.delivery, {
      schemaVersion: 1, outcome: "delivered", ticket: "PROJ-12", repository: { name: "widgets", path: f.repo }, branch, baseCommit: f.head, commit, output,
      ...(output === "pr" ? { prUrl: url } : {}), ...(output === "patch" ? { patches: [join(run.directory, "0001-Add-a-greeting.patch")] } : {}),
      worktree: f.worktree, worktreeCreated: true, worktreeRemoved: true,
    });
    assert.deepEqual([run.result.workflow, run.result.outcome, run.result.checksPassed, run.result.agentInvocations], ["ticket-task", "completed", true, 3]);
    assert.ok(run.result.checks.every(c => c.passed && c.log.startsWith(run.directory) && existsSync(c.log)));
    if (output === "patch") {
      const patch = readFileSync(run.delivery.patches[0], "utf8");
      assert.match(patch, /Subject: \[PATCH\] Add a greeting/u); assert.match(patch, /\+hello/u);
      assert.ok(result.output.summary.includes(run.delivery.patches[0]));
    }
    if (output !== "pr") { assert.equal(pushed(), ""); assert.equal(gh(), undefined); return; }
    assert.equal(pushed(), `refs/heads/${branch} ${commit}`);
    const body = join(run.directory, "pull-request.md");
    assert.deepEqual(gh(), ["pr", "create", "--repo", slug, "--draft", "--head", branch, "--title", "Add a greeting", "--body-file", body]);
    assert.equal(readFileSync(body, "utf8"), "Ticket: PROJ-12\n\nAdd a greeting\n\n## Checks\n\n- tests: passed\n\n## Review\n\nGreeting matches the ticket\n\n");
    assert.ok(result.output.summary.includes(`pull request ${url}`));
  });
}

test("an explicit branch base starts the worktree there and becomes the pull request base", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  git(f.repo, "branch", "release"); writeFileSync(join(f.repo, "code.txt"), "newer"); git(f.repo, "commit", "-qam", "newer"); f.head = git(f.repo, "rev-parse", "HEAD");
  const result = await execute(input(f, { output: "pr", base: "release", draft: false }));
  assert.equal(result.state, "delivered");
  assert.equal(git(f.repo, "rev-parse", `${branch}^`), git(f.repo, "rev-parse", "release")); assert.equal(evidence(f).delivery.baseCommit, git(f.repo, "rev-parse", "release"));
  assert.deepEqual(gh()!.slice(0, 8), ["pr", "create", "--repo", slug, "--base", "release", "--head", branch]);
  assert.equal(readFileSync(join(f.repo, "code.txt"), "utf8"), "newer");
});

test("a base that is a commit rather than a branch is not passed to gh", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  const result = await execute(input(f, { output: "pr", base: f.head }));
  assert.equal(result.state, "delivered"); assert.equal(gh()!.includes("--base"), false);
});

test("setup commands run in the worktree before any Agent and are kept as evidence", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, ".gitignore"), "deps/\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "ignore deps"); f.head = git(f.repo, "rev-parse", "HEAD");
  const install = 'require("fs").mkdirSync("deps");require("fs").writeFileSync("deps/installed","x");console.log(process.cwd())';
  const result = await execute(input(f, { setup: [command(install, { name: "install" })] }), {
    investigator: request => { assert.ok(existsSync(join(request.cwd, "deps/installed"))); return ok("ready"); },
  });
  assert.equal(result.state, "delivered"); untouched(f);
  const run = evidence(f); const [setup, verify] = run.result.checks;
  assert.deepEqual([setup.phase, setup.name, setup.passed, verify.phase], ["setup", "install", true, "verify"]);
  assert.match(readFileSync(setup.log, "utf8"), /widgets--proj-12/u);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.txt"); assert.equal(run.delivery.worktreeRemoved, true);
});

for (const [label, code, reason] of [
  ["a failing setup command", "process.exit(3)", /setup: tests did not meet/u],
  ["a setup command that leaves unignored files", 'require("fs").writeFileSync("generated.txt", "x")', /setup command changed/u],
] as const) {
  test(`${label} blocks before any Agent and keeps the worktree`, async context => {
    const f = fixture(context);
    const result = await execute(input(f, { setup: [command(code)] }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    const run = blocked(f, result, reason);
    assert.deepEqual(result.states, ["prepare", "failure", "blocked"]);
    assert.deepEqual([run.result.checks[0].phase, run.result.checks[0].passed, existsSync(run.result.checks[0].log)], ["setup", label.startsWith("a setup"), true]);
  });
}

for (const [label, occupy] of [
  ["branch", (f: Fixture) => git(f.repo, "branch", branch)],
  ["worktree directory", (f: Fixture) => mkdirSync(f.worktree, { recursive: true })],
] as const) {
  test(`an existing ${label} blocks without changing anything`, async context => {
    const f = fixture(context); occupy(f);
    const branches = git(f.repo, "branch", "--format=%(refname:short) %(objectname)");
    const result = await execute(input(f, { setup: [command("process.exit(1)")] }), { investigator: () => assert.fail() });
    assert.equal(result.state, "blocked"); untouched(f);
    const run = held(f, result, /already exists/u);
    assert.doesNotMatch(result.output.summary, /Worktree kept/u);
    assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.result.checks.length], [false, false, null, 0]);
    assert.equal(git(f.repo, "branch", "--format=%(refname:short) %(objectname)"), branches);
    assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
    assert.deepEqual(existsSync(f.worktree) ? readdirSync(f.worktree) : [], []);
  });
}

test("a ticket that triage finds unactionable waits for a decision with what is missing", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { investigator: () => ok("blocked", "Acceptance criteria\nare missing"), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  handedOff(f, result, /Acceptance criteria\s+are missing/u, human);
  assert.ok(result.output.summary.startsWith(`Handed off on ${branch}: Acceptance criteria are missing. Decision: hand off. Worktree kept at ${f.worktree}. Evidence: `));
});

test("triage that edits the worktree waits for a decision before implementation", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { investigator: request => { writeFileSync(join(request.cwd, "code.txt"), "edited"); return ok("ready"); }, implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  handedOff(f, result, /read-only stage/u, human);
});

test("an implementer blocker waits for a decision without checks, review, or a commit", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { implementer: () => ok("blocked", "Required API specification unavailable"), reviewer: () => assert.fail() }, human);
  const run = handedOff(f, result, /specification unavailable/u, human);
  assert.equal(run.result.checks.length, 0);
});

test("checks failing until the repair budget is exhausted wait for a decision, and commit and push nothing", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); let edits = 0; const human = person("hand off");
  const result = await execute(input(f, { output: "pr", checks: [command("process.exit(1)")] }, { maxRepairs: 2 }), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => assert.fail(),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(2\)/u, human);
  assert.equal(edits, 3); assert.deepEqual(run.result.checks.map(c => c.passed), [false, false, false]);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined);
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
  const [request, ...others] = human.requests; assert.deepEqual(others, []);
  assert.deepEqual(request!.choices, ["more rounds", "hand off", "archive", "discard"]);
  for (const part of ["Ticket PROJ-12: Add a greeting", `Repair budget exhausted (2). verify: tests did not meet its expected result; inspect ${run.result.checks[2].log}`,
    "Repair rounds used: 2 of 2.", `Worktree: ${f.worktree}`, `Branch: ${branch}`]) assert.ok(request!.prompt.includes(part), part);
});

test("review feedback is repaired once through fresh checks and another review", async context => {
  const f = fixture(context); let edits = 0; let reviews = 0;
  const result = await execute(input(f), {
    implementer: request => { if (++edits === 2) assert.match(request.prompt, /Handle the empty case/u); writeFileSync(join(request.cwd, "greeting.txt"), `hello ${edits}\n`); return ok(); },
    reviewer: () => ++reviews === 1 ? ok("revise", "Handle the empty case") : ok("approved"),
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [2, 2]);
  const run = evidence(f); assert.equal(run.result.repairs, 1); assert.equal(run.result.checks.length, 2);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello 2"); assert.equal(git(f.repo, "rev-list", "--count", `main..${branch}`), "1");
});

test("a reviewer that edits a file cannot approve the candidate", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { reviewer: request => { writeFileSync(join(request.cwd, "greeting.txt"), "unreviewed"); return ok("approved"); } }, human);
  handedOff(f, result, /read-only stage/u, human);
});

test("a reviewer blocker waits for a decision", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { reviewer: () => ok("blocked", "The ticket contradicts the existing contract") }, human);
  handedOff(f, result, /contradicts the existing contract/u, human);
});

test("the default budget allows three repairs before review feedback waits for a decision", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const result = await execute(input(f), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => ok("revise", `Finding ${++reviews}`),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(3\)\. Finding 4/u, human);
  assert.deepEqual([edits, reviews, run.result.repairs, run.result.checksPassed], [4, 4, 3, true]);
  assert.ok(human.requests[0]!.prompt.includes("Repair rounds used: 3 of 3."));
});

test("a base that does not resolve still ends blocked in prepare without a Human step", async context => {
  const f = fixture(context);
  const result = await execute(input(f, { base: "no-such-branch" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["prepare", "failure", "blocked"]);
  const run = held(f, result, /^Blocked: Base no-such-branch does not resolve/u); untouched(f);
  assert.deepEqual([run.delivery.outcome, run.delivery.decision, run.delivery.worktreeCreated, run.result.decisions], ["blocked", undefined, false, []]);
  assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
});

test("more rounds restarts the budget with the standing findings, and an approval then delivers", async context => {
  const f = fixture(context); const human = person("more rounds"); const prompts: string[] = []; let reviews = 0;
  const result = await execute(input(f, {}, { maxRepairs: 1 }), {
    implementer: request => { prompts.push(request.prompt); writeFileSync(join(request.cwd, "greeting.txt"), `hello ${prompts.length}\n`); return ok(); },
    reviewer: () => ++reviews < 3 ? ok("revise", `Finding ${reviews}`) : ok("approved", "Greeting matches the ticket"),
  }, human);
  assert.equal(result.state, "delivered"); assert.deepEqual([prompts.length, reviews, human.requests.length], [3, 3, 1]);
  assert.deepEqual(result.states.slice(-11), ["repairBudget", "decide", "change", "verify", "sealReview", "review", "reviewResult", "commit", "deliver", "success", "delivered"]);
  assert.ok(human.requests[0]!.prompt.includes("Repair budget exhausted (1). Finding 2"));
  // The pass a person granted is briefed exactly as the ordinary repair before it was.
  assert.ok(prompts[1]!.includes("Current failure/feedback: Finding 1")); assert.ok(prompts[2]!.includes("Current failure/feedback: Finding 2"));
  assert.doesNotMatch(prompts[2]!, /budget exhausted/u);
  const commit = git(f.repo, "rev-parse", branch);
  const run = held(f, result, new RegExp(`^Delivered ${branch} at ${commit}\\. Decision: more rounds\\. Evidence: `, "u")); untouched(f);
  assert.deepEqual([run.delivery.outcome, run.delivery.decision, run.delivery.commit, run.delivery.worktreeRemoved], ["delivered", "more rounds", commit, true]);
  assert.deepEqual([run.result.outcome, run.result.repairs, run.result.agentInvocations], ["completed", 1, 7]);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello 3"); assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
  assert.equal(existsSync(f.worktree), false);
});

test("more rounds can be chosen again each time the budget runs out", async context => {
  const f = fixture(context); const human = person("more rounds", "more rounds", "hand off"); let edits = 0;
  const result = await execute(input(f, { checks: [command("process.exit(1)")] }, { maxRepairs: 1 }), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => assert.fail(),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(1\)/u, human);
  assert.equal(edits, 6); assert.equal(result.states.filter(state => state === "decide").length, 3);
  assert.deepEqual(human.requests.map(request => /Repair rounds used: .+/u.exec(request.prompt)![0]),
    ["Repair rounds used: 1 of 1.", "Repair rounds used: 1 of 1 in this budget, 2 in all.", "Repair rounds used: 1 of 1 in this budget, 3 in all."]);
  assert.deepEqual([run.result.repairs, run.result.checks.length], [3, 6]);
  assert.deepEqual(run.result.decisions.map((made: any) => made.response), ["more rounds", "more rounds", "hand off"]);
});

test("more rounds after a budget of zero still gives the implementer one pass", async context => {
  const f = fixture(context); const human = person("more rounds"); let reviews = 0;
  const result = await execute(input(f, {}, { maxRepairs: 0 }), { reviewer: () => ++reviews === 1 ? ok("revise", "Handle the empty case") : ok("approved") }, human);
  assert.equal(result.state, "delivered"); assert.equal(reviews, 2); assert.ok(human.requests[0]!.prompt.includes("Repair rounds used: 0 of 0."));
});

test("hand off leaves the worktree, the branch, and the uncommitted candidate as they were", async context => {
  const f = fixture(context); let before: unknown;
  const human = person(() => { before = candidate(f.worktree); return "hand off"; });
  const result = await execute(input(f, {}, { maxRepairs: 0 }), {
    implementer: request => { writeFileSync(join(request.cwd, "code.txt"), "new"); return implement(request); }, reviewer: () => ok("revise", "Handle the empty case"),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(0\)\. Handle the empty case/u, human);
  assert.deepEqual(candidate(f.worktree), before); assert.equal(candidate(f.worktree).status, "M code.txt\n?? greeting.txt");
  assert.equal(git(f.repo, "rev-list", "--count", `main..${branch}`), "0"); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 2);
  assert.equal(existsSync(join(run.directory, "candidate.patch")), false);
});

test("archive saves the whole candidate as a patch that applies to the base commit, then removes the worktree and branch", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, "obsolete.txt"), "remove me\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "obsolete"); f.head = git(f.repo, "rev-parse", "HEAD");
  let before: ReturnType<typeof candidate> | undefined;
  const human = person(() => { before = candidate(f.worktree); return "archive"; });
  const result = await execute(input(f, {}, { maxRepairs: 0 }), {
    implementer: request => {
      writeFileSync(join(request.cwd, "code.txt"), "new without a final newline "); rmSync(join(request.cwd, "obsolete.txt"));
      mkdirSync(join(request.cwd, "bin")); writeFileSync(join(request.cwd, "bin/tool.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
      writeFileSync(join(request.cwd, "logo.bin"), Buffer.from([0, 255, 1, 0, 128, 10, 13, 0]));
      mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/nested.json"), "{}");
      return implement(request);
    },
    reviewer: () => ok("revise", "Handle the empty case"),
  }, human);
  const run = abandoned(f, result, "archive");
  assert.deepEqual(result.states.slice(-5), ["decide", "archive", "remove", "abandon", "abandoned"]);
  const patch = join(run.directory, "candidate.patch");
  assert.equal(run.delivery.patch, patch); assert.match(run.delivery.reason, /budget exhausted \(0\)\. Handle the empty case/u);
  assert.ok(result.output.summary.includes(`Decision: archive. Candidate saved as ${patch}. Worktree and ${branch} removed. Evidence: `));
  assert.deepEqual(readdirSync(run.directory).filter(name => name.endsWith(".index")), []);
  assert.doesNotMatch(readFileSync(patch, "latin1"), /machine-runs/u);
  // A fresh clone at the base commit stands in for whoever picks the patch up later.
  const replay = join(f.root, "replay"); git(f.root, "clone", "-q", f.repo, replay); git(replay, "checkout", "-q", "--detach", f.head);
  git(replay, "apply", patch);
  assert.deepEqual(candidate(replay), before);
  assert.equal(before!.status, "M code.txt\n D obsolete.txt\n?? bin/tool.sh\n?? greeting.txt\n?? logo.bin");
});

test("archive carries ignored files, which removing the worktree would otherwise delete", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, ".gitignore"), "*.log\nbuild/\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "ignore"); f.head = git(f.repo, "rev-parse", "HEAD");
  let before: ReturnType<typeof candidate> | undefined;
  const human = person(() => { before = candidate(f.worktree, true); return "archive"; });
  const result = await execute(input(f, {}, { maxRepairs: 0 }), {
    implementer: request => {
      writeFileSync(join(request.cwd, "debug.log"), "what the implementer learned\n");
      mkdirSync(join(request.cwd, "build")); writeFileSync(join(request.cwd, "build/out.bin"), Buffer.from([0, 255, 1, 0]), { mode: 0o755 });
      mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/nested.log"), "evidence\n");
      return implement(request);
    },
    reviewer: () => ok("revise", "Handle the empty case"),
  }, human);
  const run = abandoned(f, result, "archive");
  assert.equal(before!.status, "?? greeting.txt\n!! build/out.bin\n!! debug.log");
  assert.deepEqual(before!.files.map(([name]) => name), [".gitignore", "build/out.bin", "code.txt", "debug.log", "greeting.txt"]);
  const patch = join(run.directory, "candidate.patch");
  assert.doesNotMatch(readFileSync(patch, "latin1"), /machine-runs/u);
  const replay = join(f.root, "replay"); git(f.root, "clone", "-q", f.repo, replay); git(replay, "checkout", "-q", "--detach", f.head);
  git(replay, "apply", patch);
  assert.deepEqual(candidate(replay, true), before);
});

for (const [label, edit, status] of [
  ["files the index was told to assume unchanged or to skip", (cwd: string) => {
    git(cwd, "update-index", "--assume-unchanged", "local/assumed.txt", "local/both.txt", "local/gone.txt");
    git(cwd, "update-index", "--skip-worktree", "local/skipped.txt", "local/both.txt", "local/kept.txt");
    for (const name of ["assumed", "skipped", "both"]) writeFileSync(join(cwd, `local/${name}.txt`), "new\n");
    rmSync(join(cwd, "local/gone.txt")); rmSync(join(cwd, "local/kept.txt"));
    // Git itself reports none of this, so neither would a patch built from the worktree's index as it is.
    assert.equal(git(cwd, "status", "--porcelain"), "");
  }, "M local/assumed.txt\n M local/both.txt\n D local/gone.txt\n M local/skipped.txt\n?? greeting.txt"],
  ["files outside a sparse checkout's patterns", (cwd: string) => {
    git(cwd, "sparse-checkout", "set", "--no-cone", "/*", "!/local/"); assert.equal(existsSync(join(cwd, "local")), false);
    mkdirSync(join(cwd, "local")); writeFileSync(join(cwd, "local/assumed.txt"), "new\n"); writeFileSync(join(cwd, "local/untracked.txt"), "new\n");
  }, "M local/assumed.txt\n?? greeting.txt\n?? local/untracked.txt"],
] as const) {
  test(`archive carries ${label}, which removing the worktree would otherwise delete`, async context => {
    const f = fixture(context); mkdirSync(join(f.repo, "local"));
    for (const name of ["assumed", "skipped", "both", "gone", "kept"]) writeFileSync(join(f.repo, `local/${name}.txt`), "old\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "local"); f.head = git(f.repo, "rev-parse", "HEAD");
    const result = await execute(input(f, {}, { maxRepairs: 0 }), {
      implementer: request => { edit(request.cwd); return implement(request); }, reviewer: () => ok("revise", "Handle the empty case"),
    }, person("archive"));
    const run = abandoned(f, result, "archive");
    const replay = join(f.root, "replay"); git(f.root, "clone", "-q", f.repo, replay); git(replay, "checkout", "-q", "--detach", f.head);
    git(replay, "apply", run.delivery.patch);
    assert.equal(git(replay, "status", "--porcelain", "--untracked-files=all"), status);
    // A file the checkout left out is not a deletion.
    assert.equal(readFileSync(join(replay, "local/kept.txt"), "utf8"), "old\n"); assert.equal(readFileSync(join(replay, "local/assumed.txt"), "utf8"), "new\n");
  });
}

/** A base whose attributes make Git convert line endings and run a clean filter, so its trees do not hold the bytes of the files. */
function converting(f: Fixture) {
  writeFileSync(join(f.repo, ".gitattributes"), "* text=auto\n*.bat text eol=crlf\n*.secret filter=redact\n"); writeFileSync(join(f.repo, "run.bat"), "echo one\r\n");
  git(f.repo, "config", "filter.redact.clean", "sed 's/token=.*/token=REDACTED/'");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "attributes"); f.head = git(f.repo, "rev-parse", "HEAD");
  assert.equal(git(f.repo, "cat-file", "-p", "HEAD:run.bat"), "echo one");
}

test("archive reproduces byte for byte the files whose line endings or content Git would change on the way into a patch", async context => {
  const f = fixture(context); converting(f);
  let before: ReturnType<typeof candidate> | undefined;
  const human = person(() => { before = candidate(f.worktree); return "archive"; });
  const result = await execute(input(f, {}, { maxRepairs: 0 }), {
    implementer: request => {
      const write = (name: string, bytes: string) => writeFileSync(join(request.cwd, name), bytes);
      assert.equal(readFileSync(join(request.cwd, "run.bat"), "utf8"), "echo one\r\n");
      write("run.bat", "echo one\r\necho two\r\n"); write("code.txt", "new\r\nlines\r\n"); write("notes.txt", "one\r\ntwo\r\n");
      write("mixed.txt", "one\r\ntwo\n"); write("api.secret", "token=abc\n"); symlinkSync("notes.txt", join(request.cwd, "alias"));
      return implement(request);
    },
    reviewer: () => ok("revise", "Handle the empty case"),
  }, human);
  const run = abandoned(f, result, "archive");
  assert.equal(before!.status, "M code.txt\n M run.bat\n?? alias\n?? api.secret\n?? greeting.txt\n?? mixed.txt\n?? notes.txt");
  assert.deepEqual(readdirSync(run.directory).filter(name => name.startsWith("candidate.") || name.endsWith(".index")), ["candidate.patch"]);
  // A conversion that a checkout undoes stays as Git records it; a file it would not give back is saved as it is.
  const patch = readFileSync(run.delivery.patch, "latin1");
  assert.match(patch, /\+echo two\n/u); assert.match(patch, /\+lines\r\n/u); assert.match(patch, /\+two\r\n/u); assert.match(patch, /\+one\r\n\+two\n/u);
  assert.match(patch, /\+token=abc\n/u); assert.doesNotMatch(patch, /REDACTED/u);
  // Whoever applies it has the filter configured, as this repository does, or does not, as a fresh clone.
  for (const configured of [false, true]) {
    const replay = join(f.root, `replay-${configured}`); git(f.root, "clone", "-q", f.repo, replay); git(replay, "checkout", "-q", "--detach", f.head);
    if (configured) git(replay, "config", "filter.redact.clean", git(f.repo, "config", "filter.redact.clean"));
    git(replay, "apply", run.delivery.patch);
    assert.deepEqual(candidate(replay), before); assert.equal(readlinkSync(join(replay, "alias")), "notes.txt");
  }
});

for (const [label, spoil, name] of [
  ["line endings that a checkout rewrites", (cwd: string) => writeFileSync(join(cwd, "run.bat"), "echo one\r\necho two\n"), "run.bat"],
  ["line endings that Git does not count as a change", (cwd: string) => writeFileSync(join(cwd, "run.bat"), "echo one\n"), "run.bat"],
  ["a path that is neither a file nor a symbolic link", (cwd: string) => { execFileSync("mkfifo", [join(cwd, "queue")]); }, "queue"],
] as const) {
  test(`a candidate with ${label} cannot be rebuilt from a patch, so archive ends blocked with nothing removed`, async context => {
    const f = fixture(context); converting(f);
    let before: unknown;
    const human = person(() => { before = candidate(f.worktree); return "archive"; });
    const result = await execute(input(f, {}, { maxRepairs: 0 }), {
      implementer: request => { spoil(request.cwd); return implement(request); }, reviewer: () => ok("revise", "Handle the empty case"),
    }, human);
    const run = blocked(f, result, new RegExp(`candidate patch could not be written, so nothing was removed: a patch cannot give back ${name} byte for byte`, "u"));
    assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
    assert.deepEqual([run.delivery.decision, run.delivery.patch], ["archive", undefined]);
    assert.deepEqual(readdirSync(run.directory).filter(name => name.startsWith("candidate.") || name.endsWith(".index")), []);
    assert.deepEqual(candidate(f.worktree), before); assert.equal(git(f.repo, "rev-parse", branch), f.head);
    assert.equal(statSync(join(f.worktree, name)).isFile(), name !== "queue");
  });
}

test("a candidate that does not differ from its base has no patch that applies, so archive ends blocked with nothing removed", async context => {
  const f = fixture(context); const human = person("archive");
  const result = await execute(input(f), { investigator: () => ok("blocked", "The ticket names no file"), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  const run = blocked(f, result, /candidate patch could not be written, so nothing was removed: the candidate does not differ from the base commit/u);
  assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
  assert.deepEqual([run.delivery.decision, run.delivery.patch], ["archive", undefined]);
  assert.deepEqual(readdirSync(run.directory).filter(name => name.startsWith("candidate.") || name.endsWith(".index")), []);
  assert.equal(candidate(f.worktree, true).status, ""); assert.equal(git(f.repo, "rev-parse", branch), f.head);
});

// With passing checks the helper can no longer fingerprint the kept worktree at the end; the run still ends blocked rather than failing.
for (const [checks, check] of [["failing", command("process.exit(1)")], ["passing", command()]] as const) {
  test(`a nested repository, whose files a patch cannot carry, ends archive blocked with nothing removed after ${checks} checks`, async context => {
    const f = fixture(context);
    const human = person(() => {
      const nested = join(f.worktree, "vendor"); git(f.worktree, "init", "-q", nested); writeFileSync(join(nested, "lib.txt"), "vendored\n");
      git(nested, "add", "."); git(nested, "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", "vendored");
      return "archive";
    });
    const result = await execute(input(f, { checks: [check] }, { maxRepairs: 0 }), { reviewer: () => checks === "passing" ? ok("revise", "Handle the empty case") : assert.fail() }, human);
    const run = blocked(f, result, /candidate patch could not be written, so nothing was removed: a patch cannot carry the files of the nested Git repository vendor\./u);
    assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]); assert.equal(run.result.checksPassed, false);
    assert.deepEqual(readdirSync(run.directory).filter(name => name.startsWith("candidate.") || name.endsWith(".index")), []);
    assert.equal(readFileSync(join(f.worktree, "vendor/lib.txt"), "utf8"), "vendored\n"); assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
    assert.equal(git(f.repo, "rev-parse", branch), f.head);
  });
}

test("a candidate that cannot be written as a patch ends blocked with nothing removed", async context => {
  const f = fixture(context);
  // Git refuses to add an embedded repository that has no commit.
  const human = person(() => { git(f.worktree, "init", "-q", "embedded"); return "archive"; });
  const result = await execute(input(f, { checks: [command("process.exit(1)")] }, { maxRepairs: 0 }), { reviewer: () => assert.fail() }, human);
  const run = blocked(f, result, /candidate patch could not be written, so nothing was removed; inspect .+git-add\.log/u);
  assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
  assert.deepEqual([run.delivery.decision, run.delivery.patch], ["archive", undefined]); assert.ok(existsSync(join(run.directory, "git-add.log")));
  assert.deepEqual(readdirSync(run.directory).filter(name => name.startsWith("candidate.") || name.endsWith(".index")), []);
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n"); assert.equal(git(f.repo, "rev-parse", branch), f.head);
});

test("discard then go back returns to the decision with the worktree, branch, and candidate as they were", async context => {
  const f = fixture(context); let before: unknown; let between: unknown;
  const human = person(() => { before = candidate(f.worktree); return "discard"; }, "go back", () => { between = candidate(f.worktree); return "hand off"; });
  const result = await execute(input(f, {}, { maxRepairs: 0 }), { reviewer: () => ok("revise", "Handle the empty case") }, human);
  assert.deepEqual(result.states.slice(-5), ["decide", "confirmDiscard", "decide", "handOff", "handedOff"]);
  const run = handedOff(f, result, /budget exhausted \(0\)\. Handle the empty case/u, human);
  assert.deepEqual(between, before); assert.deepEqual(candidate(f.worktree), before);
  const [first, confirm, second] = human.requests;
  assert.deepEqual(confirm!.choices, ["confirm discard", "go back"]);
  for (const part of [f.worktree, branch, "will not be saved"]) assert.ok(confirm!.prompt.includes(part), part);
  assert.deepEqual([second!.prompt, second!.choices], [first!.prompt, first!.choices]);
  assert.deepEqual(run.result.decisions.map((made: any) => `${made.stage}: ${made.response}`), ["decide: discard", "confirmDiscard: go back", "decide: hand off"]);
  assert.equal(existsSync(join(run.directory, "candidate.patch")), false);
});

test("discard removes the worktree and branch only after it is confirmed, and saves no patch", async context => {
  const f = fixture(context); let unconfirmed = false;
  const human = person("discard", () => { unconfirmed = existsSync(join(f.worktree, "greeting.txt")) && git(f.repo, "rev-parse", branch) === f.head; return "confirm discard"; });
  const result = await execute(input(f, {}, { maxRepairs: 0 }), { reviewer: () => ok("revise", "Handle the empty case") }, human);
  assert.ok(unconfirmed); assert.deepEqual(result.states.slice(-5), ["decide", "confirmDiscard", "remove", "abandon", "abandoned"]);
  const run = abandoned(f, result, "discard");
  assert.equal(run.delivery.patch, undefined); assert.equal(existsSync(join(run.directory, "candidate.patch")), false);
  assert.ok(result.output.summary.includes(`Decision: discard. Worktree and ${branch} removed without saving the candidate. Evidence: `));
  assert.deepEqual(run.result.decisions.map((made: any) => made.response), ["discard", "confirm discard"]);
});

test("a worktree that cannot be removed after a confirmed discard ends blocked with the saved log", async context => {
  const f = fixture(context);
  const human = person("discard", () => { git(f.repo, "worktree", "lock", f.worktree); return "confirm discard"; });
  const result = await execute(input(f, {}, { maxRepairs: 0 }), { reviewer: () => ok("revise", "Handle the empty case") }, human);
  const run = blocked(f, result, /git worktree failed; inspect .+git-worktree\.log/u);
  assert.match(readFileSync(join(run.directory, "git-worktree.log"), "utf8"), /locked/u); assert.equal(run.delivery.decision, "discard");
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n"); assert.equal(git(f.repo, "rev-parse", branch), f.head);
});

/** Ends a first run handed off with its uncommitted candidate, and returns the fixture a second run records its own evidence under. */
async function handOff(f: Fixture) {
  const first = await execute(input(f, { setup: [command('console.log("installed")', { name: "install" })] }, { maxRepairs: 0 }), { reviewer: () => ok("revise", "Handle the empty case") }, person("hand off"));
  assert.equal(first.state, "handedOff");
  return { ...f, evidence: join(f.root, "evidence-resumed") };
}

test("a resumed run verifies, reviews, and delivers the candidate a handed-off run left, without triage or setup", async context => {
  const f = fixture(context); const again = await handOff(f);
  const result = await execute(input(again, { setup: [command("process.exit(1)", { name: "install" })] }, { resume: true }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => { assert.equal(request.cwd, f.worktree); assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), "hello\n"); return ok("approved", "Greeting matches the ticket"); },
  });
  assert.equal(result.state, "delivered");
  assert.deepEqual(result.states, ["prepare", "verify", "sealReview", "review", "reviewResult", "commit", "deliver", "success", "delivered"]);
  const commit = git(f.repo, "rev-parse", branch);
  const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
  assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head); assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.txt");
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello"); assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", branch), "Add a greeting\nTicket: PROJ-12");
  assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
  assert.deepEqual([run.delivery.outcome, run.delivery.resumed, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.decision], ["delivered", true, false, true, undefined]);
  assert.deepEqual([run.result.checks.map((check: any) => check.phase), run.result.repairs, run.result.agentInvocations], [["verify"], 0, 1]);
});

test("a resumed run whose review asks for changes repairs within a fresh budget", async context => {
  const f = fixture(context); const again = await handOff(f); let edits = 0; let reviews = 0;
  const result = await execute(input(again, {}, { resume: true }), {
    investigator: () => assert.fail(),
    implementer: request => { edits++; assert.ok(request.prompt.includes("Current failure/feedback: Explain the greeting")); writeFileSync(join(request.cwd, "greeting.txt"), "hello again\n"); return ok(); },
    reviewer: () => ++reviews === 1 ? ok("revise", "Explain the greeting") : ok("approved"),
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [1, 2]); untouched(f);
  assert.deepEqual(result.states.slice(0, 8), ["prepare", "verify", "sealReview", "review", "reviewResult", "repairBudget", "change", "verify"]);
  assert.equal(evidence(again).result.repairs, 1); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello again");
});

const linked = (f: Fixture) => git(f.repo, "worktree", "add", "-q", "-b", branch, f.worktree);
for (const [label, arrange, reason] of [
  ["a missing worktree", () => {}, /worktree directory .+ does not exist; nothing was changed/u],
  ["a directory that is not a Git worktree", (f: Fixture) => { mkdirSync(f.worktree, { recursive: true }); writeFileSync(join(f.worktree, "greeting.txt"), "hello\n"); }, /is not a Git worktree of .+; nothing was changed/u],
  ["a checkout of another repository", (f: Fixture) => { mkdirSync(f.worktree, { recursive: true }); git(f.worktree, "init", "-q", "-b", branch); }, /is not a Git worktree of .+; nothing was changed/u],
  ["a worktree whose HEAD left the ticket branch", (f: Fixture) => { linked(f); git(f.worktree, "checkout", "-q", "--detach"); }, /HEAD in .+ is not the branch ticket\/proj-12; nothing was changed/u],
  ["a worktree on another branch", (f: Fixture) => { git(f.repo, "branch", branch); git(f.repo, "worktree", "add", "-q", "-b", "other", f.worktree); }, /HEAD in .+ is not the branch ticket\/proj-12; nothing was changed/u],
  ["a ticket branch that already holds a commit", (f: Fixture) => { linked(f); implement({ cwd: f.worktree }); git(f.worktree, "add", "."); git(f.worktree, "commit", "-qm", "earlier commit"); }, /does not point at the base commit .+; nothing was changed/u],
  ["a base that moved since the worktree was made", (f: Fixture) => { linked(f); git(f.repo, "commit", "-q", "--allow-empty", "-m", "later"); f.head = git(f.repo, "rev-parse", "HEAD"); }, /does not point at the base commit .+; nothing was changed/u],
] as const) {
  test(`resume with ${label} blocks without changing anything`, async context => {
    const f = fixture(context); arrange(f);
    const snapshot = () => [git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), git(f.repo, "worktree", "list", "--porcelain"),
      existsSync(f.worktree) ? readdirSync(f.worktree) : null, existsSync(join(f.worktree, "greeting.txt")) ? readFileSync(join(f.worktree, "greeting.txt"), "utf8") : null];
    const before = snapshot();
    const result = await execute(input(f, { setup: [command("process.exit(1)")] }, { resume: true }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["prepare", "failure", "blocked"]); untouched(f);
    const run = held(f, result, reason);
    assert.match(result.output.summary, /^Blocked: Cannot resume: /u); assert.doesNotMatch(result.output.summary, /Worktree kept/u);
    assert.deepEqual([run.delivery.outcome, run.delivery.resumed, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.result.checks.length], ["blocked", undefined, false, false, null, 0]);
    assert.deepEqual(snapshot(), before);
  });
}

test("an Agent that commits by itself is not delivered", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  const result = await execute(input(f, { output: "pr" }), {
    implementer: request => { implement(request); git(request.cwd, "add", "."); git(request.cwd, "commit", "-qm", "agent commit"); return ok(); },
  });
  const run = blocked(f, result, /only this workflow commits/u, 1);
  assert.equal(git(f.repo, "log", "-1", "--format=%s", branch), "agent commit");
  assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(run.delivery.commit, null);
});

test("an approved candidate with no change is not committed", async context => {
  const f = fixture(context);
  blocked(f, await execute(input(f), { implementer: () => ok() }), /Nothing to commit/u);
});

test("nested run evidence is never committed, and a worktree that cannot be removed is not reported as delivered", async context => {
  const f = fixture(context);
  const result = await execute(input(f, { output: "patch" }), {
    implementer: request => { mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/nested.json"), "{}"); return implement(request); },
  });
  const run = blocked(f, result, /worktree could not be removed after delivering .+; inspect .+git-worktree\.log/u, 1);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.txt");
  assert.equal(run.delivery.commit, git(f.repo, "rev-parse", branch)); assert.ok(result.output.summary.includes(run.delivery.patches[0]));
  assert.ok(existsSync(join(f.worktree, ".machine-runs/nested.json"))); assert.ok(existsSync(join(run.directory, "git-worktree.log")));
});

test("run evidence an Agent staged by force is left out of the commit", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, ".gitignore"), ".machine-runs/\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "ignore runs"); f.head = git(f.repo, "rev-parse", "HEAD");
  const result = await execute(input(f), {
    implementer: request => {
      mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/nested.json"), "{}");
      git(request.cwd, "add", "--force", ".machine-runs"); return implement(request);
    },
  });
  assert.equal(result.state, "delivered"); untouched(f);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.txt"); assert.equal(evidence(f).delivery.worktreeRemoved, true);
});

for (const [hook, script] of [
  ["pre-commit", "echo hooked >> greeting.txt && git add greeting.txt"],
  ["commit-msg", 'echo rewritten > "$1"'],
  ["post-commit", "echo hooked >> greeting.txt"],
  ["commit-msg", 'sed -i "s/^Ticket: PROJ-12$/Ticket: PROJ-123/" "$1"'],
] as const) {
  test(`a ${hook} hook that alters the approved candidate blocks before delivery`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
    mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks", hook), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const run = blocked(f, await execute(input(f, { output: "pr" })), /commit hook or Git configuration changed the approved candidate/u, 1);
    assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(run.delivery.commit, null);
  });
}

test("a commit hook that leaves the candidate and its message intact does not prevent delivery", async context => {
  const f = fixture(context);
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/commit-msg"), '#!/bin/sh\nprintf "\\nReviewed-by: hook\\n" >> "$1"\n', { mode: 0o755 });
  const result = await execute(input(f));
  assert.equal(result.state, "delivered"); assert.match(git(f.repo, "log", "-1", "--format=%B", branch), /^Add a greeting\n\nTicket: PROJ-12\n\nReviewed-by: hook$/u);
});

test("a hook that moves the ticket branch off the approved commit blocks before anything is pushed", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true });
  writeFileSync(join(f.repo, ".git/hooks/post-commit"), `#!/bin/sh\ngit checkout -q --detach && git branch -f ${branch} ${f.head}\n`, { mode: 0o755 });
  const run = blocked(f, await execute(input(f, { output: "pr" })), /moved HEAD or ticket\/proj-12 away from the approved commit/u);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(run.delivery.commit, null);
});

test("the pull request is opened in the pushed repository whatever GH_REPO says, with a message-only review in its body", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  const bin = join(f.root, "bin");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\nprintf '%s' "$GH_REPO" > "${bin}/gh-repo"\necho ${url}\n`, { mode: 0o755 });
  process.env.GH_REPO = "someone/else"; context.after(() => { delete process.env.GH_REPO; });
  const result = await execute(input(f, { output: "pr" }), { reviewer: () => ({ type: "approved", message: "Prose-only approval" }) });
  assert.equal(result.state, "delivered");
  assert.deepEqual(gh()!.slice(2, 4), ["--repo", slug]); assert.equal(readFileSync(join(bin, "gh-repo"), "utf8"), "");
  const body = readFileSync(join(evidence(f).directory, "pull-request.md"), "utf8");
  assert.match(body, /Prose-only approval/u); assert.doesNotMatch(body, /undefined/u);
});

test("a remote that names no hosted repository blocks pr delivery before pushing", async context => {
  const f = fixture(context); const gh = fakeGh(context, f);
  const bare = join(f.root, "remote.git"); git(f.root, "init", "-q", "--bare", bare); git(f.repo, "remote", "add", "origin", bare);
  blocked(f, await execute(input(f, { output: "pr" })), /does not name a hosted owner\/repository/u, 1);
  assert.equal(git(bare, "for-each-ref"), ""); assert.equal(gh(), undefined);
});

test("remote URLs resolve to the hosted repository gh must use, and local paths do not", () => {
  for (const remoteUrl of [
    "https://github.com/acme/widgets.git", "https://github.com/acme/widgets", "https://user@github.com/acme/widgets/",
    "git@github.com:acme/widgets.git", "github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets.git",
    "ssh://git@github.com:22/acme/widgets.git",
  ]) assert.equal(mod.hostedRepository(remoteUrl), "github.com/acme/widgets", remoteUrl);
  for (const remoteUrl of ["", "/srv/git/widgets.git", "../widgets", "file:///srv/widgets.git", "https://github.com/acme", "https://github.com/acme/group/widgets", "git@github.com:/acme/widgets"]) {
    assert.equal(mod.hostedRepository(remoteUrl), undefined, remoteUrl);
  }
});

test("a separate pushurl cannot send the commit to a different repository than the pull request", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f);
  const other = join(f.root, "other.git"); git(f.root, "init", "-q", "--bare", other); git(f.repo, "config", "remote.origin.pushurl", other);
  const result = await execute(input(f, { output: "pr" }));
  assert.equal(result.state, "delivered");
  assert.equal(pushed(), `refs/heads/${branch} ${git(f.repo, "rev-parse", branch)}`); assert.equal(git(other, "for-each-ref"), "");
});

test("pr delivery pushes no tag even when Git is configured to follow tags", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f);
  git(f.repo, "config", "push.followTags", "true"); git(f.repo, "tag", "-am", "release", "v1");
  const result = await execute(input(f, { output: "pr" }));
  assert.equal(result.state, "delivered"); assert.equal(pushed(), `refs/heads/${branch} ${git(f.repo, "rev-parse", branch)}`);
});

test("a failing push blocks, keeps the committed local branch, and never starts gh", async context => {
  const f = fixture(context); const gh = fakeGh(context, f);
  const result = await execute(input(f, { output: "pr" }));
  const run = blocked(f, result, /git push failed; inspect .+git-push\.log/u, 1);
  assert.equal(run.delivery.commit, git(f.repo, "rev-parse", branch)); assert.equal(run.delivery.prUrl, undefined);
  assert.match(readFileSync(join(run.directory, "git-push.log"), "utf8"), /origin/u); assert.equal(gh(), undefined);
});

test("a failing gh blocks after the push and keeps the local branch", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 1);
  const result = await execute(input(f, { output: "pr" }));
  const run = blocked(f, result, /gh pr failed; inspect .+gh-pr\.log/u, 1);
  assert.equal(pushed(), `refs/heads/${branch} ${run.delivery.commit}`); assert.equal(run.delivery.prUrl, undefined);
  assert.ok(gh()!.includes("--draft")); assert.doesNotMatch(result.output.summary, /example\.invalid/u);
});

test("a worktree or evidence root that reaches the repository through a symlink fails the run before any effect", async context => {
  const f = fixture(context); symlinkSync(f.repo, join(f.root, "link"));
  await assert.rejects(execute(input(f, {}, { worktreeRoot: join(f.root, "link/worktrees") })), /outside repository\.path/u);
  await assert.rejects(execute(input(f, {}, { evidenceRoot: join(f.root, "link") })), /outside repository\.path/u);
  assert.deepEqual(readdirSync(f.root).sort(), ["link", "widgets"]); untouched(f);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
});

test("a path that is not a checkout root fails the run before any evidence or worktree", async context => {
  const f = fixture(context); mkdirSync(join(f.repo, "sub"));
  await assert.rejects(execute(input(f, { path: join(f.repo, "sub") })), /Git checkout root/u);
  assert.deepEqual(readdirSync(f.root), ["widgets"]);
});

for (const [label, change] of [
  ["unknown input field", (data: any) => { data.autoMerge = true; }],
  ["unknown repository field", (data: any) => { data.repository.force = true; }],
  ["unknown check field", (data: any) => { data.repository.checks[0].shell = true; }],
  ["unknown setup field", (data: any) => { data.repository.setup = [command("", { cwd: "/" })]; }],
  ["relative repository path", (data: any) => { data.repository.path = "widgets"; }],
  ["relative worktree root", (data: any) => { data.worktreeRoot = "worktrees"; }],
  ["relative evidence root", (data: any) => { data.evidenceRoot = "."; }],
  ["worktree root inside the repository", (data: any) => { data.worktreeRoot = join(data.repository.path, "worktrees"); }],
  ["evidence root inside the repository", (data: any) => { data.evidenceRoot = data.repository.path; }],
  ["evidence root inside the worktree", (data: any) => { data.evidenceRoot = join(data.worktreeRoot, "widgets--proj-12", "runs"); }],
  ["evidence directory containing the repository", (data: any) => { data.evidenceRoot = join(data.repository.path, "../.."); data.repository.path = join(data.evidenceRoot, ".machine-runs"); }],
  ["output mode", (data: any) => { data.repository.output = "merge"; }],
  ["missing output mode", (data: any) => { delete data.repository.output; }],
  ["empty checks", (data: any) => { data.repository.checks = []; }],
  ["shell string setup", (data: any) => { data.repository.setup = [{ name: "install", command: "npm ci" }]; }],
  ["slug without letters or digits", (data: any) => { data.ticket.id = "#/#"; }],
  ["slug Git cannot use", (data: any) => { data.ticket.id = "v1.."; }],
  ["empty ticket id", (data: any) => { data.ticket.id = " "; }],
  ["empty title", (data: any) => { data.ticket.title = ""; }],
  ["non-string body", (data: any) => { data.ticket.body = 7; }],
  ["repository name with a separator", (data: any) => { data.repository.name = "../widgets"; }],
  ["option-like remote", (data: any) => { data.repository.remote = "--mirror"; }],
  ["non-boolean draft", (data: any) => { data.repository.draft = "no"; }],
  ["unbounded retries", (data: any) => { data.maxRepairs = 4; }],
  ["non-boolean resume", (data: any) => { data.resume = "yes"; }],
] as const) {
  test(`invalid ${label} is rejected before execution`, context => {
    const f = fixture(context); const data = input(f); change(data);
    assert.throws(() => mod.default(runtime, data));
    assert.deepEqual(readdirSync(f.root), ["widgets"]);
  });
}

test("the slug replaces characters outside its alphabet and names the branch and worktree", async context => {
  const f = fixture(context);
  const result = await execute({ ...input(f), ticket: { id: "Bug #7/a", title: "  Tidy\n the  greeting " } });
  assert.equal(result.state, "delivered");
  assert.deepEqual([evidence(f).delivery.branch, evidence(f).delivery.worktree], ["ticket/bug--7-a", join(f.root, "worktrees", "widgets--bug--7-a")]);
  assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", "ticket/bug--7-a"), "Tidy the greeting\nTicket: Bug #7/a");
});
