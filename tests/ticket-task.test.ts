import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { runtime } from "./runtime.ts";

const mod = await import(pathToFileURL(resolve("ticket-task.ts")).href);
const branch = "ticket/proj-12-add-a-greeting";
const archiveBranch = "archive/proj-12-add-a-greeting";
const url = "https://example.invalid/acme/widgets/pull/7";
const hosted = "https://example.invalid/acme/widgets";
const slug = "example.invalid/acme/widgets";
const ok = (type = "completed", summary = "Evidence from the bounded fake runner") => ({ type, summary });
const criterion = "greeting.txt contains hello";
const review = (type = "approved", summary = "Greeting matches the ticket", extra = {}) => ({
  type, summary, criteria: [{ text: criterion, met: true, evidence: "greeting.txt:1" }],
  findings: type === "revise" ? [{ severity: "blocker", text: summary, where: "greeting.txt:1" }] : [],
  newSinceLastRound: "Updated findings", ...extra,
});
const command = (code = 'if (require("fs").existsSync("greeting.test.txt")) eval(require("fs").readFileSync("greeting.test.txt", "utf8")); console.log("check passed")', extra = {}) => ({ name: "tests", command: [process.execPath, "-e", code], ...extra });
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
  ticket: { id: "PROJ-12", title: "Add a greeting", body: "## Goal\nWrite hello to greeting.txt.\n\n## Scope\n- greeting.txt\n- greeting.test.txt\n\n## Acceptance\n- greeting.txt contains hello\n\n## Forbidden\n- nothing beyond the scope above", source: "tk", metadata: { priority: 2 } },
  repository: { name: "widgets", path: f.repo, checks: [command()], output: "branch", ...repository },
  worktreeRoot: join(f.root, "worktrees"), evidenceRoot: f.evidence, stuck: "ask", ...extra,
});
function scoped(data: ReturnType<typeof input>, ...paths: string[]) {
  data.ticket.body = data.ticket.body.replace("## Scope\n", `## Scope\n${paths.map(path => `- ${path}\n`).join("")}`);
  return data;
}
/** A local bare repository stands in for the remote; nothing leaves the machine. */
function remote(f: Fixture) {
  const bare = join(f.root, "remote.git");
  git(f.root, "init", "-q", "--bare", "-b", "main", bare);
  // The remote names a hosted repository, as gh needs; Git itself is redirected to the local bare one.
  git(f.repo, "remote", "add", "origin", `${hosted}.git`); git(f.repo, "config", `url.${bare}.insteadOf`, `${hosted}.git`);
  // The base is published, as a pull request needs; what a run pushed is whatever the remote holds beyond that.
  git(f.repo, "push", "-q", "origin", "main");
  const refs = () => git(bare, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(Boolean);
  const published = refs();
  return () => refs().filter(ref => !published.includes(ref)).join("\n");
}
/** A recording git placed first on PATH that passes every call on to the real one. */
function recordGit(context: TestContext, f: Fixture) {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(f.root, "git-bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${bin}/calls"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  context.after(() => { process.env.PATH = path; });
  return () => readFileSync(join(bin, "calls"), "utf8").trimEnd().split("\n");
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
const tester = (request: { cwd: string }) => {
  writeFileSync(join(request.cwd, "greeting.test.txt"), 'require("node:assert/strict").ok(require("node:fs").existsSync("greeting.txt"));\n');
  return ok("completed", "greeting.test.txt requires the implementation file");
};
const implement = (request: { cwd: string }) => { writeFileSync(join(request.cwd, "greeting.txt"), "hello\n"); return ok(); };
type Ask = { prompt: string; choices?: readonly string[] };
type Request = { prompt: string; cwd: string; outcomes: readonly string[] };
type Runner = (request: Request) => unknown;
// Quotes, a backslash, and line breaks show whether a prompt carries the plan as it was written or as JSON.
const plan = 'Write "hello" to greeting.txt:\n1. Cover it in greeting.test.txt with a path\\name check.\n2. Add greeting.txt.';
/** The read-only states ahead of the work, the role each uses, and what its Agent answers unless a test replaces it by the state's name. */
const planning: Record<string, { role: string; answer: Runner }> = {
  falsify: { role: "investigator", answer: () => ok("sound", "The ticket names its file and what the file must contain") },
  plan: { role: "investigator", answer: () => ok("planned", plan) },
  planReview: { role: "reviewer", answer: () => ok("approved", "The plan covers the criterion") },
};
const isPlanning = (state: string) => Object.hasOwn(planning, state);
/** The read-only states a run has gone through once it reaches this one. */
const upTo = (state: string) => Object.keys(planning).slice(0, Object.keys(planning).indexOf(state) + 1);
/** The plan a prompt carries: what follows its own `Plan:` heading line. */
const planIn = (prompt: string) => prompt.split(/^Plan:\n+/mu)[1] ?? "";
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
/**
 * Agents are given by role, where `reviewer` is the review of the implementation, or by state name for falsify, plan, and planReview;
 * `investigator` stands for both of that role's states, which is how a test says that neither may run.
 */
async function execute(assignment: unknown, agents: Record<string, Runner> = {}, human: (request: Ask) => string = person()) {
  const states: string[] = [];
  const working: Record<string, Runner> = {
    tester, implementer: implement, reviewer: () => review("approved", "Greeting matches the ticket"),
    investigator: () => assert.fail(`the investigator has no work in ${states.at(-1)}`), ...agents,
  };
  // The runtime starts a runner before it reports the state that asked, so each waits a turn to learn which one it serves.
  const staged = (role: string) => async (request: Request) => {
    await Promise.resolve();
    const state = states.at(-1)!;
    if (!isPlanning(state)) return working[role]!(request);
    const stage = planning[state]!;
    assert.equal(role, stage.role, `${state} uses the ${stage.role} role`);
    return (agents[state] ?? (role === "investigator" ? agents.investigator : undefined) ?? stage.answer)(request);
  };
  const result = await runtime.run(mod.default(runtime, assignment), {
    agents: Object.fromEntries(["tester", "investigator", "implementer", "reviewer"].map(role => [role, staged(role)])),
    human, onState: state => states.push(String(state)),
  });
  return { state: result.value, output: result.output as any, states };
}
function evidence(f: Fixture) {
  const runs = join(f.evidence, ".machine-runs/machine-shop");
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
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.delivery.archive], [true, false, null, undefined]);
  return run;
}
/** The park note's fixed next step. */
const nextStep = "Add the answer to the ticket body, then run the ticket again with resume: true; the run continues from the kept worktree with fresh budgets.";
/** Parking never asks a Human or changes the candidate; its note and hold share the same brief. */
function parked(f: Fixture, result: { state: unknown; output: any; states: string[] }, reason: RegExp, human: { requests: Ask[] }) {
  assert.equal(result.state, "parked"); assert.deepEqual(result.states.slice(-3), ["stuck", "park", "parked"]);
  assert.equal(result.states.includes("decide"), false); assert.deepEqual(human.requests, []);
  const run = held(f, result, new RegExp(`^Parked on ${branch}: `, "u")); untouched(f);
  assert.equal(run.result.outcome, "blocked"); assert.equal(run.delivery.outcome, "parked");
  assert.match(run.delivery.reason, reason); assert.match(run.delivery.park.needs, reason);
  assert.equal(run.delivery.park.next, nextStep);
  assert.deepEqual(run.result.decisions, []); assert.equal(run.delivery.decision, undefined);
  assert.equal(git(f.repo, "rev-parse", branch), f.head); assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.delivery.archive], [true, false, null, undefined]);
  assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
  assert.ok(result.output.summary.includes(`Worktree kept at ${f.worktree}. Evidence: `));
  const note = readFileSync(join(run.directory, "park.txt"), "utf8");
  // What is needed can be several lines, as a falsified ticket's questions are; the hold stays one line and still carries each of them.
  const needs: string[] = run.delivery.park.needs.split("\n");
  assert.ok(result.output.summary.startsWith(`Parked on ${branch}: ${note.split("\n")[0]} Needs: ${needs[0]}`));
  for (const need of needs) assert.ok(result.output.summary.includes(need), need);
  assert.ok(note.includes(`Needs: ${run.delivery.park.needs}\n`)); assert.ok(note.includes(run.delivery.park.next));
  assert.ok(note.includes(`Worktree: ${f.worktree}\nBranch: ${branch}\nEvidence: ${run.directory}`));
  assert.ok(note.includes(`Stopped in ${result.states.at(-4)}.`));
  return run;
}

/** An abandoned run leaves neither its worktree nor its branch, and the source checkout as it was; an archive leaves its own branch beside it. */
function abandoned(f: Fixture, result: { state: unknown; output: any; states: string[] }, decision: string) {
  assert.equal(result.state, "abandoned"); assert.deepEqual(result.states.slice(-3), ["remove", "abandon", "abandoned"]);
  const run = held(f, result, /^Abandoned: /u); untouched(f);
  assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), decision === "archive" ? `${archiveBranch}\nmain` : "main");
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision], ["blocked", "abandoned", decision]);
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit], [true, true, null]);
  assert.ok(result.output.summary.includes(`Decision: ${decision}.`)); assert.doesNotMatch(result.output.summary, /Worktree kept/u);
  return run;
}

test("construction has no effects and declares exactly the four roles", context => {
  const f = fixture(context);
  assert.match(mod.description, /\S/u); assert.doesNotMatch(mod.description, /\n/u);
  for (const data of [input(f, { output: "pr", setup: [command()] }), JSON.stringify(input(f))]) {
    assert.deepEqual(runtime.requiredAgentNames(mod.default(runtime, data)), ["implementer", "investigator", "reviewer", "tester"]);
  }
  assert.deepEqual(Object.keys(mod.agentRoles).sort(), ["implementer", "investigator", "reviewer", "tester"]);
  const states = Object.keys(mod.default(runtime, input(f)).states);
  for (const state of ["falsify", "plan", "planReview"]) assert.ok(states.includes(state), state);
  for (const state of ["triage", "triageResult"]) assert.equal(states.includes(state), false, state);
  assert.deepEqual(readdirSync(f.root), ["widgets"]);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main"); untouched(f);
});

test("ticketSections parses headings case-insensitively and in any order", () => {
  assert.deepEqual(mod.ticketSections("# Title\r\n## fOrBiDdEn\r\n- No dependencies\r\n## ACCEPTANCE\r\n* First criterion\r\n+ Second criterion\r\n## scope\r\n- src/**\r\n## GOAL\r\nA goal.\r\nMore detail."), {
    goal: "A goal.\nMore detail.", scope: ["src/**"], acceptance: ["First criterion", "Second criterion"], forbidden: ["No dependencies"], missing: [],
  });
  assert.deepEqual(mod.ticketSections("").missing, ["Goal", "Scope", "Acceptance", "Forbidden"]);
  assert.deepEqual(mod.ticketSections("## Goal\n## Scope\n-  \n## Acceptance\nprose\n## Forbidden\n").missing, ["Scope", "Acceptance", "Forbidden"]);
  assert.deepEqual(mod.ticketSections("```md\n## Goal\n## Scope\n- path\n## Acceptance\n- test\n## Forbidden\n- none\n```\n").missing, ["Goal", "Scope", "Acceptance", "Forbidden"]);
});

test("ticketSections joins hard-wrapped bullet continuations with single spaces", () => {
  assert.deepEqual(mod.ticketSections("## Acceptance\n- Handles empty\n  and   missing input\n  without crashing.\n- Preserves output").acceptance,
    ["Handles empty and missing input without crashing.", "Preserves output"]);
});

test("ticketSections includes nested bullets in their parent criterion", () => {
  assert.deepEqual(mod.ticketSections("## Acceptance\n  - Handles input\n    - Empty values\n      + Missing values\n    * Invalid values\n  - Preserves output").acceptance,
    ["Handles input Empty values Missing values Invalid values", "Preserves output"]);
});

test("ticketSections does not count thematic breaks as bullets", () => {
  for (const divider of ["* * *", "---", "- - -", "***", "___"]) {
    const sections = mod.ticketSections(`## Scope\n${divider}\n## Acceptance\n- First\n  ${divider}\n- Second`);
    assert.deepEqual(sections.scope, []); assert.ok(sections.missing.includes("Scope"));
    assert.deepEqual(sections.acceptance, ["First", "Second"]);
  }
});

test("ticketSections keeps subheadings as section text without creating sections or bullets", () => {
  const sections = mod.ticketSections("## Goal\nA goal\n### Scope\nStill the goal\n## Acceptance\n- First\n### Forbidden\n- Second");
  assert.equal(sections.goal, "A goal\n### Scope\nStill the goal");
  assert.deepEqual(sections.acceptance, ["First", "Second"]);
  assert.deepEqual(sections.missing, ["Scope", "Forbidden"]);
  assert.deepEqual(mod.ticketSections("## Acceptance\n### A subheading").acceptance, []);
});

for (const [section, remove] of [["Acceptance", /## Acceptance\n- [^\n]+/u], ["Scope", /- greeting\.txt\n- greeting\.test\.txt\n/u]] as const) {
  for (const resume of [false, true]) {
    test(`a ${resume ? "resumed" : "new"} ticket with missing or empty ${section} blocks before any Agent or worktree`, async context => {
      const f = fixture(context); const data = input(f, {}, { resume }); data.ticket.body = data.ticket.body.replace(remove, "");
      const result = await execute(data, { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
      assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["shape", "failure", "blocked"]);
      const run = held(f, result, new RegExp(`^Blocked: Ticket body is missing required sections or non-empty lists: ${section}\\. Expected shape:`, "u")); untouched(f);
      assert.equal(run.delivery.reason.split(" Expected shape:")[0], `Ticket body is missing required sections or non-empty lists: ${section}.`);
      assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.result.agentInvocations], [false, false, 0]);
      assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
      for (const heading of ["Goal", "Scope", "Acceptance", "Forbidden"]) assert.ok(run.delivery.reason.includes(`## ${heading}`));
    });
  }
}

test("an approved report with unmet criteria repairs and persists the structured review", async context => {
  const f = fixture(context); const data = input(f);
  data.ticket.body = data.ticket.body.replace(`- ${criterion}`, `- ${criterion}\n- greeting ends with a newline`);
  let edits = 0; let reviews = 0;
  const first = review("approved", "Claims approval", {
    criteria: [{ text: "Reviewer reworded the first criterion", met: false, evidence: "greeting.txt:1" }, { text: "Reviewer reworded the second criterion", met: false, evidence: "greeting.txt:2" }],
  });
  const result = await execute(data, {
    implementer: request => {
      assert.ok(request.prompt.includes(`Acceptance criteria:\n- ${criterion}\n- greeting ends with a newline`));
      assert.ok(request.prompt.includes("Forbidden:\n- nothing beyond the scope above"));
      if (++edits === 2) {
        assert.equal(request.prompt.split("Current failure/feedback: ")[1], `Claims approval\nUnmet criterion: ${criterion} (greeting.txt:1)\nUnmet criterion: greeting ends with a newline (greeting.txt:2)`);
      }
      return implement(request);
    },
    reviewer: request => {
      assert.ok(request.prompt.includes(`Acceptance criteria:\n1. ${criterion}\n2. greeting ends with a newline`));
      assert.match(request.prompt, /MACHINES_EVENT .*"criteria".*"findings".*"newSinceLastRound"/u);
      if (++reviews === 1) return first;
      assert.match(request.prompt, /review-<n>\.json/u);
      return review("approved", "All criteria met", { criteria: first.criteria.map(item => ({ ...item, met: true })), newSinceLastRound: "none" });
    },
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [2, 2]);
  const run = held(f, result, /^Delivered/u);
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "review-1.json"), "utf8")), first);
  assert.equal(run.result.checks.length, 3);
});

for (const output of ["branch", "patch", "pr"]) {
  test(`minor-only revise delivers ${output} without repair and retains review notes`, async context => {
    const f = fixture(context); remote(f); const gh = fakeGh(context, f); let edits = 0;
    const notes = [{ text: "Consider a clearer filename", where: "greeting.txt:1" }];
    const result = await execute(input(f, { output }), {
      implementer: request => { edits++; return implement(request); },
      reviewer: () => review("revise", "The greeting satisfies the ticket", { findings: notes.map(note => ({ severity: "minor", ...note })) }),
    });
    assert.equal(result.state, "delivered"); assert.equal(edits, 1); assert.equal(result.states.includes("repairBudget"), false);
    const run = held(f, result, /^Delivered/u); assert.deepEqual(run.delivery.reviewNotes, notes);
    if (output === "pr") {
      const args = gh()!; const path = args[args.indexOf("--body-file") + 1]!;
      assert.equal(path, join(run.directory, "pull-request.md"));
      assert.match(readFileSync(path, "utf8"), /## Review\n\nThe greeting satisfies the ticket\n\n## Review notes\n\n- Consider a clearer filename \(greeting\.txt:1\)/u);
    }
  });
}

test("unchanged blocker texts with nothing new stop a repair as not converging", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const findings = [{ severity: "blocker", text: "Handle empty input", where: "greeting.txt:1" }, { severity: "blocker", text: "Handle missing input", where: "greeting.txt:2" }];
  const result = await execute(input(f), {
    implementer: request => {
      if (++edits === 2) for (const finding of findings) assert.ok(request.prompt.includes(`Blocker: ${finding.text} (${finding.where})`));
      return implement(request);
    },
    reviewer: () => review("approved", "Claims approval", { findings: ++reviews === 1 ? findings : [...findings].reverse(), newSinceLastRound: reviews === 1 ? "Initial findings" : "none" }),
  }, human);
  const run = handedOff(f, result, /not converging/u, human); assert.deepEqual([edits, reviews], [2, 2]);
  for (const finding of findings) {
    assert.ok(run.delivery.reason.includes(`${finding.text} (${finding.where})`));
    assert.ok(human.requests[0]!.prompt.includes(`${finding.text} (${finding.where})`));
  }
});

test("a discussion repeated in the next review asks the owner to settle the question", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const result = await execute(input(f), {
    implementer: request => { if (++edits === 2) assert.match(request.prompt, /Discussion: Should the greeting be localized\?/u); return implement(request); },
    reviewer: () => review("approved", "Owner question", {
      findings: [{ severity: "discussion", text: ++reviews === 1 ? "Should the greeting be localized?" : "  SHOULD THE GREETING BE LOCALIZED?  ", where: "greeting.txt:1" }], newSinceLastRound: "none",
    }),
  }, human);
  handedOff(f, result, /must settle repeated discussion: "SHOULD THE GREETING BE LOCALIZED\?"/u, human);
  assert.deepEqual([edits, reviews], [2, 2]);
});

for (const cause of ["not converging", "repeated discussion", "malformed report"]) {
  test(`more rounds restores the last review findings after ${cause}`, async context => {
    const f = fixture(context); const human = person("more rounds"); let edits = 0; let reviews = 0;
    const rounds = cause === "malformed report" ? 1 : 2;
    const discussion = { severity: "discussion", text: "Which locale?", where: "greeting.txt:3" };
    const needsRepair = cause !== "repeated discussion";
    const findings = needsRepair ? [{ severity: "blocker", text: "Handle empty input", where: "greeting.txt:2" }, discussion] : [discussion];
    const feedback = [
      "Latest review",
      ...(needsRepair ? [`Unmet criterion: ${criterion} (greeting.txt:1)`, "Blocker: Handle empty input (greeting.txt:2)"] : []),
      "Discussion: Which locale? (greeting.txt:3)",
    ].join("\n");
    const result = await execute(input(f), {
      implementer: request => {
        if (++edits === rounds + 1) assert.equal(request.prompt.split("Current failure/feedback: ")[1], feedback);
        return implement(request);
      },
      reviewer: () => ++reviews > rounds ? review() : review("approved", "Latest review", {
        criteria: [{ text: "Reviewer paraphrase", met: !needsRepair, evidence: "greeting.txt:1" }], findings,
        newSinceLastRound: cause === "malformed report" ? undefined : "none",
      }),
    }, human);
    assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews, human.requests.length], [rounds + 1, rounds + 1, 1]);
    assert.match(human.requests[0]!.prompt, /send the standing findings back to the implementer/u);
    assert.match(human.requests[0]!.prompt, cause === "malformed report" ? /Malformed review report: newSinceLastRound/u : new RegExp(cause, "u"));
    held(f, result, /^Delivered/u);
  });
}

for (const change of ["different blocker", "new findings"]) {
  test(`rule 4 repairs with ${change} despite another unchanged review field`, async context => {
    const f = fixture(context); let edits = 0; let reviews = 0;
    const result = await execute(input(f), {
      implementer: request => { edits++; return implement(request); },
      reviewer: () => {
        if (++reviews === 3) return review();
        return review("approved", "Needs work", {
          findings: [{ severity: "blocker", text: reviews === 2 && change === "different blocker" ? "Handle missing input" : "Handle empty input", where: "greeting.txt:1" }],
          newSinceLastRound: reviews === 2 && change === "new findings" ? "The empty input path now returns a value" : "none",
        });
      },
    });
    assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [3, 3]);
    assert.equal(result.states.filter(state => state === "reviewBudget").length, 2); assert.equal(result.states.includes("decide"), false);
  });
}

for (const newSinceLastRound of ["", "   ", " NoNe ", " NONE. "]) {
  test(`rule 4 treats ${JSON.stringify(newSinceLastRound)} as nothing new`, async context => {
    const f = fixture(context); const human = person("hand off"); let reviews = 0;
    const result = await execute(input(f), {
      reviewer: () => review("revise", "Handle empty input", { newSinceLastRound: ++reviews === 1 ? "Initial findings" : newSinceLastRound }),
    }, human);
    handedOff(f, result, /not converging: .*Handle empty input \(greeting.txt:1\)/u, human); assert.equal(reviews, 2);
  });
}

test("unmet criteria alone stop with a reason naming the ticket criteria", async context => {
  const f = fixture(context); const human = person("hand off"); let reviews = 0;
  const result = await execute(input(f), {
    reviewer: () => { reviews++; return review("approved", "Still unmet", {
      criteria: [{ text: "Reviewer paraphrase", met: false, evidence: "greeting.txt:1" }], newSinceLastRound: "none",
    }); },
  }, human);
  const run = handedOff(f, result, /not converging/u, human);
  assert.equal(reviews, 2);
  assert.equal(run.delivery.reason, `Review is not converging: newSinceLastRound is none and criteria remain unmet: ${criterion}`);
  assert.ok(human.requests[0]!.prompt.includes(run.delivery.reason));
});

for (const repair of ["blocker", "unmet criterion"]) {
  test(`a repeated discussion still repairs while a ${repair} is present`, async context => {
    const f = fixture(context); let edits = 0; let reviews = 0;
    const result = await execute(input(f), {
      implementer: request => { edits++; return implement(request); },
      reviewer: () => {
        if (++reviews === 3) return review();
        return review("approved", "Question plus repair", {
          criteria: [{ text: criterion, met: reviews === 1 || repair === "blocker", evidence: "greeting.txt:1" }],
          findings: [{ severity: "discussion", text: "Which locale?", where: "greeting.txt:1" },
            ...(reviews === 2 && repair === "blocker" ? [{ severity: "blocker", text: "Handle empty input", where: "greeting.txt:2" }] : [])],
        });
      },
    });
    assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [3, 3]);
    assert.equal(result.states.includes("decide"), false);
  });
}

test("a discussion absent from the next review gets a repair when it returns in round three", async context => {
  const f = fixture(context); let edits = 0; let reviews = 0;
  const result = await execute(input(f, {}, { maxReviewRounds: 3 }), {
    implementer: request => { edits++; return implement(request); },
    reviewer: () => {
      if (++reviews === 4) return review();
      return review("approved", "Needs another round", {
        findings: [reviews === 2 ? { severity: "blocker", text: "Handle empty input", where: "greeting.txt:2" }
          : { severity: "discussion", text: "Which locale?", where: "greeting.txt:1" }], newSinceLastRound: "none",
      });
    },
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [4, 4]);
  assert.equal(result.states.filter(state => state === "reviewBudget").length, 3); assert.equal(result.states.includes("decide"), false);
});

test("a reviewer blocked event needs only its summary and does not require a structured report", async context => {
  const f = fixture(context); const human = person("more rounds", "hand off"); let reviews = 0; let edits = 0;
  const result = await execute(input(f), {
    implementer: request => {
      if (++edits === 2) assert.equal(request.prompt.split("Current failure/feedback: ")[1], "Cannot inspect the generated output");
      return implement(request);
    },
    reviewer: () => ++reviews === 1 ? ok("blocked", "Cannot inspect the generated output") : review("revise", "Handle empty input", { newSinceLastRound: "none" }),
  }, human);
  assert.ok(human.requests[0]!.prompt.includes("This run is stuck and needs a decision: Cannot inspect the generated output\n\n"));
  assert.doesNotMatch(human.requests[0]!.prompt, /Malformed/u);
  handedOff(f, result, /not converging/u, human); assert.deepEqual([edits, reviews], [3, 3]);
});

test("minor notes deduplicate by trimmed case-insensitive text and location and render on one line", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f); let reviews = 0;
  const note = { text: "  Consider\na clearer name  ", where: " Greeting.txt:1 " };
  const elsewhere = { text: "Consider\na clearer name", where: "greeting.txt:2" };
  const noLocation = { text: "Explain\n  the choice", where: "  " };
  const result = await execute(input(f, { output: "pr" }), {
    reviewer: () => review("approved", "Review summary", {
      findings: ++reviews === 1 ? [{ severity: "blocker", text: "Handle empty input", where: "greeting.txt:1" }, { severity: "minor", ...note }]
        : [{ severity: "minor", text: "CONSIDER\nA CLEARER NAME", where: "greeting.TXT:1" }, { severity: "minor", ...elsewhere }, { severity: "minor", ...noLocation }],
    }),
  });
  assert.equal(result.state, "delivered"); assert.equal(reviews, 2);
  const run = held(f, result, /^Delivered/u);
  assert.deepEqual(run.delivery.reviewNotes, [note, elsewhere, noLocation]);
  const body = readFileSync(join(run.directory, "pull-request.md"), "utf8");
  assert.equal(body.split("## Review notes\n\n")[1], "- Consider a clearer name (Greeting.txt:1)\n- Consider a clearer name (greeting.txt:2)\n- Explain the choice\n\nTicket: PROJ-12\n");
});

test("resolved discussions approve and minor notes accumulate across review rounds", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f); let reviews = 0; let edits = 0;
  const notes = [{ text: "First minor", where: "greeting.txt:1" }, { text: "Second minor", where: "greeting.txt:2" }];
  const result = await execute(input(f, { output: "pr" }), {
    implementer: request => { edits++; return implement(request); },
    reviewer: () => review("revise", "Approving summary", {
      findings: ++reviews === 1 ? [{ severity: "discussion", text: "Is hello the intended greeting?", where: "greeting.txt:1" }, { severity: "minor", ...notes[0] }]
        : [{ severity: "minor", ...notes[1] }], newSinceLastRound: "none",
    }),
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [2, 2]);
  const run = held(f, result, /^Delivered/u); assert.deepEqual(run.delivery.reviewNotes, notes);
  const body = readFileSync(join(run.directory, "pull-request.md"), "utf8");
  for (const note of notes) assert.ok(body.includes(`- ${note.text} (${note.where})`));
});

for (const [field, extra] of [
  ["criteria", { criteria: undefined }], ["criteria", { criteria: {} }], ["criteria count", { criteria: [] }],
  ["criteria[0]", { criteria: [null] }], ["criteria[0].met", { criteria: [{ text: criterion, met: "false", evidence: "greeting.txt:1" }] }],
  ["criteria[0].text", { criteria: [{ text: "   ", met: true, evidence: "greeting.txt:1" }] }],
  ["criteria[0].evidence", { criteria: [{ text: criterion, met: true }] }],
  ["findings", { findings: undefined }], ["findings", { findings: {} }], ["findings[0]", { findings: [null] }],
  ["findings[0].severity", { findings: [{ severity: ["blocker"], text: "Bad", where: "greeting.txt:1" }] }],
  ["findings[0].text", { findings: [{ severity: "minor", text: 7, where: "greeting.txt:1" }] }],
  ["findings[0].where", { findings: [{ severity: "minor", text: "Bad" }] }],
  ["newSinceLastRound", { newSinceLastRound: undefined }], ["newSinceLastRound", { newSinceLastRound: false }],
] as const) {
  for (const verdict of ["approved", "revise"]) test(`a malformed ${verdict} review ${field} (${JSON.stringify(extra)}) reaches decide with the field named`, async context => {
    const f = fixture(context); const human = person("hand off");
    const result = await execute(input(f), { reviewer: () => review(verdict, "Reviewer verdict must not mask malformed fields", extra) }, human);
    const run = handedOff(f, result, /Malformed review report/u, human);
    assert.ok(run.delivery.reason.includes(field)); assert.ok(existsSync(join(run.directory, "review-1.json")));
  });
}

test("an approved report missing criteria is blocked while its minor notes are retained", async context => {
  const f = fixture(context); const human = person("hand off");
  const note = { text: "Consider a clearer filename", where: "greeting.txt:1" };
  const result = await execute(input(f), { reviewer: () => review("approved", "Claims approval", {
    criteria: undefined, findings: [{ severity: "minor", ...note }],
  }) }, human);
  const run = handedOff(f, result, /Malformed review report: criteria/u, human);
  assert.deepEqual(run.delivery.reviewNotes, [note]);
});

for (const output of ["branch", "patch", "pr"]) {
  test(`${output} delivery commits the reviewed candidate without touching the source checkout`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
    const result = await execute(input(f, { output }), {
      tester: request => {
        assert.equal(request.cwd, f.worktree);
        assert.ok(request.prompt.includes(`Acceptance criteria:\n- ${criterion}`));
        assert.ok(request.prompt.includes("Scope:\n- greeting.txt\n- greeting.test.txt"));
        assert.match(request.prompt, /Do not implement anything and do not change non-test files/u);
        assert.match(request.prompt, /one or more per criterion/u);
        assert.match(request.prompt, /Leave changes uncommitted/u);
        assert.ok(planIn(request.prompt).startsWith(`${plan}\n`));
        return tester(request);
      },
      falsify: request => { assert.equal(request.cwd, f.worktree); assert.match(request.prompt, /Ticket PROJ-12: Add a greeting\n\n## Goal\nWrite hello/u); return planning.falsify!.answer(request); },
      implementer: request => { assert.equal(request.cwd, f.worktree); assert.ok(planIn(request.prompt).startsWith(`${plan}\n`)); assert.match(request.prompt, /without weakening or deleting them/u); assert.match(request.prompt, /If a test is wrong, say so in the summary/u); assert.match(request.prompt, /uncommitted/u); return implement(request); },
      reviewer: request => { assert.equal(request.cwd, f.worktree); assert.match(request.prompt, /Do not edit/u); assert.match(request.prompt, /Machine saw them fail/u); return review("approved", "Greeting matches the ticket"); },
    });
    assert.equal(result.state, "delivered");
    assert.deepEqual(result.states.slice(0, 4), ["shape", "prepare", "start", "falsify"]);
    // The Operations that follow the three read-only states are the Machine's own; the ticket names only the Agent states and their order.
    assert.deepEqual(result.states.slice(0, result.states.indexOf("test")).filter(isPlanning), ["falsify", "plan", "planReview"]);
    assert.deepEqual(result.states.slice(result.states.indexOf("test")), ["test", "scopeAfterTest", "red", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
    const commit = git(f.repo, "rev-parse", branch);
    const run = held(f, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
    assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", branch), "Add a greeting\nTicket: PROJ-12");
    assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
    assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello");
    assert.ok(run.directory.startsWith(join(f.evidence, ".machine-runs")));
    assert.equal(existsSync(join(f.repo, ".machine-runs")), false);
    assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
    assert.doesNotMatch(result.output.summary, /Worktree kept/u);
    assert.deepEqual(run.delivery, {
      schemaVersion: 1, outcome: "delivered", ticket: "PROJ-12", repository: { name: "widgets", path: f.repo }, branch, baseCommit: f.head, commit, output,
      ...(output === "pr" ? { prUrl: url } : {}), ...(output === "patch" ? { patches: [join(run.directory, "0001-Add-a-greeting.patch")] } : {}),
      worktree: f.worktree, worktreeCreated: true, worktreeRemoved: true, reviewNotes: [],
    });
    assert.deepEqual([run.result.workflow, run.result.outcome, run.result.checksPassed, run.result.agentInvocations], ["ticket-task", "completed", true, 6]);
    assert.deepEqual(run.result.checks.map(check => [check.phase, check.expected, check.passed]), [["red", "nonzero exit", true], ["verify", "exit 0", true]]);
    assert.deepEqual(run.result.agents.map((agent: any) => agent.outcome), ["sound", "planned", "approved", "completed", "completed", "approved"]);
    assert.deepEqual(run.result.agents[1], { stage: "plan", outcome: "planned", summary: plan }); assert.equal(run.result.agents[3].stage, "test");
    assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-1.json"), "utf8")), { stage: "test", changed: ["greeting.test.txt"], outside: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-2.json"), "utf8")), { stage: "change", changed: ["greeting.test.txt", "greeting.txt"], outside: [] });
    assert.ok(run.result.checks.every(c => c.passed && c.log.startsWith(run.directory) && existsSync(c.log)));
    if (output === "patch") {
      const patch = readFileSync(run.delivery.patches[0], "utf8");
      assert.match(patch, /Subject: \[PATCH\] Add a greeting/u); assert.match(patch, /\+hello/u);
      assert.ok(result.output.summary.includes(run.delivery.patches[0]));
    }
    if (output !== "pr") { assert.equal(pushed(), ""); assert.equal(gh(), undefined); return; }
    assert.equal(pushed(), `refs/heads/${branch} ${commit}`);
    const body = join(run.directory, "pull-request.md");
    assert.deepEqual(gh(), ["pr", "create", "--repo", slug, "--draft", "--base", "main", "--head", branch, "--title", "Add a greeting", "--body-file", body]);
    assert.equal(readFileSync(body, "utf8"), "Add a greeting\n\n## Summary\n\nWrite hello to greeting.txt.\n\n## Checks\n\n- tests: passed\n\n## Review\n\nGreeting matches the ticket\n\nTicket: PROJ-12\n");
    assert.ok(result.output.summary.includes(`pull request ${url}`));
  });
}

test("an explicit branch base starts the worktree there and becomes the pull request base", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  git(f.repo, "branch", "release"); git(f.repo, "push", "-q", "origin", "release"); writeFileSync(join(f.repo, "code.txt"), "newer"); git(f.repo, "commit", "-qam", "newer"); f.head = git(f.repo, "rev-parse", "HEAD");
  const result = await execute(input(f, { output: "pr", base: "release", draft: false }));
  assert.equal(result.state, "delivered");
  assert.equal(git(f.repo, "rev-parse", `${branch}^`), git(f.repo, "rev-parse", "release")); assert.equal(evidence(f).delivery.baseCommit, git(f.repo, "rev-parse", "release"));
  assert.deepEqual(gh()!.slice(0, 8), ["pr", "create", "--repo", slug, "--base", "release", "--head", branch]);
  assert.equal(readFileSync(join(f.repo, "code.txt"), "utf8"), "newer");
});

test("a base that is a commit rather than a branch opens the pull request against the remote's default branch by name", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  const result = await execute(input(f, { output: "pr", base: f.head }));
  assert.equal(result.state, "delivered"); assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "main", "--head", branch]);
});

test("gh is given the checked base by name, so a configured gh-merge-base cannot turn the pull request elsewhere", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  // release is ahead of main on the remote; gh would take it from this configuration if it were left to choose the base.
  git(f.repo, "checkout", "-q", "-b", "release"); git(f.repo, "commit", "-q", "--allow-empty", "-m", "released"); git(f.repo, "push", "-q", "origin", "release");
  git(f.repo, "checkout", "-q", "main"); git(f.repo, "config", `branch.${branch}.gh-merge-base`, "release");
  const result = await execute(input(f, { output: "pr" }), {
    implementer: request => { git(request.cwd, "config", "branch.main.gh-merge-base", "release"); return implement(request); },
  });
  assert.equal(result.state, "delivered"); untouched(f);
  assert.equal(git(f.repo, "config", "--get", `branch.${branch}.gh-merge-base`), "release");
  assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
  assert.deepEqual(pushed().split("\n"), [`refs/heads/release ${git(f.repo, "rev-parse", "release")}`, `refs/heads/${branch} ${git(f.repo, "rev-parse", branch)}`]);
  assert.deepEqual(gh()!.slice(0, 9), ["pr", "create", "--repo", slug, "--draft", "--base", "main", "--head", branch]);
});

test("the default branch gh is given is the one the remote names, and a remote that names none blocks before any Agent", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const bare = join(f.root, "remote.git");
  git(f.repo, "push", "-q", "origin", "main:trunk"); git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk");
  const result = await execute(input(f, { output: "pr" }));
  assert.equal(result.state, "delivered"); assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "trunk", "--head", branch]);
  const before = pushed(); rmSync(join(f.root, "bin", "args"));
  // A detached HEAD on the remote still has a commit to compare with, but no branch for gh to be given.
  git(bare, "update-ref", "--no-deref", "HEAD", f.head); const second = { ...f, evidence: join(f.root, "evidence-2") };
  const unnamed = await execute({ ...input(second, { output: "pr" }), ticket: { ...input(f).ticket, id: "PROJ-13", title: "Add a farewell" } }, { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(unnamed.state, "blocked"); assert.deepEqual(unnamed.states, ["shape", "prepare", "failure", "blocked"]); untouched(f);
  held(second, unnamed, /^Blocked: Remote origin does not say which branch is its default, so the pull request base cannot be named\. Set repository\.base to a branch; nothing was changed\. Evidence: /u);
  assert.equal(pushed(), before); assert.equal(gh(), undefined); assert.equal(git(f.repo, "branch", "--list", "ticket/proj-13*"), "");
});

test("setup commands run in the worktree before any Agent and are kept as evidence", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, ".gitignore"), "deps/\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "ignore deps"); f.head = git(f.repo, "rev-parse", "HEAD");
  const install = 'require("fs").mkdirSync("deps");require("fs").writeFileSync("deps/installed","x");console.log(process.cwd())';
  const result = await execute(input(f, { setup: [command(install, { name: "install" })] }), {
    falsify: request => { assert.ok(existsSync(join(request.cwd, "deps/installed"))); return planning.falsify!.answer(request); },
  });
  assert.equal(result.state, "delivered"); untouched(f);
  const run = evidence(f); const [setup, red, verify] = run.result.checks;
  assert.deepEqual([setup.phase, setup.name, setup.passed, red.phase, verify.phase], ["setup", "install", true, "red", "verify"]);
  assert.match(readFileSync(setup.log, "utf8"), /widgets--proj-12/u);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt"); assert.equal(run.delivery.worktreeRemoved, true);
});

for (const [label, code, reason] of [
  ["a failing setup command", "process.exit(3)", /setup: tests did not meet/u],
  ["a setup command that leaves unignored files", 'require("fs").writeFileSync("generated.txt", "x")', /setup command changed/u],
] as const) {
  test(`${label} blocks before any Agent and keeps the worktree`, async context => {
    const f = fixture(context);
    const result = await execute(input(f, { setup: [command(code)] }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    const run = blocked(f, result, reason);
    assert.deepEqual(result.states, ["shape", "prepare", "failure", "blocked"]);
    assert.deepEqual([run.result.checks[0].phase, run.result.checks[0].passed, existsSync(run.result.checks[0].log)], ["setup", label.startsWith("a setup"), true]);
  });
}

/** A branch as a run of the ticket with this id slug leaves it: named for the ticket and carrying its record. */
const recordedBranch = (f: Fixture, name: string, ticket = "proj-12") => { git(f.repo, "branch", name); git(f.repo, "config", `branch.${name}.ticket`, ticket); };
/** What a run says of a branch that neither a record, a ticket commit, nor its name gives to one ticket. */
const unsettled = (name: string, ticket = "proj-12") => `no record of its ticket, and its name does not say where the id ends: it may be this ticket's, or that of a ticket whose id goes on after ${ticket}-. `
  + `Nothing was changed. Record whose it is with git config branch.${name}.ticket <id-slug> (${ticket} for this ticket), then run again.`;
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
for (const [label, occupy, found] of [
  ["branch a run of this ticket made", (f: Fixture) => recordedBranch(f, branch), `Branch ${branch} already exists in ${"<repo>"} for this ticket; nothing was changed.`],
  ["branch named before branches carried a title or a record", (f: Fixture) => git(f.repo, "branch", "ticket/proj-12"), `Branch ticket/proj-12 already exists in ${"<repo>"} for this ticket; nothing was changed.`],
  ["branch a run of this ticket made under an earlier title", (f: Fixture) => recordedBranch(f, "ticket/proj-12-an-earlier-title"), `Branch ticket/proj-12-an-earlier-title already exists in ${"<repo>"} for this ticket; nothing was changed.`],
  ["branch of the name this run would take that has no record", (f: Fixture) => git(f.repo, "branch", branch), `Branch ${branch} already exists in ${"<repo>"} with ${unsettled(branch)}`],
  ["branch named for this ticket under an earlier title that has no record", (f: Fixture) => git(f.repo, "branch", "ticket/proj-12-an-earlier-title"),
    `Branch ticket/proj-12-an-earlier-title already exists in ${"<repo>"} with ${unsettled("ticket/proj-12-an-earlier-title")}`],
  ["worktree directory", (f: Fixture) => mkdirSync(f.worktree, { recursive: true }), "Worktree directory"],
] as const) {
  test(`an existing ${label} blocks without changing anything`, async context => {
    const f = fixture(context); occupy(f);
    const branches = git(f.repo, "branch", "--format=%(refname:short) %(objectname)");
    const result = await execute(input(f, { setup: [command("process.exit(1)")] }), { investigator: () => assert.fail() });
    assert.equal(result.state, "blocked"); untouched(f);
    const run = held(f, result, /already exists/u); assert.ok(result.output.summary.startsWith(`Blocked: ${found.replace("<repo>", f.repo)} `));
    assert.doesNotMatch(result.output.summary, /Worktree kept/u);
    assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.result.checks.length], [false, false, null, 0]);
    assert.equal(git(f.repo, "branch", "--format=%(refname:short) %(objectname)"), branches);
    assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
    assert.deepEqual(existsSync(f.worktree) ? readdirSync(f.worktree) : [], []);
  });
}

test("a sound ticket is planned, reviewed, and delivered with the approved plan in the tester's and the implementer's prompts", async context => {
  const f = fixture(context); const calls: string[] = []; const prompts: Record<string, string> = {};
  const result = await execute(input(f, {}, { stuck: "park" }), {
    falsify: request => {
      calls.push("falsify"); assert.equal(request.cwd, f.worktree); assert.deepEqual([...request.outcomes].sort(), ["questions", "sound"]);
      assert.match(request.prompt, /Ticket PROJ-12: Add a greeting\n\n## Goal\nWrite hello/u);
      for (const asked of [/\bsound\b/u, /one[- ]paragraph summary/iu, /\bquestions\b/u, /\barray\b/iu, /\bperson\b/iu]) assert.match(request.prompt, asked);
      return ok("sound", "The ticket names its file and what the file must contain");
    },
    plan: request => { calls.push("plan"); assert.equal(request.cwd, f.worktree); assert.deepEqual(request.outcomes, ["planned"]); return ok("planned", plan); },
    planReview: request => {
      calls.push("planReview"); assert.equal(request.cwd, f.worktree); assert.deepEqual([...request.outcomes].sort(), ["approved", "revise"]);
      assert.ok(request.prompt.includes("Cover it in greeting.test.txt"));
      return ok("approved", "The plan covers the criterion");
    },
    tester: request => { calls.push("tester"); prompts.tester = request.prompt; return tester(request); },
    implementer: request => { calls.push("implementer"); prompts.implementer = request.prompt; return implement(request); },
    reviewer: () => { calls.push("reviewer"); return review(); },
  });
  assert.equal(result.state, "delivered"); assert.deepEqual(calls, ["falsify", "plan", "planReview", "tester", "implementer", "reviewer"]);
  for (const role of ["tester", "implementer"]) assert.ok(planIn(prompts[role]!).startsWith(`${plan}\n`), role);
  const run = held(f, result, /^Delivered/u);
  assert.deepEqual(run.result.agents[1], { stage: "plan", outcome: "planned", summary: plan });
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "agent-2.json"), "utf8")), { stage: "plan", outcome: "planned", summary: plan });
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
});

for (const policy of ["park", undefined]) {
  test(`${policy ?? "default"} stuck policy parks a ticket falsified with two questions on those questions, with the worktree unedited`, async context => {
    const f = fixture(context); const human = person();
    const questions = ["Which language is the greeting in?", "Does greeting.txt replace code.txt or stand beside it?"];
    const data = input(f);
    if (policy === undefined) Reflect.deleteProperty(data, "stuck"); else data.stuck = policy;
    const result = await execute(data, {
      falsify: () => ({ type: "questions", summary: "The ticket leaves two things open", questions }),
      plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    const run = parked(f, result, /\S/u, human);
    assert.deepEqual(run.delivery.park.needs.split("\n"), questions);
    assert.ok(readFileSync(join(run.directory, "park.txt"), "utf8").includes(`Needs: ${questions[0]}\n${questions[1]}\n`));
    for (const question of questions) assert.ok(result.output.summary.includes(question), question);
    assert.equal(result.states[3], "falsify"); assert.equal(result.states.some(state => state === "plan" || state === "planReview" || state === "test" || state === "change"), false);
    assert.deepEqual(candidate(f.worktree), { status: "", files: [["code.txt", 0, Buffer.from("old").toString("base64")]] });
    assert.deepEqual(run.result.checks, []);
  });
}

test("ten questions are the most a falsified ticket parks with, and all ten are kept", async context => {
  const f = fixture(context); const human = person();
  const questions = Array.from({ length: 10 }, (_, index) => `What does part ${index + 1} of the greeting say?`);
  const result = await execute(input(f, {}, { stuck: "park" }), { falsify: () => ({ type: "questions", summary: "The ticket leaves ten things open", questions }), plan: () => assert.fail() }, human);
  const run = parked(f, result, /\S/u, human);
  assert.deepEqual(run.delivery.park.needs.split("\n"), questions);
});

for (const [label, questions] of [
  ["left out", undefined], ["a string rather than an array", "Which language is the greeting in?"], ["an empty array", []],
  ["an array holding a blank string", ["Which language is the greeting in?", " \n"]], ["an array holding a value that is not a string", ["Which language is the greeting in?", 7]],
  ["an array of eleven", Array.from({ length: 11 }, (_, index) => `What does part ${index + 1} of the greeting say?`)],
] as const) {
  test(`a falsify report whose questions field is ${label} parks with the field named`, async context => {
    const f = fixture(context); const human = person();
    const result = await execute(input(f, {}, { stuck: "park" }), {
      falsify: () => ({ type: "questions", summary: "The ticket leaves the language open", ...(questions === undefined ? {} : { questions }) }),
      plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    // Nothing the Agent wrote says "questions", so the word can only be the Machine naming the field.
    const run = parked(f, result, /\bquestions\b/u, human);
    assert.doesNotMatch(run.delivery.park.needs, /What does part 11/u);
    assert.equal(candidate(f.worktree).status, ""); assert.deepEqual(run.result.checks, []);
  });
}

test("a plan the reviewer sends back once is planned again with that review, whatever the budgets, and the approved plan is the one worked from", async context => {
  const f = fixture(context); const plans: string[] = []; const planReviews: string[] = []; const prompts: string[] = [];
  const first = "Add greeting.txt and nothing else.";
  const result = await execute(input(f, {}, { stuck: "park", maxRepairs: 0, maxReviewRounds: 0 }), {
    plan: request => { plans.push(request.prompt); return ok("planned", plans.length === 1 ? first : plan); },
    planReview: request => { planReviews.push(request.prompt); return planReviews.length === 1 ? ok("revise", "Name the test that proves the greeting") : ok("approved", "The plan now names its test"); },
    tester: request => { prompts.push(request.prompt); return tester(request); },
    implementer: request => { prompts.push(request.prompt); return implement(request); },
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([plans.length, planReviews.length, prompts.length], [2, 2, 2]);
  assert.deepEqual(result.states.slice(0, result.states.indexOf("test")).filter(isPlanning), ["falsify", "plan", "planReview", "plan", "planReview"]);
  assert.equal(plans[0]!.includes("Name the test that proves the greeting"), false); assert.ok(plans[1]!.includes("Name the test that proves the greeting"));
  assert.ok(planReviews[0]!.includes(first)); assert.ok(planReviews[1]!.includes("Cover it in greeting.test.txt"));
  for (const prompt of prompts) { assert.ok(planIn(prompt).startsWith(`${plan}\n`)); assert.equal(planIn(prompt).startsWith(first), false); }
  const run = held(f, result, /^Delivered/u);
  // Sending a plan back is not a review round of the implementation: neither budget is spent on it.
  assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
  assert.deepEqual(run.result.agents.filter((agent: any) => agent.stage === "plan").map((agent: any) => agent.summary), [first, plan]);
});

test("a plan the reviewer sends back twice parks with the reviewer's summary as what is needed, before anything is edited", async context => {
  const f = fixture(context); const human = person(); let plans = 0; let planReviews = 0;
  const result = await execute(input(f, {}, { stuck: "park" }), {
    plan: () => ok("planned", `Attempt ${++plans}: add greeting.txt.`),
    planReview: () => ok("revise", ++planReviews === 1 ? "Name the test that proves the greeting" : "The plan still names no test"),
    tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = parked(f, result, /\S/u, human);
  assert.deepEqual([plans, planReviews], [2, 2]);
  assert.ok(run.delivery.park.needs.includes("The plan still names no test")); assert.ok(result.output.summary.includes("The plan still names no test"));
  assert.doesNotMatch(run.delivery.park.needs, /Name the test that proves the greeting/u);
  assert.deepEqual(result.states.filter(isPlanning), ["falsify", "plan", "planReview", "plan", "planReview"]);
  assert.equal(candidate(f.worktree).status, ""); assert.deepEqual(run.result.checks, []);
});

test("a plan of 4000 characters is carried whole, and one of 4001 never reaches the tester or the implementer", async context => {
  for (const length of [4000, 4001]) {
    const f = fixture(context); const long = "p".repeat(length); let edits = 0;
    const counted = (work: Runner): Runner => request => { edits++; assert.ok(planIn(request.prompt).startsWith(`${long}\n`)); return work(request); };
    // Whether the run fails outright or the stuck policy takes it is the Machine's choice; either way it says the limit and edits nothing.
    const [state, said] = await execute(input(f, {}, { stuck: "park" }), { plan: () => ok("planned", long), tester: counted(tester), implementer: counted(implement) })
      .then(done => [done.state, evidence(f).delivery.reason ?? ""], error => ["failed", String(error.message)]);
    if (length === 4000) { assert.deepEqual([state, edits], ["delivered", 2]); continue; }
    assert.notEqual(state, "delivered"); assert.equal(edits, 0); assert.match(said, /4000/u);
    assert.equal(candidate(f.worktree).status, ""); assert.equal(git(f.repo, "rev-parse", branch), f.head);
  }
});

for (const state of ["falsify", "plan", "planReview"]) {
  test(`${state} editing the worktree waits for a decision before any later Agent`, async context => {
    const f = fixture(context); const human = person("hand off"); const calls: string[] = [];
    const reading = (name: string): Runner => request => {
      calls.push(name);
      if (name === state) writeFileSync(join(request.cwd, "code.txt"), "edited");
      return planning[name]!.answer(request);
    };
    const result = await execute(input(f), {
      falsify: reading("falsify"), plan: reading("plan"), planReview: reading("planReview"),
      tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    handedOff(f, result, /read-only stage/u, human);
    assert.deepEqual(calls, upTo(state));
    assert.equal(readFileSync(join(f.worktree, "code.txt"), "utf8"), "edited");
  });
}

test("a tester blocker waits for a decision with what is missing, before any implementation", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { tester: () => ok("blocked", "Acceptance criteria\nare missing"), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  handedOff(f, result, /Acceptance criteria\s+are missing/u, human);
  assert.ok(result.output.summary.startsWith(`Handed off on ${branch}: Acceptance criteria are missing. Decision: hand off. Worktree kept at ${f.worktree}. Evidence: `));
});

test("an implementer blocker waits for a decision without green checks, review, or a commit", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { implementer: () => ok("blocked", "Required API specification unavailable"), reviewer: () => assert.fail() }, human);
  const run = handedOff(f, result, /specification unavailable/u, human);
  assert.deepEqual(run.result.checks.map(check => check.phase), ["red"]);
});

test("checks failing until the repair budget is exhausted wait for a decision, and commit and push nothing", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); let edits = 0; const human = person("hand off");
  const result = await execute(input(f, { output: "pr", checks: [command("process.exit(1)")] }, { maxRepairs: 2, maxReviewRounds: 2 }), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => assert.fail(),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(2\)/u, human);
  assert.equal(edits, 3); assert.deepEqual(run.result.checks.map(c => c.passed), [true, false, false, false]);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined);
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
  const [request, ...others] = human.requests; assert.deepEqual(others, []);
  assert.deepEqual(request!.choices, ["more rounds", "hand off", "archive", "discard"]);
  for (const part of ["Ticket PROJ-12: Add a greeting", `Repair budget exhausted (2). verify: tests did not meet its expected result; inspect ${run.result.checks[3].log}`,
    "Repair rounds used: 2 of 2.", `Worktree: ${f.worktree}`, `Branch: ${branch}`]) assert.ok(request!.prompt.includes(part), part);
});

test("review feedback is repaired once through fresh checks and another review", async context => {
  const f = fixture(context); let edits = 0; let reviews = 0;
  const result = await execute(input(f), {
    implementer: request => { if (++edits === 2) assert.match(request.prompt, /Handle the empty case/u); writeFileSync(join(request.cwd, "greeting.txt"), `hello ${edits}\n`); return ok(); },
    reviewer: () => ++reviews === 1 ? review("revise", "Handle the empty case") : review("approved"),
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [2, 2]);
  const run = evidence(f); assert.equal(run.result.repairs, 0); assert.equal(run.result.reviewRounds, 1); assert.equal(run.result.checks.length, 3);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello 2"); assert.equal(git(f.repo, "rev-list", "--count", `main..${branch}`), "1");
});

test("a reviewer that edits a file cannot approve the candidate", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { reviewer: request => { writeFileSync(join(request.cwd, "greeting.txt"), "unreviewed"); return review("approved"); } }, human);
  handedOff(f, result, /read-only stage/u, human);
});

test("a reviewer blocker waits for a decision", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { reviewer: () => review("blocked", "The ticket contradicts the existing contract") }, human);
  handedOff(f, result, /contradicts the existing contract/u, human);
});

test("the default gate budget allows three repairs before failing checks wait for a decision", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0;
  const result = await execute(input(f, { checks: [command("process.exit(1)")] }), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => assert.fail(),
  }, human);
  const run = handedOff(f, result, /Repair budget exhausted \(3\)/u, human);
  assert.deepEqual([edits, run.result.repairs, run.result.reviewRounds, run.result.checksPassed], [4, 3, 0, false]);
  assert.deepEqual(run.result.checks.map(check => check.passed), [true, false, false, false, false]);
  assert.equal(human.requests.length, 1);
  assert.ok(human.requests[0]!.prompt.includes("Repair rounds used: 3 of 3."));
});

test("the default review budget allows two rounds before review feedback waits for a decision", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const result = await execute(input(f), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => review("revise", `Finding ${++reviews}`),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(2\)\. Finding 3/u, human);
  assert.deepEqual([edits, reviews, run.result.repairs, run.result.reviewRounds, run.result.checksPassed], [3, 3, 0, 2, true]);
  assert.ok(human.requests[0]!.prompt.includes("Review rounds used: 2 of 2."));
});

test("a base that does not resolve still ends blocked in prepare without a Human step", async context => {
  const f = fixture(context);
  const result = await execute(input(f, { base: "no-such-branch" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["shape", "prepare", "failure", "blocked"]);
  const run = held(f, result, /^Blocked: Base no-such-branch does not resolve/u); untouched(f);
  assert.deepEqual([run.delivery.outcome, run.delivery.decision, run.delivery.worktreeCreated, run.result.decisions], ["blocked", undefined, false, []]);
  assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
});

test("more rounds restarts the budget with the standing findings, and an approval then delivers", async context => {
  const f = fixture(context); const human = person("more rounds"); const prompts: string[] = []; let reviews = 0;
  const result = await execute(input(f, {}, { maxRepairs: 1, maxReviewRounds: 1 }), {
    implementer: request => { prompts.push(request.prompt); writeFileSync(join(request.cwd, "greeting.txt"), `hello ${prompts.length}\n`); return ok(); },
    reviewer: () => ++reviews < 3 ? review("revise", `Finding ${reviews}`) : review("approved", "Greeting matches the ticket"),
  }, human);
  assert.equal(result.state, "delivered"); assert.deepEqual([prompts.length, reviews, human.requests.length], [3, 3, 1]);
  assert.deepEqual(result.states.slice(-15), ["reviewBudget", "stuck", "decide", "repairTarget", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  assert.ok(human.requests[0]!.prompt.includes("Review budget exhausted (1). Finding 2"));
  // The pass a person granted is briefed exactly as the ordinary repair before it was.
  assert.ok(prompts[1]!.includes("Current failure/feedback: Finding 1")); assert.ok(prompts[2]!.includes("Current failure/feedback: Finding 2"));
  assert.doesNotMatch(prompts[2]!, /budget exhausted/u);
  const commit = git(f.repo, "rev-parse", branch);
  const run = held(f, result, new RegExp(`^Delivered ${branch} at ${commit}\\. Decision: more rounds\\. Evidence: `, "u")); untouched(f);
  assert.deepEqual([run.delivery.outcome, run.delivery.decision, run.delivery.commit, run.delivery.worktreeRemoved], ["delivered", "more rounds", commit, true]);
  assert.deepEqual([run.result.outcome, run.result.repairs, run.result.reviewRounds, run.result.agentInvocations], ["completed", 0, 1, 10]);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello 3"); assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
  assert.equal(existsSync(f.worktree), false);
});

test("more rounds can be chosen again each time the budget runs out", async context => {
  const f = fixture(context); const human = person("more rounds", "more rounds", "hand off"); let edits = 0;
  const result = await execute(input(f, { checks: [command("process.exit(1)")] }, { maxRepairs: 1, maxReviewRounds: 1 }), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => assert.fail(),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(1\)/u, human);
  assert.equal(edits, 6); assert.equal(result.states.filter(state => state === "decide").length, 3);
  assert.deepEqual(human.requests.map(request => /Repair rounds used: .+/u.exec(request.prompt)![0]),
    ["Repair rounds used: 1 of 1.", "Repair rounds used: 1 of 1 in this budget, 2 in all.", "Repair rounds used: 1 of 1 in this budget, 3 in all."]);
  assert.deepEqual([run.result.repairs, run.result.checks.length], [3, 7]);
  assert.deepEqual(run.result.decisions.map((made: any) => made.response), ["more rounds", "more rounds", "hand off"]);
});

test("more rounds after a budget of zero still gives the implementer one pass", async context => {
  const f = fixture(context); const human = person("more rounds"); let reviews = 0;
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ++reviews === 1 ? review("revise", "Handle the empty case") : review("approved") }, human);
  assert.equal(result.state, "delivered"); assert.equal(reviews, 2); assert.ok(human.requests[0]!.prompt.includes("Repair rounds used: 0 of 0."));
});

test("hand off leaves the worktree, the branch, and the uncommitted candidate as they were", async context => {
  const f = fixture(context); let before: unknown;
  const human = person(() => { before = candidate(f.worktree); return "hand off"; });
  const result = await execute(scoped(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), "code.txt"), {
    implementer: request => { writeFileSync(join(request.cwd, "code.txt"), "new"); return implement(request); }, reviewer: () => review("revise", "Handle the empty case"),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(0\)\. Handle the empty case/u, human);
  assert.deepEqual(candidate(f.worktree), before); assert.equal(candidate(f.worktree).status, "M code.txt\n?? greeting.test.txt\n?? greeting.txt");
  assert.equal(git(f.repo, "rev-list", "--count", `main..${branch}`), "0"); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 2);
  assert.equal(run.delivery.archive, undefined); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
});

test("archive leaves the tracked and untracked candidate on archive/<slug>, with the worktree and ticket branch gone", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, "obsolete.txt"), "remove me\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "obsolete"); f.head = git(f.repo, "rev-parse", "HEAD");
  let before: ReturnType<typeof candidate> | undefined;
  const human = person(() => { before = candidate(f.worktree); return "archive"; });
  const result = await execute(scoped(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), "code.txt", "obsolete.txt", "bin", "logo.bin"), {
    implementer: request => {
      writeFileSync(join(request.cwd, "code.txt"), "new without a final newline "); rmSync(join(request.cwd, "obsolete.txt"));
      mkdirSync(join(request.cwd, "bin")); writeFileSync(join(request.cwd, "bin/tool.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
      writeFileSync(join(request.cwd, "logo.bin"), Buffer.from([0, 255, 1, 0, 128, 10, 13, 0]));
      mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/nested.json"), "{}");
      return implement(request);
    },
    reviewer: () => review("revise", "Handle the empty case"),
  }, human);
  abandoned(f, result, "archive");
  assert.deepEqual(result.states.slice(-5), ["decide", "archive", "remove", "abandon", "abandoned"]);
  assert.equal(before!.status, "M code.txt\n D obsolete.txt\n?? bin/tool.sh\n?? greeting.test.txt\n?? greeting.txt\n?? logo.bin");
  // The archive is one commit on the base, holding what the ticket commit would have.
  assert.equal(git(f.repo, "rev-parse", `${archiveBranch}^`), f.head);
  assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", archiveBranch), "Archive: Add a greeting\nTicket: PROJ-12");
  assert.equal(git(f.repo, "diff", "--name-status", "--no-renames", f.head, archiveBranch), "A\tbin/tool.sh\nM\tcode.txt\nA\tgreeting.test.txt\nA\tgreeting.txt\nA\tlogo.bin\nD\tobsolete.txt");
  // A fresh clone on the archive branch stands in for whoever picks the candidate up later.
  const restored = join(f.root, "restored"); git(f.root, "clone", "-q", "--branch", archiveBranch, f.repo, restored);
  assert.deepEqual(candidate(restored), { status: "", files: before!.files });
});

test("archive leaves ignored files out of the archive commit, as delivery leaves them out of the ticket commit, and the decision says so", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, ".gitignore"), "*.log\nbuild/\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "ignore"); f.head = git(f.repo, "rev-parse", "HEAD");
  let before = "";
  const human = person(() => { before = candidate(f.worktree, true).status; return "archive"; });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), {
    implementer: request => {
      writeFileSync(join(request.cwd, "debug.log"), "what the implementer learned\n");
      mkdirSync(join(request.cwd, "build")); writeFileSync(join(request.cwd, "build/out.bin"), Buffer.from([0, 255, 1, 0]), { mode: 0o755 });
      return implement(request);
    },
    reviewer: () => review("revise", "Handle the empty case"),
  }, human);
  abandoned(f, result, "archive");
  assert.equal(before, "?? greeting.test.txt\n?? greeting.txt\n!! build/out.bin\n!! debug.log");
  assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", archiveBranch), ".gitignore\ncode.txt\ngreeting.test.txt\ngreeting.txt");
  assert.ok(human.requests[0]!.prompt.includes(`archive: commit the candidate as delivery would have and keep that commit as the branch ${archiveBranch}, then remove the worktree and delete ${branch}. Ignored files are not kept.`));
});

test("a candidate that does not differ from its base is not archived, and nothing is removed", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, ".gitignore"), "*.log\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "ignore"); f.head = git(f.repo, "rev-parse", "HEAD");
  // An ignored file is no difference: delivery would not have committed it either.
  const human = person(() => { writeFileSync(join(f.worktree, "debug.log"), "what the tester learned\n"); return "archive"; });
  const result = await execute(input(f), { tester: () => ok("blocked", "The ticket names no file"), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  const run = blocked(f, result, new RegExp(`candidate could not be archived, so nothing was removed: the candidate does not differ from its base commit ${f.head}, so there is nothing to archive; discard removes it`, "u"));
  assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
  assert.deepEqual([run.delivery.decision, run.delivery.archive], ["archive", undefined]); assert.doesNotMatch(result.output.summary, /archived on/u);
  assert.equal(candidate(f.worktree, true).status, "!! debug.log"); assert.equal(git(f.worktree, "diff", "--cached", "--name-only"), "");
  assert.equal(git(f.repo, "rev-parse", branch), f.head); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
});

test("an existing archive branch blocks the archive before anything is staged, and nothing is removed", async context => {
  const f = fixture(context); git(f.repo, "branch", archiveBranch);
  let before: ReturnType<typeof candidate> | undefined; let index = "";
  const human = person(() => { before = candidate(f.worktree); index = git(f.worktree, "ls-files", "--stage"); return "archive"; });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, human);
  const run = blocked(f, result, new RegExp(`candidate could not be archived, so nothing was removed: branch ${archiveBranch} already exists in .+, and nothing was staged`, "u"));
  assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
  assert.deepEqual([run.delivery.decision, run.delivery.archive], ["archive", undefined]);
  assert.deepEqual(candidate(f.worktree), before); assert.equal(before!.status, "?? greeting.test.txt\n?? greeting.txt"); assert.equal(git(f.worktree, "ls-files", "--stage"), index);
  assert.equal(git(f.repo, "rev-parse", archiveBranch), f.head); assert.equal(git(f.repo, "rev-parse", branch), f.head);
});

test("a failing commit hook does not prevent the archive", async context => {
  const f = fixture(context);
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true });
  for (const hook of ["pre-commit", "commit-msg"]) writeFileSync(join(f.repo, ".git/hooks", hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.throws(() => git(f.repo, "commit", "-q", "--allow-empty", "-m", "refused by the hooks"));
  const result = await execute(input(f, { checks: [command("process.exit(1)")] }, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => assert.fail() }, person("archive"));
  abandoned(f, result, "archive");
  assert.equal(git(f.repo, "rev-parse", `${archiveBranch}^`), f.head);
  assert.equal(git(f.repo, "show", "--name-only", "--format=%s", archiveBranch), "Archive: Add a greeting\n\ngreeting.test.txt\ngreeting.txt");
});

test("delivery.json and the summary name the archive branch and its commit", async context => {
  const f = fixture(context);
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, person("archive"));
  const run = abandoned(f, result, "archive"); const commit = git(f.repo, "rev-parse", archiveBranch);
  assert.deepEqual(run.delivery, {
    schemaVersion: 1, outcome: "abandoned", reason: "Review budget exhausted (0). Handle the empty case\nBlocker: Handle the empty case (greeting.txt:1)", decision: "archive",
    ticket: "PROJ-12", repository: { name: "widgets", path: f.repo }, branch, baseCommit: f.head, commit: null, output: "branch",
    archive: { branch: archiveBranch, commit }, worktree: f.worktree, worktreeCreated: true, worktreeRemoved: true, reviewNotes: [],
  });
  assert.ok(result.output.summary.includes(`Decision: archive. Candidate archived on ${archiveBranch} at ${commit}. Worktree and ${branch} removed. Evidence: `));
  // The archive commit is the workflow's own: the candidate it holds is the one the checks passed on.
  assert.equal(run.result.checksPassed, true);
  assert.deepEqual(readdirSync(run.directory).filter(name => /patch|index|checkout/u.test(name)), []);
});

for (const further of [false, true]) {
  test(`archive keeps a commit an Agent made on the ticket branch, ${further ? "below the archive commit of what is still uncommitted" : "as it is when nothing else is uncommitted"}`, async context => {
    const f = fixture(context);
    const result = await execute(scoped(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), "code.txt"), {
      implementer: request => {
        implement(request); git(request.cwd, "add", "."); git(request.cwd, "commit", "-qm", "agent commit");
        if (further) writeFileSync(join(request.cwd, "code.txt"), "new");
        return ok();
      },
      reviewer: () => review("revise", "Handle the empty case"),
    }, person("archive"));
    const run = abandoned(f, result, "archive");
    assert.equal(git(f.repo, "log", "--format=%s", `${f.head}..${archiveBranch}`), further ? "Archive: Add a greeting\nagent commit" : "agent commit");
    assert.equal(git(f.repo, "show", `${archiveBranch}:greeting.txt`), "hello"); assert.equal(git(f.repo, "show", `${archiveBranch}:code.txt`), further ? "new" : "old");
    assert.deepEqual(run.delivery.archive, { branch: archiveBranch, commit: git(f.repo, "rev-parse", archiveBranch) });
  });
}

test("a worktree that is not clean after the archive commit ends blocked with nothing removed and no archive branch", async context => {
  const f = fixture(context);
  // --no-verify skips the hooks that can refuse a commit; this one runs after it.
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/post-commit"), "#!/bin/sh\necho late > late.txt\n", { mode: 0o755 });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, person("archive"));
  const run = blocked(f, result, new RegExp(`candidate could not be archived, so nothing was removed: the worktree is not clean after the archive commit, so ${archiveBranch} would not hold all of the candidate`, "u"), 1);
  assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
  assert.deepEqual([run.delivery.decision, run.delivery.archive], ["archive", undefined]); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
  assert.equal(git(f.repo, "log", "-1", "--format=%s", branch), "Archive: Add a greeting");
  assert.equal(readFileSync(join(f.worktree, "late.txt"), "utf8"), "late\n"); assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
});

test("a hook that resets HEAD off the archive commit and leaves a clean worktree ends blocked with nothing removed and no archive branch", async context => {
  const f = fixture(context);
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/post-commit"), "#!/bin/sh\ngit reset --quiet --hard HEAD~1\n", { mode: 0o755 });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, person("archive"));
  const run = blocked(f, result, new RegExp(`candidate could not be archived, so nothing was removed: a commit hook or Git configuration moved HEAD off the archive commit or changed what it holds, so ${archiveBranch} would not hold the candidate; HEAD is at ${f.head}`, "u"));
  assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
  assert.deepEqual([run.delivery.decision, run.delivery.archive], ["archive", undefined]); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
  // The reset left nothing for the clean check to see: the worktree is on the base without the candidate.
  assert.equal(git(f.worktree, "status", "--porcelain"), ""); assert.equal(git(f.repo, "rev-parse", branch), f.head); assert.ok(!existsSync(join(f.worktree, "greeting.txt")));
  // The archive commit is still where the hook left it, since the worktree and its reflog were kept.
  assert.equal(git(f.worktree, "log", "-1", "--format=%s", "HEAD@{1}"), "Archive: Add a greeting"); assert.equal(git(f.worktree, "show", "HEAD@{1}:greeting.txt"), "hello");
});

for (const [changed, script] of [
  ["subject", 'sed -i "1s/.*/Rewritten/" "$1"'],
  ["ticket", 'sed -i "s/^Ticket: PROJ-12$/Ticket: PROJ-123/" "$1"'],
] as const) {
  test(`a hook that rewrites the archive commit's ${changed} ends blocked with nothing removed and no archive branch`, async context => {
    const f = fixture(context);
    // --no-verify skips commit-msg, not the hook that prepares the message.
    mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/prepare-commit-msg"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, person("archive"));
    const run = blocked(f, result, new RegExp(`candidate could not be archived, so nothing was removed: a commit hook or Git configuration changed the archive commit's message, so ${archiveBranch} would not name the ticket; HEAD is at [0-9a-f]{40}, which holds the candidate`, "u"), 1);
    assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
    assert.deepEqual([run.delivery.decision, run.delivery.archive], ["archive", undefined]); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
    // The candidate is whole in the commit the hook reworded, on the ticket branch that was kept.
    assert.equal(git(f.worktree, "status", "--porcelain"), ""); assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
    assert.equal(git(f.repo, "log", "-1", "--format=%B", branch), changed === "subject" ? "Rewritten\n\nTicket: PROJ-12" : "Archive: Add a greeting\n\nTicket: PROJ-123");
    assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello"); assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
  });
}

test("a hook that adds to the archive commit's message without changing its subject or ticket does not prevent the archive", async context => {
  const f = fixture(context);
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/prepare-commit-msg"), '#!/bin/sh\nprintf "\\nPrepared-by: hook\\n" >> "$1"\n', { mode: 0o755 });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, person("archive"));
  abandoned(f, result, "archive");
  assert.equal(git(f.repo, "log", "-1", "--format=%B", archiveBranch), "Archive: Add a greeting\n\nTicket: PROJ-12\n\nPrepared-by: hook");
});

test("a candidate that cannot be staged ends blocked with nothing removed", async context => {
  const f = fixture(context);
  // Git refuses to add an embedded repository that has no commit.
  const human = person(() => { git(f.worktree, "init", "-q", "embedded"); return "archive"; });
  const result = await execute(input(f, { checks: [command("process.exit(1)")] }, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => assert.fail() }, human);
  const run = blocked(f, result, /candidate could not be archived, so nothing was removed; inspect .+git-add\.log/u);
  assert.deepEqual(result.states.slice(-4), ["decide", "archive", "failure", "blocked"]);
  assert.deepEqual([run.delivery.decision, run.delivery.archive], ["archive", undefined]); assert.ok(existsSync(join(run.directory, "git-add.log")));
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n"); assert.equal(git(f.repo, "rev-parse", branch), f.head);
  assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
});

test("discard then go back returns to the decision with the worktree, branch, and candidate as they were", async context => {
  const f = fixture(context); let before: unknown; let between: unknown;
  const human = person(() => { before = candidate(f.worktree); return "discard"; }, "go back", () => { between = candidate(f.worktree); return "hand off"; });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, human);
  assert.deepEqual(result.states.slice(-6), ["decide", "confirmDiscard", "stuck", "decide", "handOff", "handedOff"]);
  const run = handedOff(f, result, /budget exhausted \(0\)\. Handle the empty case/u, human);
  assert.deepEqual(between, before); assert.deepEqual(candidate(f.worktree), before);
  const [first, confirm, second] = human.requests;
  assert.deepEqual(confirm!.choices, ["confirm discard", "go back"]);
  assert.equal(first!.prompt.split("\n")[0], "Ticket PROJ-12 is stuck: choose how to go on");
  assert.equal(confirm!.prompt.split("\n")[0], "Discard the candidate for ticket PROJ-12?");
  for (const request of [first!, confirm!]) {
    assert.equal(request.prompt.split("\n")[1], "");
    assert.match(request.prompt, /Stopped in reviewBudget\./u);
    assert.match(request.prompt, /Repair rounds used: 0 of 0\./u); assert.match(request.prompt, /Review rounds used: 0 of 0\./u);
    assert.ok(request.prompt.includes(`Evidence: ${run.directory}`));
    assert.doesNotMatch(request.prompt, /^#/mu);
  }
  assert.ok(first!.prompt.indexOf("hand off:") < first!.prompt.indexOf("more rounds:"));
  assert.match(first!.prompt, /hand off: .+ \(recommended\)/u);
  assert.ok(confirm!.prompt.indexOf("confirm discard:") < confirm!.prompt.indexOf("go back:"));
  assert.doesNotMatch(confirm!.prompt, /Needs:|\(recommended\)/u);
  for (const part of [f.worktree, branch, "will not be saved"]) assert.ok(confirm!.prompt.includes(part), part);
  assert.deepEqual([second!.prompt, second!.choices], [first!.prompt, first!.choices]);
  assert.deepEqual(run.result.decisions.map((made: any) => `${made.stage}: ${made.response}`), ["decide: discard", "confirmDiscard: go back", "decide: hand off"]);
  assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
});

test("discard removes the worktree and branch only after it is confirmed, and archives nothing", async context => {
  const f = fixture(context); let unconfirmed = false;
  const human = person("discard", () => {
    unconfirmed = existsSync(join(f.worktree, "greeting.txt")) && git(f.repo, "rev-parse", branch) === f.head && git(f.repo, "config", "--local", "--get", `branch.${branch}.ticket`) === "proj-12";
    return "confirm discard";
  });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, human);
  assert.ok(unconfirmed); assert.deepEqual(result.states.slice(-5), ["decide", "confirmDiscard", "remove", "abandon", "abandoned"]);
  const run = abandoned(f, result, "discard");
  // The ticket record goes with the branch.
  assert.doesNotMatch(git(f.repo, "config", "--local", "--list"), /^branch\./mu);
  assert.equal(run.delivery.archive, undefined); assert.doesNotMatch(result.output.summary, /archived/u);
  assert.ok(result.output.summary.includes(`Decision: discard. Worktree and ${branch} removed without saving the candidate. Evidence: `));
  assert.deepEqual(run.result.decisions.map((made: any) => made.response), ["discard", "confirm discard"]);
});

test("a worktree that cannot be removed after a confirmed discard ends blocked with the saved log", async context => {
  const f = fixture(context);
  const human = person("discard", () => { git(f.repo, "worktree", "lock", f.worktree); return "confirm discard"; });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, human);
  const run = blocked(f, result, /git worktree failed; inspect .+git-worktree\.log/u);
  assert.match(readFileSync(join(run.directory, "git-worktree.log"), "utf8"), /locked/u); assert.equal(run.delivery.decision, "discard");
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n"); assert.equal(git(f.repo, "rev-parse", branch), f.head);
});

/** Ends a first run handed off with its uncommitted candidate, and returns the fixture a second run records its own evidence under. */
async function handOff(f: Fixture) {
  const first = await execute(input(f, { setup: [command('console.log("installed")', { name: "install" })] }, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => review("revise", "Handle the empty case") }, person("hand off"));
  assert.equal(first.state, "handedOff");
  return { ...f, evidence: join(f.root, "evidence-resumed") };
}

test("a resumed run verifies, reviews, and delivers the candidate a handed-off run left, without falsify, plan, plan review, or setup", async context => {
  const f = fixture(context); const again = await handOff(f);
  const result = await execute(input(again, { setup: [command("process.exit(1)", { name: "install" })] }, { resume: true }), {
    investigator: () => assert.fail(), planReview: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => { assert.equal(request.cwd, f.worktree); assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), "hello\n"); return review("approved", "Greeting matches the ticket"); },
  });
  assert.equal(result.state, "delivered");
  assert.deepEqual(result.states, ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  const commit = git(f.repo, "rev-parse", branch);
  const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
  assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head); assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello"); assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", branch), "Add a greeting\nTicket: PROJ-12");
  assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
  assert.deepEqual([run.delivery.outcome, run.delivery.resumed, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.decision], ["delivered", true, false, true, undefined]);
  assert.deepEqual([run.result.checks.map((check: any) => check.phase), run.result.repairs, run.result.agentInvocations], [["verify"], 0, 1]);
});

test("a resumed run reaches scopeAfterChange without falsify, plan, or planReview", async context => {
  const f = fixture(context); const again = await handOff(f);
  const result = await execute(input(again, {}, { resume: true }), {
    falsify: () => assert.fail(), plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(),
  });
  assert.equal(result.state, "delivered");
  assert.deepEqual(result.states.slice(0, 3), ["shape", "prepare", "scopeAfterChange"]);
  assert.deepEqual(result.states.filter(isPlanning), []);
  assert.deepEqual(evidence(again).result.agents.map((agent: any) => agent.stage), ["review"]);
});

test("a resumed run whose review asks for changes repairs within a fresh budget", async context => {
  const f = fixture(context); const again = await handOff(f); let edits = 0; let reviews = 0;
  const result = await execute(input(again, {}, { resume: true }), {
    investigator: () => assert.fail(),
    implementer: request => { edits++; assert.ok(request.prompt.includes("Current failure/feedback: Explain the greeting")); writeFileSync(join(request.cwd, "greeting.txt"), "hello again\n"); return ok(); },
    reviewer: () => ++reviews === 1 ? review("revise", "Explain the greeting") : review("approved"),
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews], [1, 2]); untouched(f);
  assert.deepEqual(result.states.slice(0, 11), ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "reviewBudget", "change", "scopeAfterChange", "verify"]);
  assert.equal(evidence(again).result.repairs, 0); assert.equal(evidence(again).result.reviewRounds, 1); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello again");
});

/** A commit lands on the base in the source checkout, as when someone merges there while the ticket is under review; returns the new tip. */
function advance(f: Fixture, file = "later.txt", content = "later\n") {
  writeFileSync(join(f.repo, file), content); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", `base: ${file}`);
  return f.head = git(f.repo, "rev-parse", "HEAD");
}
type Candidate = ReturnType<typeof candidate>;
const phases = (run: { result: any }): string[] => run.result.checks.map((check: any) => check.phase);
/** Every ref of the source repository but the ticket branch, the only one a run may move. */
const others = (f: Fixture) => git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(ref => !ref.startsWith(`refs/heads/${branch} `)).join("\n");
/** A reason names a commit by its hash, in full or abbreviated. */
const names = (reason: string, commit: string) => reason.includes(commit.slice(0, 7));
/** No replay and no push is forced, whatever else a run asks Git. */
function unforced(calls: string[]) {
  for (const call of calls.filter(call => /(?:^|\s)(?:rebase|push)(?:\s|$)/u.test(call))) assert.doesNotMatch(call, /(?:^|\s)(?:-f|--force\S*|--no-ff|\+\S+)(?:\s|$)/u);
}
const undone = (calls: string[], onto: string) => calls.some(call => new RegExp(`(?:^|\\s)reset\\s(?:.*\\s)?--mixed\\s(?:.*\\s)?${onto}(?:\\s|$)`, "u").test(call));
const accepted = (states: string[]) => assert.deepEqual(states.slice(0, 3), ["shape", "prepare", "scopeAfterChange"]);
/**
 * The invariant: a run never stops with the workflow's commit on the ticket branch. The worktree holds the candidate as uncommitted changes
 * on that branch, which points at a base commit, the one the run started from or the new tip; no rebase is in progress and no commit is
 * recorded. `except` names the files the new tip brought, in which the candidate cannot be compared with what was reviewed.
 */
function uncommitted(f: Fixture, run: { delivery: any } | undefined, base: string, before: Candidate, except: string[] = []) {
  const now = candidate(f.worktree); const rest = (files: Candidate["files"]) => files.filter(([name]) => !except.includes(String(name)));
  assert.equal(now.status, before.status); assert.match(now.status, /greeting\.txt/u); assert.deepEqual(rest(now.files), rest(before.files));
  assert.equal(git(f.worktree, "diff", "--cached", "--name-only"), "");
  assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
  assert.deepEqual([git(f.worktree, "rev-parse", "HEAD"), git(f.repo, "rev-parse", branch)], [base, base]);
  for (const state of ["rebase-merge", "rebase-apply"]) assert.equal(existsSync(git(f.worktree, "rev-parse", "--path-format=absolute", "--git-path", state)), false, state);
  if (run) assert.deepEqual([run.delivery.commit, run.delivery.baseCommit, run.delivery.worktreeRemoved], [null, base, false]);
}
/** A stop that `rebase` adds parks as every other stop does: through `stuck`, without a Human, under the note's fixed next step, naming the state it stopped in. */
function parkedIn(state: string, f: Fixture, result: { state: unknown; output: any; states: string[] }, reason: RegExp) {
  assert.equal(result.state, "parked"); assert.deepEqual(result.states.slice(-4), [state, "stuck", "park", "parked"]);
  assert.equal(result.states.includes("decide"), false); assert.equal(result.states.includes("failure"), false);
  const run = held(f, result, new RegExp(`^Parked on ${branch}: `, "u"));
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.park.next, run.delivery.decision], ["blocked", "parked", nextStep, undefined]);
  assert.match(run.delivery.reason, reason);
  const note = readFileSync(join(run.directory, "park.txt"), "utf8");
  assert.ok(note.includes(`Stopped in ${state}.`)); assert.ok(note.includes(nextStep));
  assert.ok(note.includes(`Worktree: ${f.worktree}\nBranch: ${branch}\nEvidence: ${run.directory}`));
  assert.ok(result.output.summary.includes(`Worktree kept at ${f.worktree}. Evidence: `));
  return run;
}
/** What `rebasedFrom` records: the base the run started from and the commit approved first, the ticket's own commit on that base. */
function rebasedFrom(f: Fixture, run: { delivery: any }, started: string): string {
  const from = run.delivery.rebasedFrom ?? {};
  assert.deepEqual(Object.keys(from).sort(), ["baseCommit", "commit"]); assert.equal(from.baseCommit, started);
  assert.match(from.commit, /^[0-9a-f]{40,64}$/u); assert.notEqual(from.commit, run.delivery.commit);
  assert.equal(git(f.repo, "rev-parse", `${from.commit}^`), started);
  assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", from.commit), "Add a greeting\nTicket: PROJ-12");
  return from.commit;
}
/** The delivered branch holds exactly the ticket commit above a base tip. */
function onTip(f: Fixture, tip: string) {
  assert.equal(git(f.repo, "rev-list", "--count", `${tip}..${branch}`), "1"); assert.equal(git(f.repo, "rev-parse", `${branch}^`), tip);
  assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", branch), "Add a greeting\nTicket: PROJ-12");
  return git(f.repo, "rev-parse", branch);
}

for (const output of ["branch", "patch", "pr"] as const) {
  test(`a base that moved forward under review gets the approved commit replayed onto its tip, set up, and verified again before ${output} delivery`, async context => {
    const path = process.env.PATH; const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const calls = recordGit(context, f);
    context.after(() => { process.env.PATH = path; });
    const started = f.head; let tip = ""; let refs = "";
    const where = 'const fs = require("fs"); console.log(`later.txt ${fs.existsSync("later.txt")}, greeting.txt ${fs.existsSync("greeting.txt")}`)';
    const result = await execute(input(f, { output, setup: [command(where, { name: "install" })] }), {
      reviewer: request => {
        assert.equal(git(request.cwd, "rev-parse", "HEAD"), started);
        // Two commits land on the base while the candidate is under review. A pull request base is published, as its owner leaves it.
        advance(f); tip = advance(f, "latest.txt"); if (output === "pr") git(f.repo, "push", "-q", "origin", "main");
        refs = others(f); return review();
      },
    });
    assert.equal(result.state, "delivered");
    assert.deepEqual(result.states.slice(result.states.indexOf("reviewResult")), ["reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
    // Exactly the ticket commit lies above the new tip, under the ticket's message, and no other ref moved.
    const commit = onTip(f, tip); const run = held(f, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", branch), "code.txt\ngreeting.test.txt\ngreeting.txt\nlater.txt\nlatest.txt");
    assert.equal(others(f), refs);
    assert.ok(calls().some(call => /(?:^|\s)rebase\s/u.test(call) && call.includes(`--onto ${tip} ${started}`)), "git rebase --onto <tip> <baseCommit>");
    assert.ok(calls().some(call => /(?:^|\s)patch-id\s(?:.*\s)?--stable(?:\s|$)/u.test(call)), "git patch-id --stable");
    unforced(calls());
    // Delivery is of the rebased commit on the tip, and says where the change was approved first.
    assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.delivery.worktreeRemoved], [tip, commit, true]);
    assert.equal(git(f.repo, "show", `${rebasedFrom(f, run, started)}:greeting.txt`), "hello");
    // Setup ran again on the rebased tree, and then the gates as their own phase.
    assert.deepEqual(run.result.checks.map((check: any) => [check.phase, check.name, check.passed]),
      [["setup", "install", true], ["red", "tests", true], ["verify", "tests", true], ["setup", "install", true], ["reverify", "tests", true]]);
    assert.match(readFileSync(run.result.checks[3].log, "utf8"), /later\.txt true, greeting\.txt true/u);
    assert.deepEqual([run.result.outcome, run.result.checksPassed, run.result.repairs, run.result.reviewRounds], ["completed", true, 0, 0]);
    const network = calls().filter(call => /^(?:ls-remote|fetch)\b/u.test(call));
    if (output === "patch") {
      // One patch: the ticket's, not the base's commits with it.
      assert.deepEqual(run.delivery.patches, [join(run.directory, "0001-Add-a-greeting.patch")]); assert.match(readFileSync(run.delivery.patches[0], "utf8"), /\+hello/u);
    }
    if (output !== "pr") { assert.deepEqual(network, []); assert.equal(pushed(), ""); assert.equal(gh(), undefined); return; }
    // The tip was asked about at the remote prepare checked, whose URL was read once; then the rebased commit was pushed there.
    assert.ok(network.length >= 2); for (const call of network) assert.ok(call.includes(`${hosted}.git`), call);
    assert.equal(calls().filter(call => call.startsWith("config --get remote.origin.url")).length, 1);
    assert.deepEqual(calls().filter(call => call.startsWith("push --no-follow-tags")), [`push --no-follow-tags ${hosted}.git ${commit}:refs/heads/${branch}`]);
    assert.equal(pushed(), `refs/heads/main ${tip}\nrefs/heads/${branch} ${commit}`);
    assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "main", "--head", branch]);
  });
}

for (const base of [undefined, "main"]) {
  test(base ? "a named base is resolved by its name, so a source checkout that moves to another branch causes no rebase"
    : "an omitted base follows the source checkout's HEAD, so the approved commit is replayed onto the branch checked out there", async context => {
    const f = fixture(context); const started = f.head; let tip = "";
    const result = await execute(input(f, base ? { base } : {}), {
      reviewer: () => { git(f.repo, "checkout", "-q", "-b", "next"); tip = advance(f); return review(); },
    });
    assert.equal(result.state, "delivered"); assert.deepEqual(result.states.slice(-5), ["commit", "rebase", "deliver", "success", "delivered"]);
    const run = evidence(f);
    assert.deepEqual([git(f.repo, "rev-parse", "main"), git(f.repo, "rev-parse", "next"), git(f.repo, "symbolic-ref", "--short", "HEAD")], [started, tip, "next"]);
    const commit = onTip(f, base ? started : tip);
    assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.result.checksPassed], [base ? started : tip, commit, true]);
    if (base) { assert.deepEqual(phases(run), ["red", "verify"]); assert.equal(run.delivery.rebasedFrom, undefined); return; }
    assert.deepEqual(phases(run), ["red", "verify", "reverify"]); rebasedFrom(f, run, started);
  });
}

for (const [label, move] of [
  ["moved back", (f: Fixture) => { git(f.repo, "reset", "-q", "--hard", "HEAD^"); }],
  ["rewritten", (f: Fixture) => { git(f.repo, "commit", "-q", "--amend", "-m", "base: second.txt, reworded"); }],
  ["left by a source checkout now on a branch that does not hold it", (f: Fixture) => { git(f.repo, "checkout", "-q", "-b", "sideways", "HEAD^"); git(f.repo, "commit", "-q", "--allow-empty", "-m", "sideways"); }],
] as const) {
  test(`a base ${label} under review is not rebased onto: the commit is undone, the run ends blocked for delivery by hand, and a resume is refused`, async context => {
    const f = fixture(context); const started = advance(f, "second.txt", "second\n"); const calls = recordGit(context, f);
    let before: Candidate | undefined; let tip = ""; let refs = "";
    const result = await execute(input(f), {
      reviewer: request => { before = candidate(request.cwd); move(f); tip = f.head = git(f.repo, "rev-parse", "HEAD"); refs = others(f); return review(); },
    });
    // Like other delivery failures it ends by itself, without stuck or a Human.
    assert.equal(result.state, "blocked"); assert.deepEqual(result.states.slice(-5), ["reviewResult", "commit", "rebase", "failure", "blocked"]);
    const run = held(f, result, /^Blocked: /u);
    assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision, phases(run)], ["blocked", "blocked", undefined, ["red", "verify"]]);
    assert.ok(names(run.delivery.reason, started), "the reason names the base the run started from"); assert.ok(names(run.delivery.reason, tip), "the reason names the new tip");
    assert.match(run.delivery.reason, /by hand/iu); assert.ok(result.output.summary.includes(`Worktree kept at ${f.worktree}.`));
    uncommitted(f, run, started, before!); assert.equal(others(f), refs); assert.equal(git(f.repo, "status", "--porcelain", "--untracked-files=all"), "");
    assert.ok(undone(calls(), started), "git reset --mixed <baseCommit>");
    assert.equal(calls().some(call => /(?:^|\s)rebase\s(?:.*\s)?--onto(?:\s|$)/u.test(call)), false);
    // Resume is not promised here: the branch's base is not in the new tip, and adopt refuses it as before, changing nothing.
    const again = next(f, 2);
    const refused = await execute(input(again, {}, { resume: true }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    assert.equal(refused.state, "blocked"); assert.deepEqual(refused.states, ["shape", "prepare", "failure", "blocked"]);
    held(again, refused, /^Blocked: Cannot resume: ticket\/proj-12-add-a-greeting holds 1 commit that is not in the base commit .+ or the base moved back; only an uncommitted candidate is resumed, and nothing was changed\. Evidence: /u);
    uncommitted(f, undefined, started, before!); assert.equal(others(f), refs);
  });
}

test("a conflict in the replay puts the approved candidate back uncommitted on its original base and parks naming the paths and the tip; a resume alone stops there again until a person ports the candidate", async context => {
  const f = fixture(context); const started = f.head; const human = person(); let before: Candidate | undefined; let tip = ""; let refs = "";
  const first = await execute(input(f, {}, { stuck: "park" }), {
    // The base gains a greeting of its own while this one is under review.
    reviewer: request => { before = candidate(request.cwd); tip = advance(f, "greeting.txt", "hi\n"); refs = others(f); return review(); },
  }, human);
  const stopped = (at: Fixture, result: Awaited<ReturnType<typeof execute>>) => {
    const run = parkedIn("rebase", at, result, /greeting\.txt/u); untouched(f);
    assert.ok(names(run.delivery.reason, tip), "the reason names the new tip");
    // The reason says that running again is not enough.
    assert.match(run.delivery.reason, /\bresum/iu); assert.match(run.delivery.reason, /\bport/iu);
    uncommitted(f, run, started, before!); assert.equal(candidate(f.worktree).status, "?? greeting.test.txt\n?? greeting.txt"); assert.equal(others(f), refs);
    return run;
  };
  assert.deepEqual(phases(stopped(f, first)), ["red", "verify"]);
  // A run with resume: true and nothing else is accepted, reaches the same conflict, and leaves the same candidate.
  let again = next(f, 2);
  const second = await execute(input(again, {}, { resume: true, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail() }, human);
  accepted(second.states); stopped(again, second);
  // A person ports the candidate in the worktree: the branch goes to the tip, and this greeting replaces the one the base brought.
  git(f.worktree, "reset", "-q", tip); assert.equal(candidate(f.worktree).status, "M greeting.txt\n?? greeting.test.txt");
  again = next(f, 3);
  const third = await execute(input(again, {}, { resume: true, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail() }, human);
  assert.equal(third.state, "delivered"); accepted(third.states); assert.deepEqual(third.states.slice(-5), ["commit", "rebase", "deliver", "success", "delivered"]);
  const commit = onTip(f, tip); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello");
  assert.deepEqual([phases(evidence(again)), evidence(again).delivery.baseCommit, evidence(again).delivery.commit], [["verify"], tip, commit]);
  assert.deepEqual(human.requests, []);
});

test("a conflict met again after more rounds stops again in the same run, and hand off then leaves the candidate uncommitted, as that choice says", async context => {
  const f = fixture(context); const started = f.head; const human = person("more rounds", "hand off");
  let before: Candidate | undefined; let tip = ""; const prompts: string[] = [];
  const result = await execute(input(f), {
    implementer: request => { prompts.push(request.prompt); return implement(request); },
    reviewer: request => { before = candidate(request.cwd); tip ||= advance(f, "greeting.txt", "hi\n"); return review(); },
  }, human);
  assert.equal(result.state, "handedOff"); assert.deepEqual(result.states.slice(-5), ["rebase", "stuck", "decide", "handOff", "handedOff"]);
  assert.deepEqual(result.states.filter(state => ["commit", "rebase", "decide", "change", "failure"].includes(state)), ["change", "commit", "rebase", "decide", "change", "commit", "rebase", "decide"]);
  // The decision is the one every stop asks, and its choices are unchanged.
  for (const request of human.requests) {
    assert.deepEqual(request.choices, ["more rounds", "hand off", "archive", "discard"]);
    assert.match(request.prompt, /Stopped in rebase\./u); assert.match(request.prompt, /greeting\.txt/u); assert.ok(names(request.prompt, tip));
  }
  assert.match(prompts[1]!.split("Current failure/feedback: ")[1] ?? "", /greeting\.txt/u);
  const run = held(f, result, new RegExp(`^Handed off on ${branch}: `, "u")); untouched(f);
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision, run.delivery.archive], ["blocked", "handed-off", "hand off", undefined]);
  assert.ok(result.output.summary.includes(`Decision: hand off. Worktree kept at ${f.worktree}. Evidence: `));
  uncommitted(f, run, started, before!);
});

test("a tip that already holds the change leaves nothing to replay: the candidate goes back uncommitted on its original base and the run parks saying so, as a resumed run does again", async context => {
  const f = fixture(context); const started = f.head; const human = person(); let before: Candidate | undefined; let tip = ""; let refs = "";
  const first = await execute(input(f, {}, { stuck: "park" }), {
    reviewer: request => {
      before = candidate(request.cwd);
      // The same change reaches the base by another road while this one is under review, after a commit of the base's own.
      advance(f); writeFileSync(join(f.repo, "greeting.test.txt"), readFileSync(join(request.cwd, "greeting.test.txt")));
      tip = advance(f, "greeting.txt", "hello\n"); refs = others(f); return review();
    },
  }, human);
  const stopped = (at: Fixture, result: Awaited<ReturnType<typeof execute>>) => {
    const run = parkedIn("rebase", at, result, /already holds/iu); untouched(f);
    assert.ok(names(run.delivery.reason, tip), "the reason names the tip");
    // Nothing of the tip stays behind in the worktree: the candidate is the one that was approved, on the base it was approved on.
    uncommitted(f, run, started, before!); assert.equal(existsSync(join(f.worktree, "later.txt")), false); assert.equal(others(f), refs);
  };
  stopped(f, first);
  const again = next(f, 2);
  const second = await execute(input(again, {}, { resume: true, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail() }, human);
  accepted(second.states); stopped(again, second); assert.deepEqual(human.requests, []);
});

for (const [label, hook, script] of [
  ["a refusing hook", "pre-rebase", "exit 1"],
  ["a changed subject", "post-rewrite", 'test "$1" = rebase || exit 0\ngit -c core.hooksPath=/dev/null commit --amend -qm changed'],
  ["an extra commit", "post-rewrite", 'test "$1" = rebase || exit 0\ngit -c core.hooksPath=/dev/null commit --allow-empty -qm extra'],
  ["a dirty tracked file", "post-rewrite", 'test "$1" = rebase || exit 0\necho altered > greeting.txt'],
] as const) {
  test(`replay with ${label} conservatively restores the approved candidate, and resumes after the hook is removed`, async context => {
    const f = fixture(context); const started = f.head; let before: Candidate | undefined; let tip = "";
    const path = join(f.repo, ".git/hooks", hook);
    const result = await execute(input(f, {}, { stuck: "park" }), {
      reviewer: request => {
        before = candidate(request.cwd); tip = advance(f);
        writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
        return review();
      },
    });
    const run = parkedIn("rebase", f, result, /Replay onto/u);
    uncommitted(f, run, started, before!); untouched(f);
    assert.ok(names(run.delivery.reason, tip));
    rmSync(path);
    const again = next(f, 2);
    const resumed = await execute(input(again, {}, { resume: true, stuck: "park" }), {
      investigator: () => assert.fail(), implementer: () => assert.fail(),
    });
    assert.equal(resumed.state, "delivered"); accepted(resumed.states); onTip(f, tip);
    assert.deepEqual(phases(evidence(again)), ["verify", "reverify"]);
  });
}

test("setup that switches branches after replay restores only the ticket branch and counts as failed checks", async context => {
  const f = fixture(context); const started = f.head; let before: Candidate | undefined;
  git(f.repo, "branch", "other", started);
  const setup = [command('if (require("fs").existsSync("later.txt")) require("child_process").execFileSync("git", ["checkout", "-q", "other"], { stdio: "ignore" });', { name: "install" })];
  const result = await execute(input(f, { setup }, { stuck: "park" }), {
    reviewer: request => { before = candidate(request.cwd); advance(f); return review(); },
  });
  const run = parkedIn("rebase", f, result, /setup: install.*moved HEAD/u);
  uncommitted(f, run, started, before!); untouched(f);
  assert.equal(run.result.checksPassed, false);
  assert.equal(git(f.repo, "rev-parse", "other"), started);
  const again = next(f, 2);
  const resumed = await execute(input(again, {}, { resume: true, stuck: "park" }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
  });
  assert.equal(resumed.state, "delivered"); accepted(resumed.states); onTip(f, f.head);
});

test("setup leftovers on the new tip fail checks and park uncommitted without asking the implementer to repair them", async context => {
  const f = fixture(context); let tip = "";
  const setup = [command('const fs = require("fs"); if (fs.existsSync("later.txt")) fs.writeFileSync("setup-output.txt", "leftover");', { name: "install" })];
  const result = await execute(input(f, { setup }, { stuck: "park" }), {
    reviewer: () => { tip = advance(f); return review(); },
  });
  const run = parkedIn("rebase", f, result, /setup: install.*unignored/u);
  assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.result.checksPassed], [tip, null, false]);
  assert.equal(git(f.worktree, "rev-parse", "HEAD"), tip);
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
  assert.equal(readFileSync(join(f.worktree, "setup-output.txt"), "utf8"), "leftover");
  assert.equal(result.states.includes("repairBudget"), false);
  rmSync(join(f.worktree, "setup-output.txt"));
  const again = next(f, 2);
  const resumed = await execute(input(again, { setup }, { resume: true, stuck: "park" }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
  });
  assert.equal(resumed.state, "delivered"); accepted(resumed.states); onTip(f, tip);
  assert.deepEqual(phases(evidence(again)), ["verify"]);
});

const numbered = (changed: Record<number, string> = {}) => Array.from({ length: 10 }, (_, index) => `${changed[index + 1] ?? index + 1}\n`).join("");
for (const second of ["approves", "asks for a change", "blocks", "edits the checkout"] as const) {
  test(`a replay whose patch is not the one that was reviewed is undone on the new tip, set up, verified, and reviewed again, where the reviewer ${second}`, async context => {
    const f = fixture(context); const started = advance(f, "lines.txt", numbered()); const human = person();
    let tip = ""; let reviews = 0; let edits = 0; let before: Candidate | undefined;
    const where = 'console.log(require("fs").readFileSync("lines.txt", "utf8").includes("seven") ? "on the new base" : "on the base it started from")';
    const result = await execute(scoped(input(f, { setup: [command(where, { name: "install" })] }, { stuck: "park" }), "lines.txt"), {
      implementer: request => {
        if (++edits === 2) assert.match(request.prompt, /Current failure\/feedback: Greet the new base too/u);
        if (edits === 1) writeFileSync(join(request.cwd, "lines.txt"), numbered({ 5: "five" }));
        writeFileSync(join(request.cwd, "greeting.txt"), edits === 1 ? "hello\n" : "hello again\n"); return ok();
      },
      reviewer: request => {
        // The base changes a line two below the ticket's: the replay applies cleanly, but its patch is no longer the one this review read.
        if (++reviews === 1) { tip = advance(f, "lines.txt", numbered({ 7: "seven" })); return review(); }
        if (reviews > 2) return review();
        // The candidate is uncommitted again, now on the new tip, with the base's change beside its own.
        assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(git(request.cwd, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
        assert.equal(candidate(request.cwd).status, "M lines.txt\n?? greeting.test.txt\n?? greeting.txt");
        assert.equal(readFileSync(join(request.cwd, "lines.txt"), "utf8"), numbered({ 5: "five", 7: "seven" }));
        if (second === "edits the checkout") writeFileSync(join(request.cwd, "greeting.txt"), "unreviewed\n");
        before = candidate(request.cwd);
        return second === "asks for a change" ? review("revise", "Greet the new base too") : second === "blocks" ? ok("blocked", "The new base contradicts the ticket") : review();
      },
    }, human);
    untouched(f); assert.deepEqual(human.requests, []);
    const run = evidence(f); const again = ["commit", "rebase", "verify", "sealReview", "review", "reviewResult"];
    // It is not a stop: the run goes from rebase straight back to verify and a fresh review, and nothing is verified as `reverify`.
    assert.deepEqual(result.states.slice(result.states.indexOf("commit"), result.states.indexOf("commit") + again.length), again);
    assert.deepEqual(run.result.checks.slice(0, 5).map((check: any) => [check.phase, check.name, check.passed]),
      [["setup", "install", true], ["red", "tests", true], ["verify", "tests", true], ["setup", "install", true], ["verify", "tests", true]]);
    assert.match(readFileSync(run.result.checks[3].log, "utf8"), /on the new base/u); assert.equal(phases(run).includes("reverify"), false);
    if (second === "blocks" || second === "edits the checkout") {
      // The fresh review stops the run as any review does, with the candidate uncommitted on the new tip.
      const stop = parkedIn("reviewResult", f, result, second === "blocks" ? /contradicts the ticket/u : /read-only stage/u); assert.equal(reviews, 2);
      uncommitted(f, stop, tip, before!);
      // A reviewer that edits the checkout after the re-review leaves no passing verdict behind, as one that edits before any commit.
      if (second === "edits the checkout") { assert.equal(stop.result.checksPassed, false); return; }
      const later = next(f, 2);
      const resumed = await execute(scoped(input(later, {}, { resume: true, stuck: "park" }), "lines.txt"), { investigator: () => assert.fail(), implementer: () => assert.fail() }, human);
      assert.equal(resumed.state, "delivered"); accepted(resumed.states); onTip(f, tip); assert.deepEqual(phases(evidence(later)), ["verify"]);
      return;
    }
    assert.equal(result.state, "delivered"); assert.equal(result.states.includes("stuck"), false);
    assert.deepEqual(result.states.slice(-5), ["commit", "rebase", "deliver", "success", "delivered"]);
    const revised = second === "asks for a change";
    assert.deepEqual(result.states.filter(state => ["change", "commit", "rebase", "reviewBudget", "repairBudget"].includes(state)),
      revised ? ["change", "commit", "rebase", "reviewBudget", "change", "commit", "rebase"] : ["change", "commit", "rebase", "commit", "rebase"]);
    // The second verdict is the one delivered, on the tip; the receipt keeps the base the run started from and the commit approved first.
    const commit = onTip(f, tip);
    assert.equal(git(f.repo, "show", `${branch}:lines.txt`), numbered({ 5: "five", 7: "seven" }).trim()); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), revised ? "hello again" : "hello");
    assert.deepEqual([run.delivery.outcome, run.delivery.baseCommit, run.delivery.commit], ["delivered", tip, commit]);
    const first = rebasedFrom(f, run, started);
    assert.equal(git(f.repo, "show", `${first}:lines.txt`), numbered({ 5: "five" }).trim()); assert.equal(git(f.repo, "show", `${first}:greeting.txt`), "hello");
    // Reviewing again uses neither budget.
    assert.deepEqual([reviews, edits, run.result.checksPassed, run.result.repairs, run.result.reviewRounds], revised ? [3, 2, true, 0, 1] : [2, 1, true, 0, 0]);
  });
}

const greetsLater = 'const fs = require("fs"); if (fs.existsSync("later.txt") && !fs.readFileSync("greeting.txt", "utf8").includes("later")) { console.log("greeting.txt does not mention later.txt"); process.exit(1); }';
for (const [label, extra] of [
  ["is repaired within the budget", {}],
  ["parks on a spent budget, and a resumed run repairs it", { maxRepairs: 0, stuck: "park" }],
  ["waits on a spent budget, and more rounds repair it", { maxRepairs: 0 }],
] as const) {
  test(`gates that fail on the rebased tree are a gate failure on the new base: the commit is undone there and the failure ${label}`, async context => {
    const f = fixture(context); const started = f.head; const parks = "stuck" in extra; const asks = "maxRepairs" in extra && !parks;
    const human = person(...(asks ? ["more rounds"] : [])); const checks = [command(), command(greetsLater, { name: "later-gate" })];
    let tip = ""; let reviews = 0; let before: Candidate | undefined; const prompts: string[] = [];
    const agents = {
      implementer: (request: Request) => {
        if (prompts.push(request.prompt) === 1) return implement(request);
        // Back with the implementer: the candidate is uncommitted on the new tip, and the failed gate is named.
        assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(candidate(request.cwd).status, "?? greeting.test.txt\n?? greeting.txt");
        assert.ok(existsSync(join(request.cwd, "later.txt")));
        assert.match(request.prompt.split("Current failure/feedback: ")[1] ?? "", /later-gate/u);
        writeFileSync(join(request.cwd, "greeting.txt"), "hello later\n"); return ok();
      },
      reviewer: (request: Request) => { if (++reviews === 1) { before = candidate(request.cwd); tip = advance(f); } return review(); },
    };
    let at = f; let result = await execute(input(f, { checks }, extra), agents, human);
    const failed = [["red", "tests", true], ["verify", "tests", true], ["verify", "later-gate", true], ["reverify", "tests", true], ["reverify", "later-gate", false]];
    const evidenced = (run: { result: any }) => run.result.checks.map((check: any) => [check.phase, check.name, check.passed]);
    if (parks) {
      const stop = parkedIn("repairBudget", f, result, /Repair budget exhausted \(0\)\..*later-gate/su); untouched(f);
      // The tree on the tip did not pass, and the receipt does not say it did.
      assert.equal(stop.result.checksPassed, false); assert.deepEqual(evidenced(stop), failed); assert.equal(prompts.length, 1);
      uncommitted(f, stop, tip, before!, ["later.txt"]); assert.equal(readFileSync(join(f.worktree, "later.txt"), "utf8"), "later\n");
      at = next(f, 2);
      result = await execute(input(at, { checks }, { resume: true, maxRepairs: 1, stuck: "park" }), { ...agents, investigator: () => assert.fail() }, human);
      accepted(result.states);
    }
    assert.equal(result.state, "delivered"); untouched(f); assert.equal(prompts.length, 2);
    const run = held(at, result, /^Delivered/u); const commit = onTip(f, tip);
    assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello later"); assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", branch), "code.txt\ngreeting.test.txt\ngreeting.txt\nlater.txt");
    assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.result.outcome, run.result.checksPassed], [tip, commit, "completed", true]);
    // The second rebase finds the branch on the tip and goes on to delivery.
    assert.deepEqual(result.states.slice(-5), ["commit", "rebase", "deliver", "success", "delivered"]);
    if (parks) { assert.deepEqual(phases(run), ["verify", "verify", "verify", "verify"]); assert.deepEqual(human.requests, []); return; }
    assert.deepEqual(result.states.slice(result.states.indexOf("commit")), ["commit", "rebase", "repairBudget", ...(asks ? ["stuck", "decide"] : []), "repairTarget", "change",
      "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
    // verify ran the gates on the new base, so they are not run a second time as `reverify`.
    assert.deepEqual(evidenced(run), [...failed, ["verify", "tests", true], ["verify", "later-gate", true]]);
    assert.equal(git(f.repo, "show", `${rebasedFrom(f, run, started)}:greeting.txt`), "hello");
    if (!asks) { assert.deepEqual([run.result.repairs, reviews], [1, 2]); return; }
    assert.match(human.requests[0]!.prompt, /Stopped in repairBudget\./u); assert.match(human.requests[0]!.prompt, /later-gate/u);
    assert.ok(human.requests[0]!.prompt.includes("Repair rounds used: 0 of 0.")); assert.equal(run.delivery.decision, "more rounds");
  });
}

for (const policy of ["park", "ask"] as const) {
  test(`a setup command that fails on the new tip is not the implementer's to repair: the commit is undone there and the run ${policy === "park" ? "parks naming the command, and a resumed run delivers on the tip" : "waits for a decision, where archive keeps the candidate on the tip"}`, async context => {
    const f = fixture(context); const human = person(...(policy === "ask" ? ["archive"] : [])); const calls = recordGit(context, f);
    let tip = ""; let before: Candidate | undefined; let edits = 0;
    const setup = [command('process.exit(require("fs").existsSync("later.txt") ? 3 : 0)', { name: "install" })];
    const result = await execute(input(f, { setup }, { stuck: policy }), {
      implementer: request => { edits++; return implement(request); },
      reviewer: request => { before = candidate(request.cwd); tip = advance(f); return review(); },
    }, human);
    assert.equal(edits, 1); assert.equal(result.states.includes("repairBudget"), false); assert.ok(undone(calls(), tip), "git reset --mixed <tip>");
    if (policy === "ask") {
      assert.deepEqual(result.states.slice(result.states.indexOf("rebase")), ["rebase", "stuck", "decide", "archive", "remove", "abandon", "abandoned"]);
      assert.match(human.requests[0]!.prompt, /Stopped in rebase\./u); assert.match(human.requests[0]!.prompt, /\binstall\b/u);
      const run = abandoned(f, result, "archive");
      // The archive is the candidate as delivery would have committed it, on the tip it was left on.
      assert.equal(git(f.repo, "rev-parse", `${archiveBranch}^`), tip); assert.equal(git(f.repo, "show", "--name-only", "--format=", archiveBranch), "greeting.test.txt\ngreeting.txt");
      assert.deepEqual([run.delivery.archive, run.delivery.baseCommit, run.result.checksPassed], [{ branch: archiveBranch, commit: git(f.repo, "rev-parse", archiveBranch) }, tip, false]);
      return;
    }
    const run = parkedIn("rebase", f, result, /\binstall\b/u); untouched(f);
    // A failed setup on the tip is a failed check: nothing passed on that tree.
    assert.equal(run.result.checksPassed, false);
    assert.deepEqual(run.result.checks.map((check: any) => [check.phase, check.name, check.passed]), [["setup", "install", true], ["red", "tests", true], ["verify", "tests", true], ["setup", "install", false]]);
    uncommitted(f, run, tip, before!, ["later.txt"]); assert.deepEqual(human.requests, []);
    // A resumed run does not set up again; it verifies and reviews the candidate on the tip and delivers there.
    const again = next(f, 2);
    const second = await execute(input(again, { setup }, { resume: true, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail() }, human);
    assert.equal(second.state, "delivered"); accepted(second.states); const commit = onTip(f, tip);
    assert.deepEqual([phases(evidence(again)), evidence(again).delivery.baseCommit, evidence(again).delivery.commit, evidence(again).result.checksPassed], [["verify"], tip, commit, true]);
  });
}

test("a pr run whose base moved to a tip that is not published puts the candidate back on its original base and parks saying the base must be pushed first, asking the remote that prepare recorded", async context => {
  const path = process.env.PATH; const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const calls = recordGit(context, f);
  context.after(() => { process.env.PATH = path; });
  // A second repository that does hold the later commit: a check that read the remote's configuration again would ask it and go on.
  const other = join(f.root, "other.git"); git(f.root, "init", "-q", "--bare", "-b", "main", other); git(f.repo, "push", "-q", other, "main");
  const elsewhere = "https://example.invalid/acme/elsewhere.git"; git(f.repo, "config", `url.${other}.insteadOf`, elsewhere);
  const started = f.head; const human = person(); let before: Candidate | undefined; let tip = ""; let refs = "";
  const first = await execute(input(f, { output: "pr" }, { stuck: "park" }), {
    implementer: request => { git(request.cwd, "remote", "set-url", "origin", elsewhere); return implement(request); },
    reviewer: request => { before = candidate(request.cwd); tip = advance(f); git(f.repo, "push", "-q", other, "main"); refs = others(f); return review(); },
  }, human);
  const run = parkedIn("rebase", f, first, /pushed first/iu); untouched(f);
  uncommitted(f, run, started, before!); assert.equal(others(f), refs);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(git(other, "for-each-ref", "--format=%(refname) %(objectname)"), `refs/heads/main ${tip}`);
  const network = calls().filter(call => /^(?:ls-remote|fetch)\b/u.test(call));
  assert.ok(network.length >= 2); for (const call of network) assert.ok(call.includes(`${hosted}.git`) && !call.includes(elsewhere), call);
  assert.equal(calls().filter(call => call.startsWith("config --get remote.origin.url")).length, 1);
  assert.equal(calls().some(call => call.startsWith("push --no-follow-tags")), false); unforced(calls());
  // Once the base is pushed, a resumed run rebases, verifies again, and opens the pull request on the tip.
  git(f.repo, "remote", "set-url", "origin", `${hosted}.git`); git(f.repo, "push", "-q", "origin", "main");
  const again = next(f, 2);
  const second = await execute(input(again, { output: "pr" }, { resume: true, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail() }, human);
  assert.equal(second.state, "delivered"); accepted(second.states); const commit = onTip(f, tip);
  assert.deepEqual([phases(evidence(again)), evidence(again).delivery.baseCommit], [["verify", "reverify"], tip]); rebasedFrom(f, evidence(again), started);
  assert.equal(pushed(), `refs/heads/main ${tip}\nrefs/heads/${branch} ${commit}`); assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "main", "--head", branch]);
  assert.deepEqual(human.requests, []);
});

test("the tip is looked for on the pull request base prepare recorded, the remote's default branch, whatever the local branch is called", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const bare = join(f.root, "remote.git");
  git(f.repo, "push", "-q", "origin", "main:trunk"); git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk"); const started = f.head; let tip = "";
  const result = await execute(input(f, { output: "pr" }, { stuck: "park" }), {
    // The later commit is published on trunk, the pull request base, and not on the remote branch that shares the local one's name.
    reviewer: () => { tip = advance(f); git(f.repo, "push", "-q", "origin", "main:trunk"); return review(); },
  });
  assert.equal(result.state, "delivered"); untouched(f); const commit = onTip(f, tip); rebasedFrom(f, evidence(f), started);
  assert.equal(pushed(), `refs/heads/${branch} ${commit}\nrefs/heads/trunk ${tip}`); assert.equal(git(bare, "rev-parse", "main"), started);
  assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "trunk", "--head", branch]);
});

for (const output of ["branch", "pr"] as const) {
  test(`a resumed run whose branch is behind a base that moved forward verifies, is approved, and is rebased onto the later commit before it delivers a ${output === "pr" ? "pull request" : "branch"}`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const again = await handOff(f);
    // Someone commits to the base branch while the ticket is stuck. A pull request needs that commit on the remote, so it is published first.
    const older = f.head; advance(f); if (output === "pr") git(f.repo, "push", "-q", "origin", "main");
    const result = await execute(input(again, { output }, { resume: true }), {
      investigator: () => assert.fail(), implementer: () => assert.fail(),
      reviewer: request => { assert.deepEqual(readdirSync(request.cwd).sort(), [".git", "code.txt", "greeting.test.txt", "greeting.txt"]); return review("approved", "Greeting matches the ticket"); },
    });
    assert.equal(result.state, "delivered");
    assert.deepEqual(result.states, ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
    const commit = onTip(f, f.head);
    const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", branch), "code.txt\ngreeting.test.txt\ngreeting.txt\nlater.txt");
    assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.delivery.resumed, run.delivery.worktreeRemoved], [f.head, commit, true, true]);
    // The base this run started from is the commit its branch was on.
    rebasedFrom(f, run, older);
    assert.deepEqual([run.result.outcome, run.result.checksPassed, phases(run)], ["completed", true, ["verify", "reverify"]]);
    if (output !== "pr") { assert.equal(pushed(), ""); assert.equal(gh(), undefined); return; }
    assert.equal(pushed(), `refs/heads/main ${f.head}\nrefs/heads/${branch} ${commit}`); assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "main", "--head", branch]);
  });
}

test("a resumed pr run whose branch is behind a later base commit that is not published parks with the candidate uncommitted on the older commit, and pushes nothing", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const again = await handOff(f); const human = person();
  // The commit the candidate was made from is on the remote, so prepare goes on; the later one is local only.
  const older = f.head; const tip = advance(f); let before: Candidate | undefined;
  const result = await execute(input(again, { output: "pr" }, { resume: true, stuck: "park" }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: request => { before = candidate(request.cwd); return review(); },
  }, human);
  accepted(result.states);
  const run = parkedIn("rebase", again, result, /pushed first/iu); untouched(f);
  uncommitted(f, run, older, before!); assert.deepEqual([run.delivery.resumed, phases(run)], [true, ["verify"]]);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(git(f.repo, "rev-parse", "main"), tip); assert.deepEqual(human.requests, []);
});

/** The worktree and recorded branch an earlier run of the ticket left, without a candidate. */
const linked = (f: Fixture) => { git(f.repo, "worktree", "add", "-q", "-b", branch, f.worktree); git(f.repo, "config", `branch.${branch}.ticket`, "proj-12"); };
const noRecord = (name: string, ticket = "proj-12") => new RegExp(`^Blocked: Cannot resume: HEAD in .+ is on ${name}, which has ${literal(unsettled(name, ticket))} Evidence: `, "u");
for (const [label, arrange, reason] of [
  ["a missing worktree", () => {}, /worktree directory .+ does not exist; nothing was changed/u],
  ["a directory that is not a Git worktree", (f: Fixture) => { mkdirSync(f.worktree, { recursive: true }); writeFileSync(join(f.worktree, "greeting.txt"), "hello\n"); }, /is not a Git worktree of .+; nothing was changed/u],
  ["a checkout of another repository", (f: Fixture) => { mkdirSync(f.worktree, { recursive: true }); git(f.worktree, "init", "-q", "-b", branch); }, /is not a Git worktree of .+; nothing was changed/u],
  ["a worktree whose HEAD left the ticket branch", (f: Fixture) => { linked(f); git(f.worktree, "checkout", "-q", "--detach"); }, /HEAD in .+ is not on a branch of this ticket, ticket\/proj-12 or ticket\/proj-12-<title>; nothing was changed/u],
  ["a worktree on another branch", (f: Fixture) => { git(f.repo, "branch", branch); git(f.repo, "worktree", "add", "-q", "-b", "other", f.worktree); }, /HEAD in .+ is not on a branch of this ticket, .+; nothing was changed/u],
  ["a worktree on the branch of a ticket whose id only starts the same", (f: Fixture) => { git(f.repo, "worktree", "add", "-q", "-b", "ticket/proj-120-add-a-greeting", f.worktree); }, /HEAD in .+ is not on a branch of this ticket, .+; nothing was changed/u],
  ["a worktree on a branch recorded for another ticket", (f: Fixture) => { linked(f); git(f.repo, "config", `branch.${branch}.ticket`, "proj"); }, /HEAD in .+ is on ticket\/proj-12-add-a-greeting, which belongs to ticket proj; nothing was changed/u],
  ["a worktree on a branch recorded for this ticket under a name that is not the ticket's", (f: Fixture) => { git(f.repo, "branch", branch); git(f.repo, "worktree", "add", "-q", "-b", "other", f.worktree); git(f.repo, "config", "branch.other.ticket", "proj-12"); }, /HEAD in .+ is not on a branch of this ticket, .+; nothing was changed/u],
  ["a worktree on a branch of this ticket's name that has no record", (f: Fixture) => { git(f.repo, "worktree", "add", "-q", "-b", branch, f.worktree); }, noRecord(branch)],
  ["a worktree on the unrecorded branch of a ticket whose id extends this one with a '-'", (f: Fixture) => { git(f.repo, "worktree", "add", "-q", "-b", "ticket/proj-12-1", f.worktree); }, noRecord("ticket/proj-12-1")],
  ["a ticket branch that holds a commit of its own", (f: Fixture) => { linked(f); implement({ cwd: f.worktree }); git(f.worktree, "add", "."); git(f.worktree, "commit", "-qm", "earlier commit"); },
    /ticket\/proj-12-add-a-greeting holds 1 commit that is not in the base commit .+; only an uncommitted candidate is resumed, and nothing was changed/u],
  ["a ticket branch that holds commits of its own behind a base that moved forward", (f: Fixture) => {
    linked(f); for (const subject of ["earlier commit", "another"]) git(f.worktree, "commit", "-q", "--allow-empty", "-m", subject);
    git(f.repo, "commit", "-q", "--allow-empty", "-m", "later"); f.head = git(f.repo, "rev-parse", "HEAD");
  }, /ticket\/proj-12-add-a-greeting holds 2 commits that are not in the base commit .+; only an uncommitted candidate is resumed, and nothing was changed/u],
  ["a ticket branch that points somewhere unrelated to the base", (f: Fixture) => {
    linked(f); git(f.worktree, "reset", "-q", "--hard", git(f.repo, "commit-tree", "-m", "unrelated", git(f.repo, "rev-parse", "HEAD^{tree}")));
  }, /ticket\/proj-12-add-a-greeting shares no history with the base commit .+; nothing was changed/u],
] as const) {
  test(`resume with ${label} blocks without changing anything`, async context => {
    const f = fixture(context); arrange(f);
    const snapshot = () => [git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), git(f.repo, "worktree", "list", "--porcelain"),
      existsSync(f.worktree) ? readdirSync(f.worktree) : null, existsSync(join(f.worktree, "greeting.txt")) ? readFileSync(join(f.worktree, "greeting.txt"), "utf8") : null];
    const before = snapshot();
    const result = await execute(input(f, { setup: [command("process.exit(1)")] }, { resume: true }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["shape", "prepare", "failure", "blocked"]); untouched(f);
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
  blocked(f, await execute(input(f, {}, { redGreen: false }), { implementer: () => ok() }), /Nothing to commit/u);
});

test("nested run evidence is never committed, and a worktree that cannot be removed is not reported as delivered", async context => {
  const f = fixture(context);
  const result = await execute(input(f, { output: "patch" }), {
    implementer: request => { mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/nested.json"), "{}"); return implement(request); },
  });
  const run = blocked(f, result, /worktree could not be removed after delivering .+; inspect .+git-worktree\.log/u, 1);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
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
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt"); assert.equal(evidence(f).delivery.worktreeRemoved, true);
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
  const run = blocked(f, await execute(input(f, { output: "pr" })), /moved HEAD or ticket\/proj-12-add-a-greeting away from the approved commit/u);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(run.delivery.commit, null);
});

test("the pull request is opened in the pushed repository whatever GH_REPO says, with a message-only review in its body", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  const bin = join(f.root, "bin");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\nprintf '%s' "$GH_REPO" > "${bin}/gh-repo"\necho ${url}\n`, { mode: 0o755 });
  process.env.GH_REPO = "someone/else"; context.after(() => { delete process.env.GH_REPO; });
  const result = await execute(input(f, { output: "pr" }), { reviewer: () => ({ ...review(), summary: undefined, message: "Prose-only approval" }) });
  assert.equal(result.state, "delivered");
  assert.deepEqual(gh()!.slice(2, 4), ["--repo", slug]); assert.equal(readFileSync(join(bin, "gh-repo"), "utf8"), "");
  const body = readFileSync(join(evidence(f).directory, "pull-request.md"), "utf8");
  assert.match(body, /Prose-only approval/u); assert.doesNotMatch(body, /undefined/u);
});

test("a remote that names no hosted repository blocks pr delivery before pushing", async context => {
  const f = fixture(context); const gh = fakeGh(context, f);
  const bare = join(f.root, "remote.git"); git(f.root, "init", "-q", "--bare", "-b", "main", bare); git(f.repo, "remote", "add", "origin", bare);
  git(f.repo, "push", "-q", "origin", "main");
  blocked(f, await execute(input(f, { output: "pr" })), /does not name a hosted owner\/repository/u, 1);
  assert.equal(git(bare, "for-each-ref", "--format=%(refname)"), "refs/heads/main"); assert.equal(gh(), undefined);
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

test("a remote reconfigured after the base was checked gets neither the push nor the pull request", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  // A second repository that would take the push just as well, and holds the same published base.
  const other = join(f.root, "other.git"); git(f.root, "init", "-q", "--bare", "-b", "main", other); git(f.repo, "push", "-q", other, "main");
  const elsewhere = "https://example.invalid/acme/elsewhere.git"; git(f.repo, "config", `url.${other}.insteadOf`, elsewhere);
  const result = await execute(input(f, { output: "pr" }), {
    implementer: request => { git(request.cwd, "remote", "set-url", "origin", elsewhere); git(request.cwd, "remote", "add", "upstream", elsewhere); return implement(request); },
  });
  assert.equal(result.state, "delivered"); assert.equal(git(f.repo, "config", "--get", "remote.origin.url"), elsewhere);
  const commit = git(f.repo, "rev-parse", branch);
  assert.equal(pushed(), `refs/heads/${branch} ${commit}`); assert.equal(git(other, "for-each-ref", "--format=%(refname)"), "refs/heads/main");
  assert.deepEqual(gh()!.slice(0, 4), ["pr", "create", "--repo", slug]);
});

for (const [base, forget] of [["release", ["branch", "-D", "release"]], ["origin/release", ["update-ref", "-d", "refs/remotes/origin/release"]]] as const) {
  test(`a pull request base given as ${base} stays the branch that was checked when that ref is gone before delivery`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
    // release is ahead of main on the remote, so a pull request against the default branch would carry its commit.
    git(f.repo, "checkout", "-q", "-b", "release"); git(f.repo, "commit", "-q", "--allow-empty", "-m", "released"); git(f.repo, "push", "-q", "origin", "release");
    const release = git(f.repo, "rev-parse", "release"); git(f.repo, "checkout", "-q", "main");
    const result = await execute(input(f, { output: "pr", base }), { implementer: request => { git(request.cwd, ...forget); return implement(request); } });
    assert.equal(result.state, "delivered"); untouched(f);
    assert.throws(() => git(f.repo, "rev-parse", "--verify", "--quiet", `${base}^{commit}`));
    // rebase has no tip to compare the base commit with, so it goes on to delivery as the candidate was approved, with nothing verified again.
    assert.deepEqual(result.states.slice(-5), ["commit", "rebase", "deliver", "success", "delivered"]);
    assert.deepEqual([phases(evidence(f)), evidence(f).delivery.baseCommit, evidence(f).delivery.rebasedFrom], [["red", "verify"], release, undefined]);
    const commit = git(f.repo, "rev-parse", branch); assert.equal(git(f.repo, "rev-parse", `${branch}^`), release);
    assert.deepEqual(pushed().split("\n"), [`refs/heads/release ${release}`, `refs/heads/${branch} ${commit}`]);
    assert.deepEqual(gh()!.slice(0, 9), ["pr", "create", "--repo", slug, "--draft", "--base", "release", "--head", branch]);
  });
}

test("pr delivery pushes no tag even when Git is configured to follow tags", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f);
  git(f.repo, "config", "push.followTags", "true"); git(f.repo, "tag", "-am", "release", "v1");
  const result = await execute(input(f, { output: "pr" }));
  assert.equal(result.state, "delivered"); assert.equal(pushed(), `refs/heads/${branch} ${git(f.repo, "rev-parse", branch)}`);
});

test("a failing push blocks, keeps the committed local branch, and never starts gh", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  // The remote answers the question prepare asks about the base and then refuses the push.
  mkdirSync(join(f.root, "remote.git/hooks"), { recursive: true }); writeFileSync(join(f.root, "remote.git/hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = await execute(input(f, { output: "pr" }));
  const run = blocked(f, result, /git push failed; inspect .+git-push\.log/u, 1);
  assert.equal(run.delivery.commit, git(f.repo, "rev-parse", branch)); assert.equal(run.delivery.prUrl, undefined);
  assert.match(readFileSync(join(run.directory, "git-push.log"), "utf8"), /pre-receive hook declined/u); assert.equal(pushed(), ""); assert.equal(gh(), undefined);
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

test("the id slug replaces characters outside its alphabet and names the branch, ahead of the title, and the worktree", async context => {
  const f = fixture(context);
  const result = await execute({ ...input(f), ticket: { ...input(f).ticket, id: "Bug #7/a", title: "  Tidy\n the  greeting " } });
  assert.equal(result.state, "delivered");
  assert.deepEqual([evidence(f).delivery.branch, evidence(f).delivery.worktree], ["ticket/bug--7-a-tidy-the-greeting", join(f.root, "worktrees", "widgets--bug--7-a")]);
  assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", "ticket/bug--7-a-tidy-the-greeting"), "Tidy the greeting\nTicket: Bug #7/a");
});

test("the title slug is lowercase runs of letters and digits joined by '-', cut to 48 characters at a '-'", () => {
  for (const [title, slug] of [
    ["Add a greeting", "add-a-greeting"],
    ["Gate GitHub issue intake on a trusted author", "gate-github-issue-intake-on-a-trusted-author"],
    ["  --Fix: `foo()` / bar_baz (v2.1)!  ", "fix-foo-bar-baz-v2-1"],
    ["¡¿…?!", ""], ["日本語", ""],
    ["a".repeat(48), "a".repeat(48)],
    // The cut falls inside "publication", so the slug ends at the word before it.
    ["Make ticket branches, pull request text, and publication safer to read and trust", "make-ticket-branches-pull-request-text-and"],
    // Here the 48th character ends a word, which is kept whole.
    [`${"abc ".repeat(11)}abcd efgh`, `${"abc-".repeat(11)}abcd`],
    [`${"abc ".repeat(11)}abcde fgh`, "abc-".repeat(11).slice(0, -1)],
    // A first word past the limit has no '-' to cut at, so nothing remains.
    ["x".repeat(60), ""], [`${"x".repeat(49)} greeting`, ""], [`${"x".repeat(48)} greeting`, "x".repeat(48)],
  ] as const) {
    assert.equal(mod.titleSlug(title), slug, title);
    assert.ok(slug.length <= 48); assert.doesNotMatch(slug, /^-|-$|--/u);
  }
});

for (const [label, title, named] of [
  ["a long title is cut at a word", "Make ticket branches, pull request text, and publication safer to read and trust", "ticket/proj-12-make-ticket-branches-pull-request-text-and"],
  ["a title with no usable characters leaves the id alone", "¡¿…?!", "ticket/proj-12"],
  ["a title whose first word is too long to cut at a '-' leaves the id alone", `${"x".repeat(60)} greeting`, "ticket/proj-12"],
] as const) {
  test(`${label} in the branch name`, async context => {
    const f = fixture(context);
    const result = await execute({ ...input(f), ticket: { ...input(f).ticket, id: "PROJ-12", title } });
    assert.equal(result.state, "delivered"); untouched(f);
    assert.deepEqual([evidence(f).delivery.branch, evidence(f).delivery.worktree], [named, f.worktree]);
    assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), `main\n${named}`);
    assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", named), `${title}\nTicket: PROJ-12`);
  });
}

test("a ticket is not blocked by the branches of a ticket whose id only starts with its own", async context => {
  const f = fixture(context);
  const others = ["ticket/proj-10-add-a-greeting", "ticket/proj-12", "ticket/proj-12-add-a-greeting", "ticket/proj-1.5-add-a-greeting", "ticket/proj-1x"];
  for (const name of others) git(f.repo, "branch", name);
  const result = await execute({ ...input(f), ticket: { ...input(f).ticket, id: "PROJ-1", title: "Add a greeting" } });
  assert.equal(result.state, "delivered"); untouched(f);
  assert.equal(evidence(f).delivery.branch, "ticket/proj-1-add-a-greeting");
  assert.equal(git(f.repo, "show", "--name-only", "--format=", "ticket/proj-1-add-a-greeting"), "greeting.test.txt\ngreeting.txt");
  for (const name of others) assert.equal(git(f.repo, "rev-parse", name), f.head);
});

const record = (f: Fixture, name: string) => git(f.repo, "config", "--local", "--get", `branch.${name}.ticket`);
const next = (f: Fixture, run: number) => ({ ...f, evidence: join(f.root, `evidence-${run}`) });

test("tickets whose ids differ by a '-' extension keep separate branches, told apart by the id slug recorded with each", async context => {
  const f = fixture(context);
  const first = await execute({ ...input(f), ticket: { ...input(f).ticket, id: "PROJ", title: "12 tidy" } });
  assert.equal(first.state, "delivered"); assert.equal(record(f, "ticket/proj-12-tidy"), "proj");
  // By name alone, ticket/proj-12-tidy would read as PROJ-12 titled "tidy".
  const second = await execute(input(next(f, 2)));
  assert.equal(second.state, "delivered"); assert.equal(evidence(next(f, 2)).delivery.branch, branch); assert.equal(record(f, branch), "proj-12");
  for (const [run, ticket, found] of [[3, { id: "PROJ", title: "Add a greeting" }, "ticket/proj-12-tidy"], [4, { id: "PROJ-12", title: "Tidy" }, branch]] as const) {
    const again = await execute({ ...input(next(f, run)), ticket: { ...input(f).ticket, ...ticket } }, { investigator: () => assert.fail() });
    assert.equal(again.state, "blocked");
    held(next(f, run), again, new RegExp(`^Blocked: Branch ${found} already exists in .+ for this ticket; nothing was changed`, "u"));
  }
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), `main\n${branch}\nticket/proj-12-tidy`); untouched(f);
});

test("a ticket whose id and title spell the name of another ticket's branch is blocked, and that branch is left alone", async context => {
  const f = fixture(context);
  assert.equal((await execute(input(f))).state, "delivered"); const commit = git(f.repo, "rev-parse", branch);
  const result = await execute({ ...input(next(f, 2)), ticket: { ...input(f).ticket, id: "PROJ", title: "12: add a greeting" } }, { investigator: () => assert.fail() });
  assert.equal(result.state, "blocked"); untouched(f);
  held(next(f, 2), result, /^Blocked: Branch ticket\/proj-12-add-a-greeting already exists in .+ for ticket proj-12, whose id and title spell the name this ticket would take; nothing was changed/u);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short) %(objectname)"), `main ${f.head}\n${branch} ${commit}`);
  assert.equal(existsSync(join(f.root, "worktrees", "widgets--proj")), false);
});

test("a branch without a record that may be this ticket's under an earlier title blocks it, and a ticket with a shorter id, until its record says whose it is", async context => {
  const f = fixture(context); const agents = { investigator: () => assert.fail() };
  // Made by hand: PROJ-12 under an earlier title, or PROJ titled "12 an earlier title".
  const earlier = "ticket/proj-12-an-earlier-title"; git(f.repo, "branch", earlier);
  const refs = () => git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"); const before = refs();
  for (const [run, id, ticket] of [[1, "PROJ-12", "proj-12"], [2, "PROJ", "proj"]] as const) {
    const result = await execute({ ...input(next(f, run)), ticket: { ...input(f).ticket, id, title: "Add a greeting" } }, agents);
    assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["shape", "prepare", "failure", "blocked"]); untouched(f);
    assert.ok(result.output.summary.startsWith(`Blocked: Branch ${earlier} already exists in ${f.repo} with ${unsettled(earlier, ticket)} Evidence: `), result.output.summary);
    assert.equal(refs(), before); assert.equal(existsSync(join(f.root, "worktrees")), false); assert.throws(() => record(f, earlier));
  }
  // Recorded for PROJ-12, it blocks that ticket as its own branch and no longer concerns PROJ.
  git(f.repo, "config", `branch.${earlier}.ticket`, "proj-12");
  const own = await execute(input(next(f, 3)), agents);
  held(next(f, 3), own, /^Blocked: Branch ticket\/proj-12-an-earlier-title already exists in .+ for this ticket; nothing was changed\. Deliver or delete it/u);
  const shorter = await execute({ ...input(next(f, 4)), ticket: { ...input(f).ticket, id: "PROJ", title: "Add a greeting" } });
  assert.equal(shorter.state, "delivered"); untouched(f);
  assert.equal(evidence(next(f, 4)).delivery.branch, "ticket/proj-add-a-greeting"); assert.equal(record(f, "ticket/proj-add-a-greeting"), "proj");
  assert.equal(git(f.repo, "rev-parse", earlier), f.head);
});

test("branches without a record that may be those of tickets with longer ids block a ticket one by one, until each record says whose it is", async context => {
  const f = fixture(context); const ticket = { ...input(f).ticket, id: "PROJ", title: "Add a greeting" };
  // None holds a ticket commit. For PROJ each may be its own: titled "12", "12 1", or "12 add a greeting".
  const others = [["ticket/proj-12", "proj-12"], ["ticket/proj-12-1", "proj-12-1"], ["ticket/proj-12-add-a-greeting", "proj-12"]] as const;
  for (const [name] of others) git(f.repo, "branch", name);
  for (const [index, [name, whose]] of others.entries()) {
    const result = await execute({ ...input(next(f, index)), ticket: { ...input(f).ticket, ...ticket } }, { investigator: () => assert.fail() });
    assert.equal(result.state, "blocked"); untouched(f);
    assert.ok(result.output.summary.startsWith(`Blocked: Branch ${name} already exists in ${f.repo} with ${unsettled(name, "proj")} Evidence: `), result.output.summary);
    assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), ["main", ...others.map(([other]) => other)].join("\n"));
    git(f.repo, "config", `branch.${name}.ticket`, whose);
  }
  const result = await execute({ ...input(next(f, 3)), ticket });
  assert.equal(result.state, "delivered"); untouched(f);
  assert.equal(evidence(next(f, 3)).delivery.branch, "ticket/proj-add-a-greeting");
  for (const [name] of others) assert.equal(git(f.repo, "rev-parse", name), f.head);
});

for (const [name, made] of [["ticket/proj-12", "before branches carried a title or a record"], [branch, "by a run whose record did not come along"]] as const) {
  test(`a delivered ${name} without a record, made ${made}, is told by the ticket commit it holds and blocks that ticket alone`, async context => {
    const f = fixture(context);
    assert.equal((await execute(input(f))).state, "delivered");
    if (name !== branch) git(f.repo, "branch", "-m", branch, name);
    git(f.repo, "config", "--unset", `branch.${name}.ticket`); assert.throws(() => record(f, name));
    const commit = git(f.repo, "rev-parse", name); assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", name), "Add a greeting\nTicket: PROJ-12");
    const own = await execute({ ...input(next(f, 2)), ticket: { ...input(f).ticket, id: "PROJ-12", title: "A later title" } }, { investigator: () => assert.fail() });
    held(next(f, 2), own, new RegExp(`^Blocked: Branch ${name} already exists in .+ for this ticket; nothing was changed`, "u"));
    // By its name the branch could be PROJ's under a title starting with 12; the commit says it is PROJ-12's, so only the name itself is taken.
    const same = await execute({ ...input(next(f, 3)), ticket: { ...input(f).ticket, id: "PROJ", title: name === branch ? "12: add a greeting" : "12" } }, { investigator: () => assert.fail() });
    held(next(f, 3), same, new RegExp(`^Blocked: Branch ${name} already exists in .+ for ticket proj-12, whose id and title spell the name this ticket would take; nothing was changed`, "u"));
    const shorter = await execute({ ...input(next(f, 4)), ticket: { ...input(f).ticket, id: "PROJ", title: "Tidy" } });
    assert.equal(shorter.state, "delivered"); untouched(f);
    assert.equal(evidence(next(f, 4)).delivery.branch, "ticket/proj-tidy"); assert.equal(git(f.repo, "rev-parse", name), commit);
  });
}

test("a commit that names a ticket does not give that ticket a branch its id and title would not name", async context => {
  const f = fixture(context);
  // The base itself is the merged commit of PROJ-12, and a branch cut from it by hand holds that commit without being that ticket's.
  git(f.repo, "commit", "-q", "--allow-empty", "-m", "Add a greeting", "-m", "Ticket: PROJ-12"); f.head = git(f.repo, "rev-parse", "HEAD");
  const cut = "ticket/proj-12-tidy"; git(f.repo, "branch", cut);
  const result = await execute({ ...input(f), ticket: { ...input(f).ticket, id: "PROJ-12", title: "A later title" } }, { investigator: () => assert.fail() });
  assert.equal(result.state, "blocked"); untouched(f);
  assert.ok(result.output.summary.startsWith(`Blocked: Branch ${cut} already exists in ${f.repo} with ${unsettled(cut)} Evidence: `), result.output.summary);
});

test("a ticket retitled after its run is blocked by the branch that run made, and resumes on it", async context => {
  const f = fixture(context); const earlier = "ticket/proj-12-an-earlier-title";
  const ticket = { ...input(f).ticket, id: "PROJ-12", title: "An earlier title" };
  const first = await execute({ ...input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), ticket }, { reviewer: () => review("revise", "Handle the empty case") }, person("hand off"));
  assert.equal(first.state, "handedOff"); assert.equal(record(f, earlier), "proj-12"); assert.equal(git(f.worktree, "symbolic-ref", "--short", "HEAD"), earlier);
  const second = await execute(input(next(f, 2)), { investigator: () => assert.fail() });
  held(next(f, 2), second, /^Blocked: Branch ticket\/proj-12-an-earlier-title already exists in .+ for this ticket; nothing was changed/u);
  const resumed = await execute(input(next(f, 3), {}, { resume: true }), { investigator: () => assert.fail(), implementer: () => assert.fail() });
  assert.equal(resumed.state, "delivered"); untouched(f);
  assert.equal(evidence(next(f, 3)).delivery.branch, earlier); assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), `main\n${earlier}`);
  assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", earlier), "Add a greeting\nTicket: PROJ-12"); assert.equal(git(f.repo, "show", `${earlier}:greeting.txt`), "hello");
});

test("a resumed run does not adopt an unrecorded branch that could be that of a ticket with a longer id, until its record says whose it is", async context => {
  const f = fixture(context); const ticket = { ...input(f).ticket, id: "PROJ", title: "Add a greeting" };
  const worktree = join(f.root, "worktrees", "widgets--proj");
  // In PROJ's own worktree directory: PROJ-12's branch from before branches carried a title, then one that is PROJ-12 titled "tidy" or PROJ titled "12 tidy".
  git(f.repo, "worktree", "add", "-q", "-b", "ticket/proj-12", worktree); git(f.repo, "branch", "ticket/proj-12-tidy"); implement({ cwd: worktree });
  const agents = { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() };
  for (const [run, name] of [[1, "ticket/proj-12"], [2, "ticket/proj-12-tidy"]] as const) {
    git(worktree, "checkout", "-q", name);
    const refs = git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const result = await execute({ ...input(next(f, run), {}, { resume: true }), ticket }, agents);
    assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["shape", "prepare", "failure", "blocked"]); untouched(f);
    assert.match(result.output.summary, noRecord(name, "proj")); assert.ok(result.output.summary.includes(`HEAD in ${worktree} is on ${name}, `));
    assert.equal(git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), refs); assert.equal(readFileSync(join(worktree, "greeting.txt"), "utf8"), "hello\n");
  }
  git(f.repo, "config", "branch.ticket/proj-12-tidy.ticket", "proj");
  const resumed = await execute({ ...input(next(f, 3), {}, { resume: true }), ticket }, { investigator: () => assert.fail(), implementer: () => assert.fail() });
  assert.equal(resumed.state, "delivered"); untouched(f);
  assert.equal(evidence(next(f, 3)).delivery.branch, "ticket/proj-12-tidy"); assert.equal(git(f.repo, "show", "--name-only", "--format=", "ticket/proj-12-tidy"), "greeting.txt");
  assert.equal(git(f.repo, "rev-parse", "ticket/proj-12"), f.head);
});

for (const [name, made] of [["ticket/proj-12", "before branches carried a title or a record"], ["ticket/proj-12-an-earlier-title", "by a run under an earlier title"]] as const) {
  test(`a resumed run adopts ${name}, the branch its worktree is on, made ${made}, instead of naming one from the title`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
    git(f.repo, "worktree", "add", "-q", "-b", name, f.worktree); implement({ cwd: f.worktree });
    if (name !== "ticket/proj-12") git(f.repo, "config", `branch.${name}.ticket`, "proj-12");
    const result = await execute(input(f, { output: "pr" }, { resume: true }), { investigator: () => assert.fail(), implementer: () => assert.fail() });
    assert.equal(result.state, "delivered"); untouched(f);
    const commit = git(f.repo, "rev-parse", name);
    const run = held(f, result, new RegExp(`^Delivered ${name} at ${commit}, pull request `, "u"));
    assert.deepEqual([run.delivery.branch, run.delivery.resumed, run.delivery.commit], [name, true, commit]);
    assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), `main\n${name}`);
    assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", name), "Add a greeting\nTicket: PROJ-12");
    assert.equal(pushed(), `refs/heads/${name} ${commit}`); assert.deepEqual(gh()!.slice(5, 9), ["--base", "main", "--head", name]);
  });
}

for (const [label, body, summary] of [
  ["no body", undefined, undefined],
  ["a body that is only its heading", "# Add a greeting\n\n", undefined],
  ["a heading and several paragraphs", "\n# Add a greeting\n\n## Why\n\nWrite hello to greeting.txt,\nand nothing else.\n\nA second paragraph.\n\n## Acceptance criteria\n\n- A file.\n", "Write hello to greeting.txt,\nand nothing else."],
  ["a heading straight after its first paragraph", "# Add a greeting\nWrite hello to greeting.txt,\nand nothing else.\n## Acceptance criteria\n- A file.\n\n### Notes\nNone.\n", "Write hello to greeting.txt,\nand nothing else."],
] as const) {
  test(`a ticket with ${label} ${summary ? "summarizes its first paragraph in the pull request" : "blocks before delivery"}`, async context => {
    const f = fixture(context); remote(f); fakeGh(context, f);
    const result = await execute({ ...input(f, { output: "pr" }), ticket: { ...input(f).ticket, id: "PROJ-12", title: "Add a greeting", body: body === undefined || summary === undefined ? body : `${body}\n${input(f).ticket.body}` } });
    if (summary === undefined) {
      assert.equal(result.state, "blocked");
      const run = held(f, result, /^Blocked: Ticket body is missing required sections or non-empty lists: Goal, Scope, Acceptance, Forbidden\. Expected shape:/u);
      assert.equal(run.delivery.reason.split(" Expected shape:")[0], "Ticket body is missing required sections or non-empty lists: Goal, Scope, Acceptance, Forbidden.");
      for (const heading of ["Goal", "Scope", "Acceptance", "Forbidden"]) assert.ok(run.delivery.reason.includes(`## ${heading}`));
      assert.equal(existsSync(f.worktree), false); assert.equal(evidence(f).result.agentInvocations, 0);
      assert.equal(existsSync(join(evidence(f).directory, "pull-request.md")), false); return;
    }
    assert.equal(result.state, "delivered");
    assert.equal(readFileSync(join(evidence(f).directory, "pull-request.md"), "utf8"),
      `Add a greeting\n\n${summary ? `## Summary\n\n${summary}\n\n` : ""}## Checks\n\n- tests: passed\n\n## Review\n\nGreeting matches the ticket\n\nTicket: PROJ-12\n`);
  });
}

const report = (outcome: string, summary: string) => ({ ...review(outcome, summary), summary: undefined, message: JSON.stringify({ outcome, summary }, null, 2) });

test("a review returned as a JSON object is written as prose in the pull request body and the stage report", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f);
  const result = await execute(input(f, { output: "pr" }), { reviewer: () => report("approved", "Greeting matches the ticket.\n\nNo findings.") });
  assert.equal(result.state, "delivered");
  const run = evidence(f);
  assert.equal(readFileSync(join(run.directory, "pull-request.md"), "utf8"),
    "Add a greeting\n\n## Summary\n\nWrite hello to greeting.txt.\n\n## Checks\n\n- tests: passed\n\n## Review\n\nGreeting matches the ticket.\n\nNo findings.\n\nTicket: PROJ-12\n");
  const stage = { stage: "review", outcome: "approved", summary: "Greeting matches the ticket.\n\nNo findings." };
  // The review is the last report, whatever the states before it reported.
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, `agent-${run.result.agents.length}.json`), "utf8")), stage); assert.deepEqual(run.result.agents.at(-1), stage);
});

test("a review that is a JSON object without a summary never reaches the pull request body", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f);
  const result = await execute(input(f, { output: "pr" }), { reviewer: () => ({ ...review(), summary: undefined, message: '{"outcome":"approved","findings":[]}' }) });
  assert.equal(result.state, "delivered");
  const body = readFileSync(join(evidence(f).directory, "pull-request.md"), "utf8");
  assert.match(body, /## Review\n\nThe reviewer approved this change without a written summary; its report is kept with the run evidence\.\n\nTicket: PROJ-12\n$/u);
  assert.doesNotMatch(body, /[{}]|findings/u);
  assert.equal(evidence(f).result.agents.at(-1).summary, '{"outcome":"approved","findings":[]}');
});

test("review findings returned as a JSON object reach the implementer and the Human as prose", async context => {
  const f = fixture(context); const human = person("hand off"); const prompts: string[] = [];
  const result = await execute(input(f, {}, { maxRepairs: 1, maxReviewRounds: 1 }), {
    implementer: request => { prompts.push(request.prompt); return implement(request); }, reviewer: () => report("revise", "Handle the empty case"),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(1\)\. Handle the empty case/u, human);
  assert.ok(prompts[1]!.endsWith("Current failure/feedback: Handle the empty case\nBlocker: Handle the empty case (greeting.txt:1)"));
  assert.equal(run.delivery.reason, "Review budget exhausted (1). Handle the empty case\nBlocker: Handle the empty case (greeting.txt:1)");
  assert.ok(result.output.summary.startsWith(`Handed off on ${branch}: Review budget exhausted (1). Handle the empty case Blocker: Handle the empty case (greeting.txt:1). Decision: hand off.`));
  assert.deepEqual(run.result.agents.filter((agent: any) => agent.stage === "review").map((agent: any) => agent.summary), ["Handle the empty case", "Handle the empty case"]);
});

/** Local commits on the base that the remote has never been sent. */
function ahead(f: Fixture, commits: number) {
  for (let made = 0; made < commits; made++) git(f.repo, "commit", "-q", "--allow-empty", "-m", `unpublished ${made}`);
  f.head = git(f.repo, "rev-parse", "HEAD");
}

for (const [commits, count] of [[1, /Base HEAD has 1 unpublished local commit that is not in the default branch main on origin, /u], [2, /Base HEAD has 2 unpublished local commits that are not in the default branch main on origin, /u]] as const) {
  test(`a pr run whose base is ${commits} ahead of the remote blocks before any Agent and publishes nothing`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); ahead(f, commits);
    // The remote-tracking ref claims the base is published; only the remote itself knows.
    git(f.repo, "update-ref", "refs/remotes/origin/main", f.head);
    // A resumed run would push as well, so it is asked the same question about the commit its branch is on, and its worktree is left as it was.
    if (commits === 2) linked(f);
    const refs = git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const result = await execute(input(f, { output: "pr" }, { resume: commits === 2 }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["shape", "prepare", "failure", "blocked"]); untouched(f);
    const run = held(f, result, count);
    assert.match(result.output.summary, /and the pull request would carry them\. The base must be pushed first; nothing was changed\. Evidence: /u);
    assert.deepEqual([run.delivery.outcome, run.delivery.worktreeCreated, run.delivery.commit, run.result.agentInvocations], ["blocked", false, null, 0]);
    assert.equal(git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), refs); assert.equal(existsSync(f.worktree), commits === 2);
    assert.doesNotMatch(result.output.summary, /Worktree kept/u); assert.equal(run.delivery.resumed, undefined);
    assert.equal(pushed(), ""); assert.equal(gh(), undefined);
  });
}

test("a named pull request base is compared with that branch on the remote, and must exist there", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f);
  git(f.repo, "branch", "release"); git(f.repo, "push", "-q", "origin", "release");
  git(f.repo, "checkout", "-q", "release"); ahead(f, 3); git(f.repo, "checkout", "-q", "main"); f.head = git(f.repo, "rev-parse", "HEAD");
  const published = pushed();
  const agents = { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() };
  const behind = await execute(input(f, { output: "pr", base: "release" }), agents);
  held(f, behind, /^Blocked: Base release has 3 unpublished local commits that are not in release on origin, .+ must be pushed first/u);
  git(f.repo, "branch", "local-only");
  const missing = await execute(input({ ...f, evidence: join(f.root, "evidence-missing") }, { output: "pr", base: "local-only" }), agents);
  assert.match(missing.output.summary, /^Blocked: The pull request base local-only on origin does not exist, so the base cannot be shown to be published\. Push it first/u);
  assert.deepEqual([behind.states, missing.states], [["shape", "prepare", "failure", "blocked"], ["shape", "prepare", "failure", "blocked"]]);
  assert.equal(pushed(), published); assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "local-only\nmain\nrelease"); untouched(f);
});

test("a pr run whose remote cannot be reached blocks before any Agent with the saved log", async context => {
  const f = fixture(context); const gh = fakeGh(context, f);
  git(f.repo, "remote", "add", "origin", join(f.root, "no-such-remote.git"));
  const result = await execute(input(f, { output: "pr" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "blocked"); assert.deepEqual(result.states, ["shape", "prepare", "failure", "blocked"]); untouched(f);
  const run = held(f, result, /^Blocked: Remote origin could not be reached to check that the base is published; nothing was changed; inspect .+git-ls-remote\.log/u);
  assert.match(readFileSync(join(run.directory, "git-ls-remote.log"), "utf8"), /no-such-remote\.git/u);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main"); assert.equal(existsSync(f.worktree), false); assert.equal(gh(), undefined);
});

test("a pr run proceeds when its base is on the remote, also behind a tip the repository never fetched", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f);
  const other = join(f.root, "other"); git(f.root, "clone", "-q", join(f.root, "remote.git"), other);
  git(other, "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-q", "--allow-empty", "-m", "published by someone else");
  git(other, "push", "-q", "origin", "main");
  const tip = git(other, "rev-parse", "HEAD");
  assert.throws(() => git(f.repo, "cat-file", "-e", tip));
  const refs = git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)");
  const result = await execute(input(f, { output: "pr" }));
  assert.equal(result.state, "delivered"); untouched(f);
  const commit = git(f.repo, "rev-parse", branch);
  assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
  assert.deepEqual(pushed().split("\n"), [`refs/heads/main ${tip}`, `refs/heads/${branch} ${commit}`]);
  // Reading the remote's tip moved no local ref and left no FETCH_HEAD behind.
  assert.equal(git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), `${refs.replace("refs/remotes", `refs/heads/${branch} ${commit}\nrefs/remotes`)}`);
  assert.equal(existsSync(join(f.repo, ".git/FETCH_HEAD")), false);
});

for (const output of ["branch", "patch", "pr"]) {
  test(`${output} delivery ${output === "pr" ? "asks the remote about the base before anything else" : "never queries the remote, whatever the base holds"}`, async context => {
    const f = fixture(context); const pushed = remote(f); ahead(f, 2); const calls = recordGit(context, f);
    const result = await execute(input(f, { output }));
    const network = calls().filter(call => /^(?:ls-remote|fetch|push|pull|clone|remote)\b/u.test(call));
    assert.ok(calls().some(call => call.startsWith("rev-parse --verify --quiet HEAD^{commit}")));
    assert.equal(pushed(), "");
    if (output === "pr") {
      assert.equal(result.state, "blocked");
      assert.deepEqual(network, [`ls-remote --symref ${hosted}.git HEAD`]); assert.equal(calls().some(call => call.startsWith("worktree add")), false);
      return;
    }
    assert.equal(result.state, "delivered"); assert.deepEqual(network, []);
    assert.equal(git(f.repo, "rev-list", "--count", `origin/main..${branch}`), "3");
  });
}

test("ticketSections counts a list that starts at a different indent after a sub-heading or a paragraph", () => {
  const body = "## Goal\nG\n## Scope\n- s\n## Forbidden\n- f\n## Acceptance\n- one\n\n### Group B\n  - two\n  - three\n\nA paragraph between lists.\n    - four\n";
  assert.deepEqual(mod.ticketSections(body).acceptance, ["one", "two", "three", "four"]);
});


for (const policy of ["park", undefined]) {
  for (const cause of ["implementer", "gates", "review budget", "reviewer", "discussion", "criterion", "falsify drift", "plan drift", "planReview drift", "review drift"]) {
    test(`${policy ?? "default"} stuck policy parks on ${cause} without a Human and preserves the candidate`, async context => {
      const f = fixture(context); const human = person(); let before: unknown; let reviews = 0;
      const reason = cause === "gates" ? /Repair budget exhausted \(0\)/u : cause === "review budget" ? /Review budget exhausted \(0\)/u
        : cause === "discussion" ? /Which locale\?/u : cause === "criterion" ? /criteria remain unmet: greeting.txt contains hello/u
          : cause.endsWith("drift") ? /read-only stage/u : /Specify the greeting language/u;
      const data = input(f, { checks: [command(cause === "gates" ? "process.exit(1)" : undefined)] }, {
        maxRepairs: 0, maxReviewRounds: cause === "review budget" ? 0 : 2,
      });
      if (policy === undefined) Reflect.deleteProperty(data, "stuck"); else data.stuck = policy;
      // A read-only state that edits is stopped by the guard behind it, so nothing later runs and no candidate is written.
      const early = isPlanning(cause.split(" ")[0]!);
      const reading = (state: string): Runner => request => {
        if (cause === `${state} drift`) { writeFileSync(join(request.cwd, "code.txt"), `${state} edit`); before = candidate(request.cwd); }
        return planning[state]!.answer(request);
      };
      const result = await execute(data, {
        falsify: reading("falsify"), plan: reading("plan"), planReview: reading("planReview"),
        tester: request => { assert.equal(early, false); return tester(request); },
        implementer: request => {
          assert.equal(early, false); implement(request); before = candidate(request.cwd);
          return ok(cause === "implementer" ? "blocked" : "completed", "Specify the greeting language");
        },
        reviewer: request => {
          reviews++;
          if (cause === "review drift") { writeFileSync(join(request.cwd, "greeting.txt"), "review edit"); before = candidate(request.cwd); return review(); }
          if (cause === "discussion") return review("approved", "Owner question", { findings: [{ severity: "discussion", text: "Which locale?", where: "greeting.txt:1" }] });
          if (cause === "criterion") return review("approved", "Still unmet", { criteria: [{ text: criterion, met: false, evidence: "greeting.txt:1" }], newSinceLastRound: "none" });
          return cause === "review budget" ? review("revise", "Specify the greeting language") : ok("blocked", "Specify the greeting language");
        },
      }, human);
      const run = parked(f, result, reason, human); assert.deepEqual(candidate(f.worktree), before);
      assert.equal(candidate(f.worktree).status.includes("greeting.txt"), !early);
      if (early) assert.deepEqual(result.states.filter(isPlanning), upTo(cause.split(" ")[0]!));
      if (cause === "discussion" || cause === "criterion") assert.equal(reviews, 2);
      assert.deepEqual(run.delivery.park.budgets, {
        repairs: { used: 0, max: 0 }, reviewRounds: { used: cause === "discussion" || cause === "criterion" ? 1 : 0, max: cause === "review budget" ? 0 : 2 },
      });
    });
  }
}

test("parking caps a long blocker consistently in the receipt, note, and hold summary", async context => {
  const f = fixture(context); const human = person(); let before: unknown;
  const reason = `Specify the greeting language.\n${"More context.\n".repeat(230)}`.trim();
  const result = await execute(input(f, {}, { stuck: "park" }), {
    reviewer: request => { before = candidate(request.cwd); return ok("blocked", reason); },
  }, human);
  const run = parked(f, result, /Specify the greeting language/u, human);
  const needs = `Clarify how to resolve this blocker: ${reason.replace(/\s+/gu, " ")}`.slice(0, 600) + "…";
  assert.equal(run.delivery.park.needs, needs);
  assert.equal(run.delivery.reason, reason);
  assert.equal(Object.keys(run.delivery)[0], "schemaVersion");
  const note = readFileSync(join(run.directory, "park.txt"), "utf8");
  assert.equal(note.split("\n").find(line => line.startsWith("Needs: ")), `Needs: ${needs}`);
  assert.equal(result.output.summary, `Parked on ${branch}: ${note.split("\n")[0]} Needs: ${needs} Worktree kept at ${f.worktree}. Evidence: ${run.directory}`);
  assert.deepEqual(candidate(f.worktree), before);
});

for (const exhausted of ["review", "gates"]) {
  test(`${exhausted} budget exhausts independently after two retries of the other kind`, async context => {
    const f = fixture(context); const human = person(); let edits = 0; let reviews = 0; let before: unknown;
    const result = await execute(input(f, { checks: [command('process.exit(require("fs").readFileSync("greeting.txt", "utf8") === "fail" ? 1 : 0)')] }, {
      stuck: "park", maxRepairs: exhausted === "gates" ? 2 : 3, maxReviewRounds: exhausted === "review" ? 2 : 3,
    }), {
      implementer: request => {
        edits++;
        writeFileSync(join(request.cwd, "greeting.txt"), (exhausted === "review" ? edits <= 2 : edits >= 3) ? "fail" : "hello\n");
        before = candidate(request.cwd); return ok();
      },
      reviewer: () => review("revise", `Finding ${++reviews}`),
    }, human);
    const run = parked(f, result, exhausted === "review" ? /Review budget exhausted \(2\)/u : /Repair budget exhausted \(2\)/u, human);
    assert.match(run.delivery.park.needs, /^Explain how to resolve the remaining findings: /u);
    assert.deepEqual([edits, reviews], [5, exhausted === "review" ? 3 : 2]);
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [2, 2]);
    assert.deepEqual(run.delivery.park.budgets, {
      repairs: { used: 2, max: exhausted === "gates" ? 2 : 3 }, reviewRounds: { used: 2, max: exhausted === "review" ? 2 : 3 },
    });
    assert.deepEqual(run.result.checks.map(check => check.passed), exhausted === "review" ? [true, false, false, true, true, true] : [true, true, true, false, false, false]);
    assert.deepEqual(candidate(f.worktree), before);
  });
}

test("a parked candidate resumes with fresh budgets and an approving reviewer delivers it", async context => {
  const f = fixture(context); const human = person();
  const first = await execute(input(f, {}, { stuck: "park", maxReviewRounds: 0 }), { reviewer: () => review("revise", "Which language?") }, human);
  parked(f, first, /Review budget exhausted \(0\)/u, human);
  const again = { ...f, evidence: join(f.root, "evidence-resumed") };
  const data = input(again, { setup: [command("process.exit(1)")] }, { resume: true, stuck: "park" });
  data.ticket.body += "\n\nThe greeting language is English.";
  const result = await execute(data, {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => { assert.match(request.prompt, /The greeting language is English/u); assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), "hello\n"); return review(); },
  }, human);
  assert.equal(result.state, "delivered");
  assert.deepEqual(result.states, ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  const run = held(again, result, /^Delivered/u); untouched(f);
  assert.deepEqual([run.result.repairs, run.result.reviewRounds, run.delivery.resumed, run.delivery.worktreeRemoved], [0, 0, true, true]);
  assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello");
  assert.equal(existsSync(f.worktree), false); assert.deepEqual(human.requests, []);
});

for (const extra of [{ stuck: "wait" }, { stuck: null }, ...[null, -1, 6, 1.5, "2"].map(maxReviewRounds => ({ maxReviewRounds }))]) {
  test(`invalid stuck policy or review budget ${JSON.stringify(extra)} fails before effects`, context => {
    const f = fixture(context);
    assert.throws(() => mod.default(runtime, input(f, {}, extra)));
    assert.deepEqual(readdirSync(f.root), ["widgets"]);
  });
}

test("redGreen false skips the tester and red, hands the approved plan to the implementer, and still checks implementation scope", async context => {
  const f = fixture(context); let prompt = "";
  const result = await execute(input(f, {}, { redGreen: false }), { tester: () => assert.fail(), implementer: request => { prompt = request.prompt; return implement(request); } });
  assert.equal(result.state, "delivered");
  assert.equal(result.states.includes("test"), false); assert.equal(result.states.includes("red"), false);
  // The approved plan goes straight to the implementer.
  assert.deepEqual(result.states.slice(0, result.states.indexOf("change")).filter(isPlanning), ["falsify", "plan", "planReview"]);
  assert.ok(planIn(prompt).startsWith(`${plan}\n`));
  assert.ok(result.states.includes("scopeAfterChange"));
  const run = evidence(f);
  assert.deepEqual(run.result.checks.map(check => check.phase), ["verify"]);
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-1.json"), "utf8")), { stage: "change", changed: ["greeting.txt"], outside: [] });
});

for (const fixes of [false, true]) {
  test(`already passing tests return to the tester and ${fixes ? "deliver after repair" : "park when repairs exhaust"}`, async context => {
    const f = fixture(context); let tests = 0; let edits = 0;
    const result = await execute(input(f, {}, { maxRepairs: 1, stuck: "park" }), {
      tester: request => {
        if (++tests > 1) assert.match(request.prompt, /red: tests passed; the tests do not yet test anything new/u);
        if (fixes && tests > 1) return tester(request);
        writeFileSync(join(request.cwd, "greeting.test.txt"), "// no assertion yet\n"); return ok();
      },
      implementer: request => { edits++; assert.equal(tests, 2); return implement(request); },
    });
    assert.deepEqual([tests, edits], [2, fixes ? 1 : 0]);
    assert.deepEqual(result.states.slice(result.states.indexOf("test")).slice(0, 8), ["test", "scopeAfterTest", "red", "repairBudget", "repairTarget", "test", "scopeAfterTest", "red"]);
    const run = fixes ? held(f, result, /^Delivered/u) : parked(f, result, /Repair budget exhausted \(1\).*tests passed/u, { requests: [] });
    assert.equal(result.state, fixes ? "delivered" : "parked");
    assert.deepEqual(run.result.checks.filter(check => check.phase === "red").map(check => [check.expected, check.passed]), [["nonzero exit", false], ["nonzero exit", fixes]]);
    assert.equal(run.result.repairs, 1);
  });
}

for (const evidenceOnly of [false, true]) {
  test(`a tester changing ${evidenceOnly ? "only .machine-runs" : "nothing"} cannot prove red`, async context => {
    const f = fixture(context);
    const result = await execute(input(f, { checks: [command("process.exit(1)")] }, { maxRepairs: 0, stuck: "park" }), {
      tester: request => {
        if (evidenceOnly) { mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/test.json"), "{}"); }
        return ok();
      }, implementer: () => assert.fail(),
    });
    parked(f, result, /the tester changed nothing/u, { requests: [] });
    assert.ok(result.states.includes("red"));
  });
}

test("tester scope violations return to the tester before red or implementation", async context => {
  const f = fixture(context); let tests = 0; let edits = 0;
  const result = await execute(input(f, {}, { maxRepairs: 1 }), {
    tester: request => {
      if (++tests === 1) writeFileSync(join(request.cwd, "outside.test.txt"), "outside");
      else { assert.match(request.prompt, /Paths outside the ticket Scope after test: "outside.test.txt"\. Scope: greeting.txt, greeting.test.txt/u); rmSync(join(request.cwd, "outside.test.txt")); }
      assert.equal(edits, 0); return tester(request);
    },
    implementer: request => { edits++; assert.equal(tests, 2); return implement(request); },
  });
  assert.equal(result.state, "delivered"); assert.equal(edits, 1);
  assert.deepEqual(result.states.slice(result.states.indexOf("test")).slice(0, 7), ["test", "scopeAfterTest", "repairBudget", "repairTarget", "test", "scopeAfterTest", "red"]);
  const run = evidence(f);
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-1.json"), "utf8")), { stage: "test", changed: ["greeting.test.txt", "outside.test.txt"], outside: ["outside.test.txt"] });
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-2.json"), "utf8")), { stage: "test", changed: ["greeting.test.txt"], outside: [] });
});

test("implementation scope violations return to the implementer and record both rounds", async context => {
  const f = fixture(context); let edits = 0; let tests = 0;
  const result = await execute(input(f, {}, { maxRepairs: 1 }), {
    tester: request => { tests++; return tester(request); },
    implementer: request => {
      if (++edits === 1) writeFileSync(join(request.cwd, "other.txt"), "outside");
      else { assert.match(request.prompt, /Paths outside the ticket Scope after change: "other.txt"/u); rmSync(join(request.cwd, "other.txt")); }
      return implement(request);
    },
  });
  assert.equal(result.state, "delivered"); assert.deepEqual([tests, edits], [1, 2]);
  const run = evidence(f);
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-2.json"), "utf8")), { stage: "change", changed: ["greeting.test.txt", "greeting.txt", "other.txt"], outside: ["other.txt"] });
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-3.json"), "utf8")), { stage: "change", changed: ["greeting.test.txt", "greeting.txt"], outside: [] });
  assert.equal(result.states.filter(state => state === "verify").length, 1);
});

for (const allowed of ["code.txt", "renamed file.txt"]) {
  test(`scope checks both rename names when ${allowed} is allowed`, async context => {
    const f = fixture(context); const data = input(f, {}, { redGreen: false, maxRepairs: 0, stuck: "park" });
    data.ticket.body = data.ticket.body.replace("## Scope\n", `## Scope\n- ${allowed}\n`);
    const result = await execute(data, { implementer: request => { git(request.cwd, "mv", "code.txt", "renamed file.txt"); return implement(request); } });
    const outside = allowed === "code.txt" ? "renamed file.txt" : "code.txt";
    const run = parked(f, result, /Paths outside the ticket Scope/u, { requests: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-1.json"), "utf8")), { stage: "change", changed: ["code.txt", "greeting.txt", "renamed file.txt"], outside: [outside] });
  });
}

test("scope status preserves spaces, newlines, and literal quotes in paths", async context => {
  const f = fixture(context); const name = ' a\n"b".txt ';
  const result = await execute(input(f, {}, { redGreen: false, maxRepairs: 0, stuck: "park" }), {
    implementer: request => { writeFileSync(join(request.cwd, name), "outside"); return implement(request); },
  });
  const run = parked(f, result, /Paths outside the ticket Scope/u, { requests: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-1.json"), "utf8")).outside, [name]);
});

test("missing named red checks fail construction while redGreen false needs no named check", context => {
  const f = fixture(context);
  assert.throws(() => mod.default(runtime, input(f, { redCheck: "acceptance" })), /missing check: acceptance/u);
  assert.throws(() => mod.default(runtime, input(f, { checks: [command(undefined, { name: "types" })] })), /missing check: tests/u);
  assert.doesNotThrow(() => mod.default(runtime, input(f, { redCheck: "absent" }, { redGreen: false })));
  for (const redGreen of [null, "true", 0]) assert.throws(() => mod.default(runtime, input(f, {}, { redGreen })), /redGreen must be a boolean/u);
  for (const redCheck of [null, "", false]) assert.throws(() => mod.default(runtime, input(f, { redCheck })), /repository.redCheck must be a non-empty string/u);
  assert.deepEqual(readdirSync(f.root), ["widgets"]);
});

test("repository.redCheck selects the named check for red and all gates still prove green", async context => {
  const f = fixture(context);
  const checks = [command("process.exit(0)"), { ...input(f).repository.checks[0], name: "acceptance" }];
  const result = await execute(input(f, { checks, redCheck: "acceptance" }));
  assert.equal(result.state, "delivered");
  assert.deepEqual(evidence(f).result.checks.map(check => [check.phase, check.name, check.passed]), [["red", "acceptance", true], ["verify", "tests", true], ["verify", "acceptance", true]]);
});

for (const [label, check] of [
  ["signal", command('process.kill(process.pid, "SIGTERM")')],
  ["timeout", command("setInterval(() => {}, 1000)", { timeoutMs: 50 })],
  ["spawn error", { name: "tests", command: ["/no-such-ticket-check"] }],
] as const) {
  test(`red rejects a ${label} instead of treating it as failing tests`, async context => {
    const f = fixture(context);
    const result = await execute(input(f, { checks: [check] }, { maxRepairs: 0, stuck: "park" }), { implementer: () => assert.fail() });
    const run = parked(f, result, /red: tests did not meet its expected result/u, { requests: [] });
    assert.deepEqual(run.result.checks.map(check => [check.phase, check.expected, check.passed]), [["red", "nonzero exit", false]]);
  });
}

test("red rejects a check that changes the candidate", async context => {
  const f = fixture(context);
  const result = await execute(input(f, { checks: [command('require("fs").writeFileSync("greeting.test.txt", "weakened"); process.exit(1)')] }, { maxRepairs: 0, stuck: "park" }), { implementer: () => assert.fail() });
  parked(f, result, /red check changed the checkout/u, { requests: [] });
});

test("ticketSections takes a backticked span as the Scope pattern, so an annotated bullet still matches", () => {
  const body = "## Goal\nG\n## Scope\n- `src/**` (the runtime)\n- tests/\n## Acceptance\n- a\n## Forbidden\n- f\n";
  assert.deepEqual(mod.ticketSections(body).scope, ["src/**", "tests/"]);
});

test("a resumed candidate is held to the Scope before it is verified", async context => {
  const f = fixture(context); const again = await handOff(f);
  writeFileSync(join(f.worktree, "other.txt"), "outside\n");
  const result = await execute(input(again, {}, { resume: true, maxRepairs: 0, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "parked");
  assert.deepEqual(result.states.slice(0, 4), ["shape", "prepare", "scopeAfterChange", "repairBudget"]);
  assert.match(result.output.summary, /outside the ticket Scope after change: "other\.txt"/u);
  assert.ok(existsSync(join(f.worktree, "other.txt")));
});

test("more rounds after a failed red returns to the tester, not the implementer", async context => {
  const f = fixture(context); let tests = 0; let edits = 0;
  const human = person("more rounds");
  const result = await execute(input(f, {}, { maxRepairs: 0, stuck: "ask" }), {
    tester: request => { if (++tests > 1) return tester(request); writeFileSync(join(request.cwd, "greeting.test.txt"), "// no assertion yet\n"); return ok(); },
    implementer: request => { edits++; assert.equal(tests, 2); return implement(request); },
  }, human);
  assert.equal(result.state, "delivered");
  assert.deepEqual([tests, edits, human.requests.length], [2, 1, 1]);
  assert.deepEqual(result.states.slice(result.states.indexOf("red")).slice(0, 6), ["red", "repairBudget", "stuck", "decide", "repairTarget", "test"]);
});

test("the tester and the implementer are told that checks they cannot run are the workflow's, and the implementer is given the Scope", async context => {
  const f = fixture(context); const prompts: Record<string, string> = {};
  const result = await execute(input(f), {
    tester: request => { prompts.tester = request.prompt; return tester(request); },
    implementer: request => { prompts.implementer = request.prompt; return implement(request); },
  });
  assert.equal(result.state, "delivered");
  for (const role of ["tester", "implementer"]) assert.match(prompts[role]!, /cannot run them.*still return completed: the workflow runs every required check itself/u, role);
  assert.match(prompts.implementer!, /Scope \(the only paths you may change; the workflow checks them\):\n- greeting\.txt/u);
});

test("the catalog and the README describe falsify, plan, and planReview where they described triage", () => {
  const catalog = readFileSync(resolve("docs/catalog.md"), "utf8"); const readme = readFileSync(resolve("README.md"), "utf8");
  // A state table row names its states in backticks in the first column, several of them separated by commas.
  const named = catalog.split("\n").filter(line => line.startsWith("| `")).flatMap(line => line.split("|")[1]!.split(",").map(name => name.trim()));
  for (const state of ["falsify", "plan", "planReview"]) assert.ok(named.includes(`\`${state}\``), `${state} has no row in the state table`);
  for (const state of ["triage", "triageResult"]) assert.equal(named.includes(`\`${state}\``), false, `${state} still has a row in the state table`);
  for (const [name, text] of [["docs/catalog.md", catalog], ["README.md", readme]] as const) {
    assert.doesNotMatch(text, /\btriage/iu, `${name} still describes triage`);
    for (const described of [/\bfalsif/iu, /\bplan\b/iu, /\bplan ?review/iu]) assert.match(text, described, name);
  }
});

test("the catalog and the README describe rebase, reverify, rebasedFrom, and the invariant that no stop leaves a commit", () => {
  const catalog = readFileSync(resolve("docs/catalog.md"), "utf8"); const readme = readFileSync(resolve("README.md"), "utf8");
  const named = catalog.split("\n").filter(line => line.startsWith("| `")).flatMap(line => line.split("|")[1]!.split(",").map(name => name.trim()));
  assert.ok(named.includes("`rebase`"), "rebase has no row in the state table");
  for (const [name, text] of [["docs/catalog.md", catalog], ["README.md", readme]] as const) {
    // Prose wraps where it will; the words are looked for across line breaks.
    const prose = text.replace(/\s+/gu, " ");
    for (const described of [/`rebase`/u, /`reverify`/u, /`rebasedFrom`/u]) assert.match(prose, described, name);
    assert.match(prose, /never stops with (?:\S+ ){1,4}commit on the ticket branch/iu, `${name} does not state the invariant`);
    // A base that moved is rebased onto now, so neither file may still say the candidate is delivered on the older commit as it is.
    assert.doesNotMatch(prose, /without rebasing|nothing is rebased|or rebase a candidate onto a base that moved/iu, name);
  }
  // A rewritten or moved-back base ends blocked for delivery by hand, and adopt goes on refusing such a branch.
  const prose = catalog.replace(/\s+/gu, " ");
  assert.match(prose, /moved back|rewritten/iu); assert.match(prose, /by hand/iu);
});
