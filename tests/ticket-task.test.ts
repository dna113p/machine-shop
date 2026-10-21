import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { launcher, runtime } from "./runtime.ts";
import "./fixtures/runtime-imports.ts";
import { evidenceFacts, evidencePage as renderEvidencePage } from "../defaults/_machine-shop/brief.ts";
import { evidenceLog, writeStuckEvidence } from "../defaults/_machine-shop/task.ts";

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
// Stop-policy fixtures need owner input at the first budget: this finding requires a Scope decision.
const ownerReview = (summary: string) => review("revise", summary, {
  findings: [{ severity: "blocker", text: summary, where: "outside-scope.txt:1" }],
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
  const beyond = (held: string[]) => held.filter(ref => !published.includes(ref)).join("\n");
  return Object.assign(() => beyond(refs()), {
    /** What the remote held beyond the base when the run last asked gh about its pull request, before any cleanup; "" when it never asked. */
    atCheck: () => existsSync(join(f.root, "bin", "remote-at-view")) ? beyond(readFileSync(join(f.root, "bin", "remote-at-view"), "utf8").split("\n").filter(Boolean)) : "",
  });
}
/** A recording git placed first on PATH that passes every call on to the real one. */
function recordGit(context: TestContext, f: Fixture) {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const bin = join(f.root, "git-bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${bin}/calls"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  context.after(() => { process.env.PATH = path; });
  return () => readFileSync(join(bin, "calls"), "utf8").trimEnd().split("\n");
}
/**
 * A recording gh placed first on PATH; the real gh is never started. `pr create` records its arguments and prints the pull request URL.
 * `pr view` answers the pull request's state from `views` in turn, repeating the last one: OPEN, MERGED, or CLOSED, or `fail` for a gh
 * that cannot answer. A delivered pull request is merged unless a test says otherwise, so a run without a sleep option never waits.
 */
function fakeGh(context: TestContext, f: Fixture, exitCode = 0, views: readonly string[] = ["MERGED"]) {
  const bin = join(f.root, "bin"); mkdirSync(bin);
  // The real git, so a recording one put on PATH later does not count the fake's own look at the remote.
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  writeFileSync(join(bin, "views"), `${views.join("\n")}\n`);
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    'if [ "$1" = pr ] && [ "$2" = view ]; then',
    `  printf '%s\\n' "$*" >> "${bin}/views.log"`,
    `  n=$(wc -l < "${bin}/views.log" | tr -d ' ')`,
    `  state=$(sed -n "\${n}p" "${bin}/views"); [ -n "$state" ] || state=$(tail -n 1 "${bin}/views")`,
    `  if [ -d "${f.root}/remote.git" ]; then "${real}" --git-dir="${f.root}/remote.git" for-each-ref --format='%(refname) %(objectname)' > "${bin}/remote-at-view"; fi`,
    '  if [ "$state" = fail ]; then echo "gh: boom" >&2; exit 1; fi',
    `  case " $* " in *" --jq "*|*" -q "*|*" --template "*|*" -t "*) echo "$state" ;; *" --json "*) printf '{"state":"%s"}\\n' "$state" ;; *) echo "$state" ;; esac`,
    "  exit 0",
    "fi",
    `printf '%s\\n' "$@" > "${bin}/args"`,
    `echo "Creating pull request for ${branch}"`,
    `echo ${url}`,
    `exit ${exitCode}`,
  ].join("\n") + "\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  context.after(() => { process.env.PATH = path; });
  return Object.assign(() => existsSync(join(bin, "args")) ? readFileSync(join(bin, "args"), "utf8").trimEnd().split("\n") : undefined, {
    /** The arguments of every `gh pr view`, in order. */
    views: () => existsSync(join(bin, "views.log")) ? readFileSync(join(bin, "views.log"), "utf8").trimEnd().split("\n") : [],
  });
}
const tester = (request: { cwd: string }) => {
  writeFileSync(join(request.cwd, "greeting.test.txt"), 'require("node:assert/strict").ok(require("node:fs").existsSync("greeting.txt"));\n');
  return ok("completed", "greeting.test.txt requires the implementation file");
};
const implement = (request: { cwd: string }) => { writeFileSync(join(request.cwd, "greeting.txt"), "hello\n"); return ok(); };
type Ask = {
  prompt: string; choices?: readonly string[]; suggestions?: readonly string[];
  headline?: string; recommended?: string; effects?: Record<string, string>; discards?: readonly string[]; reason?: string; page?: string;
};
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
type RunHooks = Pick<NonNullable<Parameters<typeof runtime.run>[1]>, "continueAt" | "onEnter" | "onBeforeStep" | "onSleep" | "onHumanSleep" | "answer">;
/**
 * Agents are given by role, where `reviewer` is the review of the implementation, or by state name for falsify, plan, and planReview;
 * `investigator` stands for both of that role's states, which is how a test says that neither may run.
 * A `presenter` is bound only when a test gives one, as a run with no presenter preset has none.
 */
async function execute(assignment: unknown, agents: Record<string, Runner> = {}, human: (request: Ask) => string = person(), options: RunHooks & { primitives?: typeof runtime } = {}) {
  const { primitives = runtime, ...hooks } = options;
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
  const result = await runtime.run(mod.default(primitives, assignment), {
    agents: {
      ...Object.fromEntries(["tester", "investigator", "implementer", "reviewer"].map(role => [role, staged(role)])),
      ...(agents.presenter ? { presenter: agents.presenter } : {}),
    },
    human, onState: state => states.push(String(state)), ...hooks,
  });
  return { state: result.value, output: result.output as any, states };
}
function evidence(f: Fixture) {
  const runs = join(f.evidence, ".machine-runs/machine-shop");
  const [id, ...others] = readdirSync(runs); assert.deepEqual(others, []);
  const read = (name: string) => JSON.parse(readFileSync(join(runs, id!, name), "utf8"));
  return { directory: join(runs, id!), result: read("result.json"), delivery: read("delivery.json") };
}
/** The evidence files that hold every one of these texts, as a report kept whole beside its stage report does. */
function holding(directory: string, texts: readonly string[]) {
  return readdirSync(directory).filter(name => statSync(join(directory, name)).isFile()
    && texts.every(text => readFileSync(join(directory, name), "utf8").includes(text)));
}
/** The Agent states and the decisions a run went through, in order. */
const route = (states: string[]) => states.filter(state => ["falsify", "plan", "planReview", "test", "change", "review", "decide"].includes(state));
const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
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
/** The one ending that completes: a merged pull request, with the strict output on which Machines Dispatch closes the ticket. */
function complete(f: Fixture, result: { output: any }, summary: RegExp) {
  assert.deepEqual(result.output, { action: "complete", summary: result.output.summary });
  assert.match(result.output.summary, summary); assert.doesNotMatch(result.output.summary, /\n/u);
  const run = evidence(f); assert.ok(result.output.summary.endsWith(`Evidence: ${run.directory}`));
  return run;
}
/**
 * A delivered pull request that was then merged: the run checked it after delivery, deleted the ticket branch here and on the remote,
 * and completed, naming the pull request and the branch. The delivery receipt is the one written when the pull request was opened.
 */
function merged(f: Fixture, result: { state: unknown; output: any; states: string[] }, name = branch) {
  assert.equal(result.state, "merged"); assert.deepEqual(result.states.slice(-3), ["checkMerge", "cleanUp", "merged"]);
  assert.ok(result.states.indexOf("success") < result.states.indexOf("checkMerge"), "the pull request is checked only after delivery");
  const run = complete(f, result, /\S/u);
  for (const part of [url, name]) assert.ok(result.output.summary.includes(part), part);
  assert.deepEqual([run.delivery.outcome, run.delivery.prUrl, run.result.outcome], ["delivered", url, "completed"]);
  assert.equal(git(f.repo, "branch", "--list", name), ""); assert.equal(existsSync(f.worktree), false);
  return run;
}
/** How a delivery ends: a branch or a patch is delivered and held as before, and a pull request is merged here, as the fake gh reports by default. */
function ended(f: Fixture, result: { state: unknown; output: any; states: string[] }, output: string, summary = /^Delivered/u) {
  if (output === "pr") return merged(f, result);
  assert.equal(result.state, "delivered");
  return held(f, result, summary);
}
/**
 * A refusal ends by itself in the declared failed ending, `refused`, without a question: nothing was there to clean up or try again.
 * The helper's receipt still says blocked, which is what the retrospective reads; delivery.json says refused.
 */
function refused(f: Fixture, result: { state: unknown; output: any; states: string[] }, reason: RegExp) {
  assert.equal(result.state, "refused"); assert.deepEqual(result.states.slice(-2), ["refuse", "refused"]);
  for (const state of ["failure", "blocked", "stuck", "decide", "stepFailed"]) assert.equal(result.states.includes(state), false, state);
  const run = held(f, result, /^Refused: /u); assert.match(run.delivery.reason, reason);
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision], ["blocked", "refused", undefined]);
  assert.deepEqual(readdirSync(run.directory).filter(name => /^question-\d+\.txt$/u.test(name)), [], "a refusal asks nothing");
  return run;
}
/** The choices each step question offers: only those that can act on what failed there. */
const stepChoices = ["retry", "hand off", "discard"];
const keepChoices = ["hand off", "discard"];
const deliverChoices = ["retry", "hand off"];
const mergeRetryChoices = ["retry", "hand off", "discard"];
const choicesOf: Record<string, readonly string[]> = { stepDecide: stepChoices, keepDecide: keepChoices, deliverDecide: deliverChoices };
/**
 * The question a step asks when it failed once this run's worktree exists. It names the step and its error, says where the worktree,
 * the branch, and the evidence are, and offers exactly the choices that can act there, as choices rather than suggestions.
 */
function stepAsked(f: Fixture, request: Ask | undefined, step: string, reason: RegExp, choices: readonly string[]) {
  assert.ok(request, `${step} asked its question`);
  assert.deepEqual(request.choices, choices); assert.equal(request.suggestions, undefined);
  assert.match(request.prompt, new RegExp(`\\b${step}\\b`, "u"), `the question names ${step}`); assert.match(request.prompt, reason);
  for (const part of [`Worktree: ${f.worktree}`, `Branch: ${branch}`, "Evidence: "]) assert.ok(request.prompt.includes(part), part);
  const lines = request.prompt.split("\n");
  for (const choice of choices) assert.ok(lines.some(line => line.startsWith(`${choice}: `)), `the question says what ${choice} does`);
  for (const other of ["more rounds", "archive", "retry", "discard", "any other reply"].filter(name => !choices.includes(name))) {
    assert.equal(lines.some(line => line.startsWith(`${other}: `)), false, `the question does not offer ${other}`);
  }
  assert.doesNotMatch(lines[0]!, /\bstuck\b/iu);
}
/**
 * A step that failed after the worktree existed asked its question once, and hand off ended the run there: the worktree and branch are
 * kept as they were, with `commits` commits on the branch, and the question is in the evidence as question-1.txt.
 */
function steppedOff(f: Fixture, result: { state: unknown; output: any; states: string[] }, step: string, decision: string, reason: RegExp, human: { requests: Ask[] }, commits?: number) {
  assert.equal(result.state, "handedOff"); assert.deepEqual(result.states.slice(-5), [step, "stepFailed", decision, "handOff", "handedOff"]);
  for (const state of ["failure", "blocked", "stuck", "decide", "refuse"]) assert.equal(result.states.includes(state), false, state);
  assert.equal(human.requests.length, 1); stepAsked(f, human.requests[0], step, reason, choicesOf[decision]!);
  const run = held(f, result, /^Handed off: /u);
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision], ["blocked", "handed-off", "hand off"]); assert.match(run.delivery.reason, reason);
  assert.ok(human.requests[0]!.prompt.includes(`Evidence: ${run.directory}`)); asksWritten(run.directory, human.requests);
  assert.deepEqual(run.result.decisions, [{ stage: decision, response: "hand off" }]);
  if (commits !== undefined) assert.equal(git(f.repo, "rev-list", "--count", `main..${branch}`), String(commits));
  assert.ok(existsSync(join(f.worktree, "code.txt"))); assert.ok(result.output.summary.includes(`Decision: hand off. Branch: ${branch}. Worktree kept at ${f.worktree}. Evidence: `));
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved], [true, false]);
  assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
  return run;
}
/** The evidence directory of a run that failed plainly, before it wrote any receipt. */
function runDirectory(f: Fixture) {
  const runs = join(f.evidence, ".machine-runs/machine-shop");
  const [id, ...others] = readdirSync(runs); assert.deepEqual(others, []);
  return join(runs, id!);
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
/**
 * A hand-off's hold says what happened in its first sentence, short and without the branch, then the reason and the decision,
 * and only then the branch, the kept worktree, and the evidence.
 */
function handOffSummary(summary: string, worktree: string) {
  const first = summary.split(/(?<=[.!?…])\s/u)[0]!;
  assert.match(first, /^Handed off: /u); assert.ok(first.length < 120, `the first sentence is under 120 characters: ${first}`);
  assert.equal(first.includes(branch), false, `the first sentence does not name the branch: ${first}`);
  assert.ok(summary.includes(`Decision: hand off. Branch: ${branch}. Worktree kept at ${worktree}. Evidence: `), summary);
}
/**
 * A stop's reason as a person reads it in the question and the hold: a spent budget is used up, with the rounds it allowed,
 * and the owner's questions are counted in a sentence of their own.
 */
const spoken = (reason: RegExp) => new RegExp(reason.source
  .replace(/budget exhausted \\\((\d+)\\\)/gu, "budget used up \\($1 of $1\\)")
  .replace(/(\d+ open questions?):/gu, "$1 (?:before any code is written|the reviewer raised)\\."), reason.flags);
/** A handed-off run went through the decision, not the failure path, and left the worktree on its uncommitted ticket branch. */
function handedOff(f: Fixture, result: { state: unknown; output: any; states: string[] }, reason: RegExp, human: { requests: Ask[] }) {
  assert.equal(result.state, "handedOff"); assert.deepEqual(result.states.slice(-3), ["decide", "handOff", "handedOff"]); assert.equal(result.states.includes("failure"), false);
  // The question says the reason as its first sentence and what follows it under Needs; the receipt keeps it as it was written.
  const prompt = human.requests.at(-1)!.prompt; const needs = prompt.indexOf("\nNeeds: ") >= 0 ? needsIn(prompt, f.worktree) : "";
  assert.match(oneLine(`${prompt.split("\n")[0]}\n${needs}`), spoken(reason));
  const run = held(f, result, spoken(reason)); untouched(f);
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision], ["blocked", "handed-off", "hand off"]); assert.match(run.delivery.reason, reason);
  assert.equal(git(f.repo, "rev-parse", branch), f.head); assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
  handOffSummary(result.output.summary, f.worktree);
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.delivery.archive], [true, false, null, undefined]);
  return run;
}
/** The park note's fixed next step, which a run that asks its question instead never gives. */
const nextStep ="Add the answer to the ticket body, then run the ticket again with resume: true; the run continues from the kept worktree with fresh budgets.";
/** How a stop for the owner counts the reviewer's questions. */
const counted = (count: number) => `${count} open question${count === 1 ? "" : "s"}`;
const asked = [
  { text: "Should the greeting be localized? (confirmed)", where: "greeting.txt:1" },
  { text: "Is a trailing newline wanted?", where: "greeting.txt:2" },
];
const askedAgain = [
  { text: "Should the greeting be localized? (confirmed again through a live engine)", where: "greeting.txt:1" },
  { text: "Should the greeting end with a newline?", where: "greeting.txt:2" },
];
const discussions = (questions: { text: string; where: string }[]) => questions.map(question => ({ severity: "discussion", ...question }));
/** The first sentence of a stop for the owner's questions: their count, and whether they hold up the code or came from the reviewer. */
const openQuestions = /^Answer \d+ open questions? (?:before any code is written|the reviewer raised)\.$/u;
/** One numbered line per question with where it was raised, in the reviewer's order. */
const questionLines = (questions: { text: string; where: string }[]) => questions.map((question, index) => `${index + 1}. ${question.text} (${question.where})`);
/** A gap as the investigator reports it from falsify: the question, the answers it could take, the one recommended, whether that one is safe to assume, and why. */
type Gap = { text: string; options: string[]; recommended: string; assumable: boolean; why: string };
const gap = (text: string, extra: Partial<Gap> = {}): Gap => ({
  text, options: ["Write it in English", "Leave it out"], recommended: "Leave it out", assumable: false, why: "The ticket does not say.", ...extra,
});
// A product decision: only the owner can answer it. The recommended answer is listed last.
const language = gap("Which language is the greeting in?", {
  options: ["French", "The reader's locale", "English"], recommended: "English", why: "The product ships in several languages and the ticket names none.",
});
// Gaps whose conservative answer keeps more and loses nothing if wrong. Quotes and a line break show whether a prompt carries the file's own text.
const beside = gap("Does greeting.txt replace code.txt or stand beside it?", {
  options: ["Replace code.txt", "Stand beside code.txt"], recommended: "Stand beside code.txt", assumable: true,
  why: 'Keeping "code.txt" loses nothing\nif the owner wanted it gone.',
});
const newline = gap("Does the greeting end with a line break?", {
  options: ["End with a line break", "No line break"], recommended: "End with a line break", assumable: true, why: "A text file that ends with a line break loses nothing.",
});
const gaps = (questions: unknown, summary = "The ticket leaves the language open") => ({ type: "questions", summary, questions });
/** What a run that assumes records for each gap: the question, the recommended answer it took, the options it had, and why. */
const assumed = (questions: Gap[]) => questions.map(({ text, options, recommended, why }) => ({ question: text, answer: recommended, options, why }));
/** The assumptions a prompt carries: what follows its own `Assumptions:` heading line. */
const assumptionsIn = (prompt: string) => prompt.split(/^Assumptions:\n+/mu)[1] ?? "";
const numberedLines = (lines: string[]) => lines.filter(line => /^\d+\. /u.test(line));
/** A falsify question's one line of the park note: its number and text, then every option, the recommended one first and marked as such, and why it is asked. */
function optionsFirst(line: string, number: number, asked: Gap, shown = oneLine(asked.text)) {
  assert.ok(line.startsWith(`${number}. ${shown}`), line);
  const rest = line.slice(`${number}. ${shown}`.length);
  const recommended = rest.indexOf(oneLine(asked.recommended));
  assert.ok(recommended >= 0, `${line} does not give the recommended option`);
  for (const option of asked.options.filter(option => option !== asked.recommended)) {
    assert.ok(rest.indexOf(oneLine(option)) > recommended, `${line} does not give ${option} after the recommended option`);
  }
  assert.match(rest, /\brecommended\b/iu);
  // The reason comes with the options: a question that has one is never listed without it.
  assert.ok(rest.indexOf(oneLine(asked.why)) > recommended, `${line} does not say why: ${oneLine(asked.why)}`);
}
/** The decisions a stuck run offers. They are suggestions: any other reply is the owner's answer. */
const stuckDecisions = ["more rounds", "hand off", "archive", "discard"];
/** What a stuck run's question says is needed: everything after its `Needs: ` up to the worktree line, which may run over several lines. */
function needsIn(prompt: string, worktree: string) {
  const start = prompt.indexOf("\nNeeds: "); const end = prompt.indexOf(`\nWorktree: ${worktree}\n`);
  assert.ok(start >= 0 && end > start, `the question says what is needed before where the worktree is:\n${prompt}`);
  return prompt.slice(start + "\nNeeds: ".length, end);
}
/** How often a text appears in another, overlapping matches aside. */
const occurrences = (text: string, part: string) => text.split(part).length - 1;
/** The one line of a stuck question that says where the run stands: the ticket's id, never its title, and the state that stopped. */
const standsAt = (stoppedIn: string) => `Ticket PROJ-12. Stopped in ${stoppedIn}.`;
/**
 * A stuck run asks one question whose prompt is the park note's text: what is needed in one short first sentence, where the run stands
 * under the ticket's id alone, the reason or the questions once, and where to look, with the four decisions offered as suggestions rather
 * than the only replies. It never repeats the ticket's title, and never sends anyone to run the ticket again.
 * Returns the need: the first sentence, followed by what its `Needs: ` line says when it has one.
 */
function stuckQuestion(f: Fixture, request: Ask | undefined, stoppedIn: string): string {
  assert.ok(request, "the stuck run asked its question");
  const [first, blank, stands] = request.prompt.split("\n");
  // A first sentence too long for that is cut after a whole word, with an ellipsis that counts toward the 100.
  assert.ok(first!.length < 100 || (first!.length === 100 && first!.endsWith("…")), `the first sentence is under 100 characters: ${first}`);
  assert.doesNotMatch(first!, /^Ticket \S+ is stuck/u); assert.equal(blank, "");
  assert.equal(stands, standsAt(stoppedIn));
  // The run's label already carries the title, and the reason is said once, not under a standing line of its own.
  assert.equal(request.prompt.includes("Add a greeting"), false, "the question does not repeat the ticket's title");
  assert.doesNotMatch(request.prompt, /This run is stuck and needs a decision|is stuck: answer what is needed/u);
  assert.deepEqual(request.suggestions, stuckDecisions); assert.equal(request.choices, undefined);
  assert.ok(request.prompt.includes(`\nWorktree: ${f.worktree}\nBranch: ${branch}\nEvidence: `));
  // Any reply that is not one of the decisions is taken as the answer.
  assert.ok(request.prompt.split("\n").some(line => line.startsWith("any other reply: ")), "the question says what any other reply does");
  assert.equal(request.prompt.includes(nextStep), false); assert.doesNotMatch(request.prompt, /resume: true/u);
  return request.prompt.includes("\nNeeds: ") ? `${first}\n${needsIn(request.prompt, f.worktree)}` : first!;
}
/**
 * Where a run parked before, it now asks its one question and writes no park note. Answered with hand off, it ends as any hand-off does:
 * the candidate is kept and nothing is committed. Returns the run's evidence with the question's prompt and what it says is needed.
 */
function questioned(f: Fixture, result: { state: unknown; output: any; states: string[] }, reason: RegExp, human: { requests: Ask[] }) {
  assert.deepEqual(result.states.slice(-4), ["stuck", "decide", "handOff", "handedOff"]);
  for (const state of ["park", "parked"]) assert.equal(result.states.includes(state), false, state);
  assert.equal(human.requests.length, 1);
  const run = handedOff(f, result, reason, human);
  const [request] = human.requests;
  const needs = stuckQuestion(f, request, result.states.at(-5)!);
  assert.ok(request!.prompt.includes(`Evidence: ${run.directory}`)); assert.match(oneLine(needs), spoken(reason));
  assert.equal(existsSync(join(run.directory, "park.txt")), false); assert.equal(Object.hasOwn(run.delivery, "park"), false);
  asksWritten(run.directory, [request!]);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "hand off" }]);
  assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
  return Object.assign(run, { prompt: request!.prompt, needs });
}
/** Each time a stuck run asks, the question's text goes to the evidence as `question-<n>.txt`, numbered from 1 across the run, and no park note is written. */
function asksWritten(directory: string, requests: readonly Ask[], from = 1) {
  requests.forEach((request, index) => {
    const name = `question-${from + index}.txt`;
    assert.ok(existsSync(join(directory, name)), `${name} was written`);
    assert.equal(readFileSync(join(directory, name), "utf8"), `${request.prompt}\n`, name);
  });
  assert.equal(existsSync(join(directory, `question-${from + requests.length}.txt`)), false, `no question-${from + requests.length}.txt`);
  assert.equal(existsSync(join(directory, "park.txt")), false);
}
/** A need as `stuckQuestion` returns it, as the prompt shows it: its first sentence on the first line, and the rest under `Needs: `. */
function showsNeed(prompt: string, need: string, worktree: string) {
  const [first, ...rest] = need.split("\n");
  assert.ok(prompt.startsWith(`${first}\n\n`), prompt);
  if (rest.length) assert.ok(prompt.includes(`\nNeeds: ${rest.join("\n")}\nWorktree: ${worktree}\n`), prompt);
}
/** What a stuck run's question says above what it needs: the first sentence, where the run stands, and the budgets. */
const standingOf = (prompt: string) => prompt.slice(0, prompt.indexOf("\nNeeds: "));
/** The answers a prompt carries: what follows its own `Answers from the ticket owner:` heading line. */
const answersIn = (prompt: string) => prompt.split(/^Answers from the ticket owner:\n+/mu)[1] ?? "";

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

test("construction has no effects and declares exactly the four required roles and the optional presenter", context => {
  const f = fixture(context);
  assert.match(mod.description, /\S/u); assert.doesNotMatch(mod.description, /\n/u);
  for (const data of [input(f, { output: "pr", setup: [command()] }), JSON.stringify(input(f))]) {
    assert.deepEqual(runtime.requiredAgentNames(mod.default(runtime, data)), ["implementer", "investigator", "reviewer", "tester"]);
    assert.deepEqual(runtime.optionalAgentNames(mod.default(runtime, data)), ["presenter"]);
  }
  assert.deepEqual(Object.keys(mod.agentRoles).sort(), ["implementer", "investigator", "presenter", "reviewer", "tester"]);
  for (const role of ["implementer", "investigator", "reviewer", "tester"]) assert.match(mod.agentRoles[role], /\S/u, role);
  // A role used only to present a question is declared optional, or the launcher refuses the Machine.
  assert.deepEqual(Object.keys(mod.agentRoles.presenter).sort(), ["description", "optional"]);
  assert.equal(mod.agentRoles.presenter.optional, true); assert.match(mod.agentRoles.presenter.description, /\S/u);
  assert.doesNotMatch(mod.agentRoles.presenter.description, /\n/u);
  const states = Object.keys(mod.default(runtime, input(f)).states);
  for (const state of ["falsify", "plan", "planReview"]) assert.ok(states.includes(state), state);
  for (const state of ["triage", "triageResult"]) assert.equal(states.includes(state), false, state);
  assert.deepEqual(readdirSync(f.root), ["widgets"]);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main"); untouched(f);
});

test("Machine Shop depends on the Machines release whose presenter can recommend a suggestion, with its lock file", () => {
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.equal(manifest.devDependencies["@dna113p/machines"], "^0.7.1");
  const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].devDependencies["@dna113p/machines"], "^0.7.1");
  const locked = lock.packages["node_modules/@dna113p/machines"];
  const [major, minor, patch] = String(locked.version).split(".").map(Number);
  assert.ok(major === 0 && minor === 7 && patch! >= 1, `the lock file holds Machines ${locked.version}`);
  assert.ok(String(locked.resolved).endsWith(`/machines-${locked.version}.tgz`), locked.resolved); assert.match(locked.integrity, /^sha512-/u);
  for (const name of ["defineEndings", "optionalAgentNames"] as const) assert.equal(typeof runtime[name], "function", name);
});

test("the launcher prepares ticket-task with no presenter bound, and with a preset named for the presenter", async context => {
  const f = fixture(context); const home = join(f.root, "home"); mkdirSync(join(home, ".machines"), { recursive: true });
  // Preparing a run starts nothing, so a runner that throws shows it was never called.
  const presets = ["investigator", "tester", "implementer", "reviewer", "small"].map(name => `  ${name}: { description: "Fixture ${name}", runner: idle },`);
  writeFileSync(join(home, ".machines", "agents.ts"), ['const idle = () => { throw new Error("nothing runs while a run is prepared"); };', "export default () => ({", ...presets, "});", ""].join("\n"));
  for (const agents of [undefined, { presenter: "small" }]) {
    const prepared = await launcher.prepareMachineRun({ cwd: home, home, machine: resolve("ticket-task.ts"), input: input(f), ...(agents ? { agents } : {}) });
    assert.equal(prepared.description, mod.description);
  }
  assert.deepEqual(readdirSync(f.root).sort(), ["home", "widgets"]); untouched(f);
});

test("every final state takes a declared ending, and nothing is left that ends blocked", context => {
  const f = fixture(context);
  assert.ok(mod.endings, "ticket-task exports its endings");
  assert.deepEqual(Object.fromEntries(Object.entries(mod.endings as Record<string, { name: string; kind: string }>).map(([name, ending]) => [name, [ending.name, ending.kind]])), {
    delivered: ["delivered", "succeeded"], merged: ["merged", "succeeded"], handedOff: ["handedOff", "cancelled"], abandoned: ["abandoned", "cancelled"], refused: ["refused", "failed"],
  });
  for (const data of [input(f), input(f, { output: "pr" })]) {
    const states = (mod.default(runtime, data) as { config: { states: Record<string, { type?: string }> } }).config.states;
    const finals = Object.entries(states).filter(([, state]) => state.type === "final");
    assert.deepEqual(finals.map(([name]) => name).sort(), ["abandoned", "delivered", "handedOff", "merged", "refused"]);
    for (const [name, state] of finals) assert.deepEqual(state, runtime.final(mod.endings[name]), `${name} takes its own ending`);
    // The failure path is gone: no state is left that a failed step could still end through.
    for (const gone of ["blocked", "failure", "mergeFailure"]) assert.equal(Object.hasOwn(states, gone), false, gone);
    for (const state of ["refuse", "setup", "stepFailed", "stepDecide", "keepDecide", "deliverDecide", "confirmStepDiscard", "mergeFailed", "mergeRetryDecide"]) {
      assert.ok(Object.hasOwn(states, state), state);
    }
  }
  assert.deepEqual(readdirSync(f.root), ["widgets"]); untouched(f);
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
    test(`a ${resume ? "resumed" : "new"} ticket with missing or empty ${section} is refused before any Agent or worktree`, async context => {
      const f = fixture(context); const data = input(f, {}, { resume }); data.ticket.body = data.ticket.body.replace(remove, "");
      const result = await execute(data, { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
      assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "refuse", "refused"]);
      const run = held(f, result, new RegExp(`^Refused: Ticket body is missing required sections or non-empty lists: ${section}\\. Expected shape:`, "u")); untouched(f);
      assert.deepEqual([run.delivery.outcome, run.result.outcome], ["refused", "blocked"]);
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
    assert.equal(edits, 1); assert.equal(result.states.includes("repairBudget"), false);
    const run = ended(f, result, output); assert.deepEqual(run.delivery.reviewNotes, notes);
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

test("two questions both reworded in the next review go to the owner together, each on its own numbered line", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const result = await execute(input(f), {
    // A first review with questions still gives the implementer one round with them.
    implementer: request => {
      if (++edits === 2) for (const question of asked) assert.ok(request.prompt.includes(`Discussion: ${question.text} (${question.where})`), question.text);
      return implement(request);
    },
    reviewer: () => review("approved", "Owner questions", { findings: discussions(++reviews === 1 ? asked : askedAgain), newSinceLastRound: "none" }),
  }, human);
  const lines = questionLines(askedAgain);
  // The prompt and the receipt carry the reason as written, one question to a line; the hold flattens it.
  const run = handedOff(f, result, new RegExp(`${counted(2)}:\\s${lines.map(literal).join("\\s")}`, "u"), human);
  assert.deepEqual([edits, reviews], [2, 2]);
  assert.deepEqual(run.delivery.reason.split("\n").slice(1), lines);
  assert.ok(human.requests[0]!.prompt.startsWith(`Answer ${counted(2)} the reviewer raised.\n`)); assert.ok(human.requests[0]!.prompt.includes(`\nNeeds: ${lines.join("\n")}\n`));
  for (const question of asked) assert.equal(run.delivery.reason.includes(question.text), false, question.text);
});

test("open questions with the park policy are asked, not parked: the question numbers every one in what it says is needed", async context => {
  const f = fixture(context); const human = person("hand off"); let reviews = 0;
  const result = await execute(input(f, {}, { stuck: "park" }), {
    reviewer: () => review("approved", "Owner questions", { findings: discussions(++reviews === 1 ? asked : askedAgain), newSinceLastRound: "none" }),
  }, human);
  const run = questioned(f, result, /confirmed again through a live engine/u, human); assert.equal(reviews, 2);
  const lines = questionLines(askedAgain);
  const [reason, needs]: string[][] = [run.delivery.reason.split("\n"), run.needs.split("\n")];
  assert.match(reason[0]!, /\b2 open questions:$/u); assert.deepEqual(reason.slice(1), lines);
  assert.equal(needs[0], `Answer ${counted(2)} the reviewer raised.`); assert.deepEqual(needs.slice(1), lines);
  showsNeed(run.prompt, run.needs, f.worktree);
});

test("a different question in the next review is asked alone", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const [first, second] = [{ text: "Should the greeting be localized?", where: "greeting.txt:1" }, { text: "Is a trailing newline wanted?", where: "greeting.txt:2" }];
  const result = await execute(input(f, {}, { stuck: "park" }), {
    implementer: request => { edits++; return implement(request); },
    reviewer: () => review("approved", "Owner question", { findings: discussions([++reviews === 1 ? first : second]), newSinceLastRound: "A new question" }),
  }, human);
  const run = questioned(f, result, /Is a trailing newline wanted\?/u, human); assert.deepEqual([edits, reviews], [2, 2]);
  const [reason, needs]: string[][] = [run.delivery.reason.split("\n"), run.needs.split("\n")];
  assert.match(reason[0]!, /\b1 open question:$/u); assert.deepEqual(reason.slice(1), questionLines([second]));
  assert.match(needs[0]!, openQuestions); assert.deepEqual(needs.slice(1), questionLines([second]));
  for (const text of [run.delivery.reason, run.needs, result.output.summary]) assert.equal(text.includes(first.text), false);
});

test("each long open question is cut at 600 characters separately while a short question stays whole", async context => {
  const f = fixture(context); const human = person("hand off"); let reviews = 0;
  // A line break inside a question must not break the one-line-per-question list.
  const long = { text: `Should the greeting be localized for every locale the product ships in?\n${"More context. ".repeat(50)}`.trim(), where: "greeting.txt:1" };
  const rest = [
    { text: `Is a trailing newline wanted? ${"It matters to the diff. ".repeat(20)}`.trim(), where: "greeting.txt:2" },
    { text: `Which locale is the default? ${"The deployment serves several regions. ".repeat(20)}`.trim(), where: "greeting.txt:3" },
  ];
  const result = await execute(input(f, {}, { stuck: "park" }), {
    reviewer: () => review("approved", "Owner questions", { findings: discussions(++reviews === 1 ? rest : [long, ...rest]), newSinceLastRound: "none" }),
  }, human);
  const run = questioned(f, result, /Should the greeting be localized/u, human); assert.equal(reviews, 2);
  const whole = long.text.replace(/\s+/gu, " "); const cut = `${whole.slice(0, 600)}…`;
  assert.ok(whole.length > 600); assert.ok(rest[0]!.text.length < 600); assert.ok(rest[1]!.text.length > 600);
  // Each long question has its own cap; the short question between them stays whole.
  assert.deepEqual(run.needs.split("\n").slice(1), [
    `1. ${cut} (${long.where})`,
    `2. ${rest[0]!.text} (${rest[0]!.where})`,
    `3. ${rest[1]!.text.slice(0, 600)}… (${rest[1]!.where})`,
  ]);
  // The reason is never cut.
  assert.deepEqual(run.delivery.reason.split("\n").slice(1), [`1. ${whole} (${long.where})`, ...questionLines(rest).map((line, index) => `${index + 2}. ${line.slice(3)}`)]);
});

test("a question first raised beside a blocker goes to the owner when it is still open once the blocker is repaired", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const result = await execute(input(f), {
    implementer: request => { edits++; return implement(request); },
    reviewer: () => ++reviews > 2 ? review() : review("approved", "Question plus repair", {
      findings: reviews === 1 ? [{ severity: "blocker", text: "Handle empty input", where: "greeting.txt:2" }, ...discussions([asked[0]!])] : discussions([askedAgain[0]!]),
    }),
  }, human);
  // The question went back with the blocker for one round, so the next review's wording of it is the owner's to answer.
  handedOff(f, result, new RegExp(`${counted(1)}:\\s${literal(questionLines([askedAgain[0]!])[0]!)}`, "u"), human);
  assert.deepEqual([edits, reviews], [2, 2]);
});

for (const cause of ["not converging", "open questions", "malformed report"]) {
  test(`more rounds restores the last review findings after ${cause}`, async context => {
    const f = fixture(context); const human = person("more rounds"); let edits = 0; let reviews = 0;
    const rounds = cause === "malformed report" ? 1 : 2;
    // A malformed report goes back to the reviewer once before it stops; this reviewer gives it again.
    const sentBack = cause === "malformed report" ? 1 : 0;
    const discussion = { severity: "discussion", text: "Which locale?", where: "greeting.txt:3" };
    const needsRepair = cause !== "open questions";
    // The owner's questions are whatever the last review asked, reworded and added to since the round before.
    const open = [{ text: "Which locale should the greeting use?", where: "greeting.txt:3" }, { text: "Is the greeting capitalised?", where: "greeting.txt:4" }];
    const findings = () => needsRepair ? [{ severity: "blocker", text: "Handle empty input", where: "greeting.txt:2" }, discussion] : reviews === 1 ? [discussion] : discussions(open);
    const feedback = [
      "Latest review",
      ...(needsRepair ? [`Unmet criterion: ${criterion} (greeting.txt:1)`, "Blocker: Handle empty input (greeting.txt:2)", "Discussion: Which locale? (greeting.txt:3)"]
        : open.map(question => `Discussion: ${question.text} (${question.where})`)),
    ].join("\n");
    const result = await execute(input(f), {
      implementer: request => {
        if (++edits === rounds + 1) assert.equal(request.prompt.split("Current failure/feedback: ")[1], feedback);
        return implement(request);
      },
      reviewer: () => ++reviews > rounds + sentBack ? review() : review("approved", "Latest review", {
        criteria: [{ text: "Reviewer paraphrase", met: !needsRepair, evidence: "greeting.txt:1" }], findings: findings(),
        newSinceLastRound: cause === "malformed report" ? undefined : "none",
      }),
    }, human);
    assert.equal(result.state, "delivered"); assert.deepEqual([edits, reviews, human.requests.length], [rounds + 1, rounds + 1 + sentBack, 1]);
    assert.match(human.requests[0]!.prompt, /send the standing findings back to the implementer/u);
    assert.match(human.requests[0]!.prompt, cause === "malformed report" ? /review report was malformed twice: newSinceLastRound/u : new RegExp(cause, "u"));
    if (!needsRepair) assert.ok(human.requests[0]!.prompt.includes(`\nNeeds: ${questionLines(open).join("\n")}\n`));
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
  test(`an open question still repairs while a ${repair} is present even when reworded`, async context => {
    const f = fixture(context); let edits = 0; let reviews = 0;
    const result = await execute(input(f), {
      implementer: request => { edits++; return implement(request); },
      reviewer: () => {
        if (++reviews === 3) return review();
        return review("approved", "Question plus repair", {
          criteria: [{ text: criterion, met: reviews === 1 || repair === "blocker", evidence: "greeting.txt:1" }],
          findings: [{ severity: "discussion", text: reviews === 1 ? "Which locale?" : "Which locale should the greeting use?", where: "greeting.txt:1" },
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
          : { severity: "discussion", text: reviews === 1 ? "Which locale?" : "Which locale should the greeting use?", where: "greeting.txt:1" }], newSinceLastRound: "none",
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
  assert.match(human.requests[0]!.prompt.split("\n")[0]!, /^Cannot inspect the generated output$/u);
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
  assert.equal(reviews, 2);
  const run = merged(f, result);
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
  assert.deepEqual([edits, reviews], [2, 2]);
  const run = merged(f, result); assert.deepEqual(run.delivery.reviewNotes, notes);
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
    const run = handedOff(f, result, /review report was malformed twice/u, human);
    assert.ok(run.delivery.reason.includes(field)); assert.ok(existsSync(join(run.directory, "review-1.json")));
  });
}

test("an approved report missing criteria is blocked while its minor notes are retained", async context => {
  const f = fixture(context); const human = person("hand off");
  const note = { text: "Consider a clearer filename", where: "greeting.txt:1" };
  const result = await execute(input(f), { reviewer: () => review("approved", "Claims approval", {
    criteria: undefined, findings: [{ severity: "minor", ...note }],
  }) }, human);
  const run = handedOff(f, result, /review report was malformed twice: criteria/u, human);
  assert.deepEqual(run.delivery.reviewNotes, [note]);
});

/** What a send-back tells the Agent: the fault exactly as its validator gave it. */
const sentBack = (fault: string) => `Your last report was malformed: ${fault}. Return it again in the required shape.`;
const summaryFault = (stage: string) => `Agent ${stage} must return a non-empty summary of at most 16000 characters`;
/** The evidence files that keep this text, leaving out the receipts and questions a stop writes. */
const keptIn = (directory: string, text: string) => holding(directory, [text])
  .filter(name => !["result.json", "delivery.json"].includes(name) && !name.startsWith("question-"));

/** Find an entire raw report, either in its stage file or inside a fault record. */
function retainedReports(directory: string, report: unknown) {
  return readdirSync(directory).filter(name => name.endsWith(".json")).flatMap(name => {
    const path = join(directory, name); const value = JSON.parse(readFileSync(path, "utf8"));
    return isDeepStrictEqual(value, report) || isDeepStrictEqual(value.event, report) ? [path] : [];
  });
}
/** Budget values at the actual Agent call, including the separate plan and extra-review allowances. */
function reportBudgets(data: Record<string, any>) {
  return {
    repairs: data.task.repairs, reviewRounds: data.task.reviewRounds, planRevisions: data.planRevisions,
    renewed: data.task.renewed, renewedReviews: data.task.renewedReviews, extraReviewRounds: data.extraReviewRounds,
  };
}
const reportStages = ["plan", "planReview", "test", "change", "review"] as const;
type ReportStage = typeof reportStages[number];
const reportRole = (stage: ReportStage) => stage === "test" ? "tester" : stage === "change" ? "implementer" : stage === "review" ? "reviewer" : stage;
const validReport = (stage: ReportStage, request: Request) => isPlanning(stage) ? planning[stage]!.answer(request)
  : stage === "test" ? tester(request) : stage === "change" ? implement(request) : review();
const reportOutcome = (stage: ReportStage) => stage === "plan" ? "planned" : ["planReview", "review"].includes(stage) ? "approved" : "completed";

test("ticket-task documentation names every report covered by the single send-back", () => {
  const document = readFileSync(resolve("docs/workflows/ticket-task.md"), "utf8");
  const recovery = document.split(/\n\s*\n/u).filter(paragraph => /send[- ]back|sent back/iu.test(paragraph))
    .join("\n\n").replace(/[`*_]/gu, "").replace(/\s+/gu, " ");
  assert.match(recovery, /\bone\b.{0,120}\bsend[- ]back\b|\bsent back\b.{0,40}\bonce\b|\bsend[- ]back\b.{0,40}\bonce\b/iu);
  for (const stage of [/\bplan\b/iu, /\bplan\s*review\b/iu, /\btest\b/iu, /\bchange\b/iu, /\breview\b/iu]) {
    assert.match(recovery, stage, "the documentation explicitly includes each ticket report in the send-back policy");
  }
});

for (const stage of reportStages) for (const second of ["valid", "malformed"] as const) {
  test(`${stage} report recovery: malformed then ${second} retains evidence and budgets and ${second === "valid" ? "continues" : "stops as malformed twice"}`, async context => {
    const f = fixture(context); const saves = checkpointed(); const updates: unknown[] = [];
    const human = person(...(second === "valid" ? [] : ["hand off"]));
    const requests: Request[] = []; const budgets: ReturnType<typeof reportBudgets>[] = []; const notesAtCall: string[][] = [];
    const reports = [ok(reportOutcome(stage), " \n"), ok(reportOutcome(stage), "")];
    const primitives = { ...saves.options.primitives, status: ((update: Parameters<typeof runtime.status>[0]) => {
      updates.push(structuredClone(update)); runtime.status(update);
    }) as typeof runtime.status };
    const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), {
      [reportRole(stage)]: (request: Request) => {
        requests.push(request); budgets.push(reportBudgets(saves.data()!)); notesAtCall.push(statusNotes(updates));
        assert.ok(requests.length <= 2, `${stage} gets only one send-back`);
        return requests.length === 1 || second === "malformed" ? reports[requests.length - 1]! : validReport(stage, request);
      },
    }, human, { ...saves.options, primitives });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.cwd, f.worktree); assert.equal(requests[1]!.cwd, f.worktree);
    assert.deepEqual(requests[1]!.outcomes, requests[0]!.outcomes, "the same Agent role and outcomes serve the retry");
    assert.doesNotMatch(requests[0]!.prompt, /Your last report was malformed/u);
    assert.ok(requests[1]!.prompt.includes(sentBack(summaryFault(stage))), "the retry includes the exact validator feedback");
    const states = ["falsify", ...reportStages];
    const expected = states.flatMap(name => name === stage ? [name, name] : [name]);
    assert.deepEqual(route(result.states), second === "valid" ? expected : [...expected.slice(0, expected.lastIndexOf(stage) + 1), "decide"]);
    const run = second === "valid" ? ended(f, result, "branch")
      : handedOff(f, result, new RegExp(`${stage} report was malformed twice: ${literal(summaryFault(stage))}`, "u"), human);
    assert.deepEqual(budgets, [budgets[0], budgets[0]], "sending back does not spend any budget");
    assert.deepEqual(budgets[0], { repairs: 0, reviewRounds: 0, planRevisions: 0, renewed: 0, renewedReviews: 0, extraReviewRounds: 0 });
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
    assert.equal(result.states.includes("repairBudget"), false); assert.equal(result.states.includes("reviewBudget"), false);
    assert.notDeepEqual(retainedReports(run.directory, reports[0]), [], "the first raw report is retained");
    if (second === "malformed") {
      const paths = retainedReports(run.directory, reports[1]); assert.notDeepEqual(paths, [], "the second raw report is retained");
      assert.ok(paths.some(path => run.delivery.reason.includes(path) && human.requests[0]!.prompt.includes(path)
        && result.output.summary.includes(path)), "the stop names an existing file containing the second report");
      assert.equal(human.requests.length, 1);
    } else assert.equal(human.requests.length, 0);
    assert.ok(notesAtCall[1]!.some(note => /report.*(?:sent|send|sending).*back|(?:sent|send|sending).*back.*report/iu.test(note)),
      `the run publishes that the ${stage} report was sent back before asking again: ${JSON.stringify(updates)}`);
  });
}

for (const faults of [["summary", "structured"], ["structured", "summary"], ["summary", "summary"], ["structured", "structured"]] as const) {
  test(`review report recovery: ${faults.join(" then ")} shares one send-back and stops with both raw reports`, async context => {
    const f = fixture(context); const human = person("hand off"); const prompts: string[] = [];
    const reports = faults.map((fault, index) => fault === "summary" ? review("approved", index ? "" : " \n")
      : review("approved", `Malformed review attempt ${index + 1}`, { criteria: null }));
    const faultText = (fault: string) => fault === "summary" ? summaryFault("review") : "criteria must be an array";
    const result = await execute(input(f), {
      reviewer: request => {
        prompts.push(request.prompt); assert.ok(prompts.length <= 2, "summary and structured faults share the allowance");
        return reports[prompts.length - 1]!;
      },
    }, human);
    assert.equal(prompts.length, 2); assert.ok(prompts[1]!.includes(sentBack(faultText(faults[0]))));
    const run = handedOff(f, result, new RegExp(`review report was malformed twice: ${literal(faultText(faults[1]))}`, "u"), human);
    assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "test", "change", "review", "review", "decide"]);
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
    for (const report of reports) assert.notDeepEqual(retainedReports(run.directory, report), []);
    assert.ok(retainedReports(run.directory, reports[1]).some(path => run.delivery.reason.includes(path) && human.requests[0]!.prompt.includes(path)),
      "the stop points to the complete second report");
  });
}

for (const stage of ["test", "change"] as const) {
  test(`${stage} report recovery: a genuine later entry resets the allowance and only the real repair spends a round`, async context => {
    const f = fixture(context); const saves = checkpointed(); const prompts: string[] = []; const updates: unknown[] = [];
    const budgets: ReturnType<typeof reportBudgets>[] = []; let reviews = 0;
    const primitives = { ...saves.options.primitives, status: ((update: Parameters<typeof runtime.status>[0]) => {
      updates.push(structuredClone(update)); runtime.status(update);
    }) as typeof runtime.status };
    const result = await execute(input(f, {}, { maxRepairs: 1, maxReviewRounds: 1 }), {
      [reportRole(stage)]: (request: Request) => {
        prompts.push(request.prompt); budgets.push(reportBudgets(saves.data()!));
        assert.ok(prompts.length <= 4, "each genuine entry permits exactly one return");
        if (prompts.length % 2) return ok("completed", " ");
        if (stage === "test" && prompts.length === 2) {
          writeFileSync(join(request.cwd, "greeting.test.txt"), "// This test does not fail yet.\n");
          return ok("completed", "Added greeting.test.txt; the Machine must prove red");
        }
        return validReport(stage, request);
      },
      reviewer: () => stage === "change" && ++reviews === 1 ? review("revise", "Handle empty input") : review(),
    }, person(), { ...saves.options, primitives });
    const run = ended(f, result, "branch"); assert.equal(prompts.length, 4);
    for (const index of [0, 2]) assert.doesNotMatch(prompts[index]!, /Your last report was malformed/u, "a new entry clears stale shape feedback");
    for (const index of [1, 3]) assert.ok(prompts[index]!.includes(sentBack(summaryFault(stage))));
    assert.deepEqual(budgets[1], budgets[0]); assert.deepEqual(budgets[3], budgets[2]);
    assert.deepEqual(budgets.map(({ repairs, reviewRounds }) => [repairs, reviewRounds]),
      stage === "test" ? [[0, 0], [0, 0], [1, 0], [1, 0]] : [[0, 0], [0, 0], [0, 1], [0, 1]]);
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], stage === "test" ? [1, 0] : [0, 1]);
    assert.equal(result.states.filter(state => state === "repairBudget").length, stage === "test" ? 1 : 0);
    assert.equal(result.states.filter(state => state === "reviewBudget").length, stage === "change" ? 1 : 0);
    assert.ok(statusNotes(updates).filter(note => /report.*(?:sent|send|sending).*back|(?:sent|send|sending).*back.*report/iu.test(note)).length >= 2,
      "both send-backs publish a status update");
  });
}

for (const second of ["valid", "malformed"] as const) {
  test(`a malformed review report goes back once to the reviewer with its fault, and a ${second} second report ${second === "valid" ? "continues" : "stops as malformed twice"}`, async context => {
    const f = fixture(context); const human = person(...(second === "valid" ? [] : ["hand off"])); const prompts: string[] = []; let edits = 0;
    const malformed = () => review("approved", "Claims approval", { criteria: undefined });
    const result = await execute(input(f), {
      implementer: request => { edits++; return implement(request); },
      reviewer: request => { prompts.push(request.prompt); return prompts.length === 1 || second === "malformed" ? malformed() : review(); },
    }, human);
    assert.deepEqual([prompts.length, edits], [2, 1]);
    assert.doesNotMatch(prompts[0]!, /Your last report was malformed/u);
    assert.ok(prompts[1]!.includes(sentBack("criteria must be an array")), prompts[1]);
    // The report goes straight back to the reviewer: no repair, no review round.
    assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "test", "change", "review", "review", ...(second === "valid" ? [] : ["decide"])]);
    assert.equal(result.states.includes("reviewBudget"), false);
    const run = second === "valid" ? held(f, result, /^Delivered/u) : handedOff(f, result, /review report was malformed twice: criteria must be an array\./u, human);
    if (second === "valid") assert.equal(result.state, "delivered");
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
    assert.notDeepEqual(keptIn(run.directory, "criteria must be an array"), [], "the fault is kept in the review's evidence");
  });
}

test("a malformed review report goes back once per entry into review: a later review gets its own send-back", async context => {
  const f = fixture(context); const prompts: string[] = []; let edits = 0;
  const malformed = () => review("approved", "Claims approval", { newSinceLastRound: false });
  const result = await execute(input(f), {
    implementer: request => { edits++; return implement(request); },
    reviewer: request => {
      prompts.push(request.prompt);
      return [malformed, () => review("revise", "Handle empty input"), malformed, () => review()][prompts.length - 1]!();
    },
  });
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  assert.deepEqual([prompts.length, edits], [4, 2]);
  for (const index of [1, 3]) assert.ok(prompts[index]!.includes(sentBack("newSinceLastRound must be a string")), `review ${index + 1}`);
  assert.doesNotMatch(prompts[2]!, /Your last report was malformed/u);
  assert.deepEqual([evidence(f).result.repairs, evidence(f).result.reviewRounds], [0, 1]);
});

for (const [role, stage, state] of [["tester", "test", "test"], ["implementer", "change", "change"]] as const) {
  test(`a malformed ${role} report goes back once to the ${role} with its exact fault, kept in the evidence, and a valid second report continues`, async context => {
    const f = fixture(context); const prompts: string[] = [];
    const valid: Runner = role === "tester" ? tester : implement;
    const result = await execute(input(f), {
      [role]: (request: Request) => { prompts.push(request.prompt); return prompts.length === 1 ? { type: "completed", summary: " " } : valid(request); },
    });
    assert.equal(result.state, "delivered", evidence(f).delivery.reason);
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0]!, /Your last report was malformed/u);
    assert.ok(prompts[1]!.includes(sentBack(summaryFault(stage))), prompts[1]);
    const states = route(result.states);
    assert.deepEqual(states.slice(states.indexOf(state)), [state, state, ...(state === "test" ? ["change"] : []), "review"]);
    const run = held(f, result, /^Delivered/u);
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
    assert.notDeepEqual(keptIn(run.directory, summaryFault(stage)), [], "the fault is kept in the evidence");
  });
}


for (const [state, outcome] of [["falsify", "sound"], ["plan", "planned"], ["planReview", "approved"]] as const) {
  test(`a blank ${state} summary goes back once to the same role with its exact fault, kept in the evidence, and a valid second report continues`, async context => {
    const f = fixture(context); const prompts: string[] = []; const calls: string[] = [];
    const reading = (name: string): Runner => request => {
      calls.push(name);
      if (name !== state) return planning[name]!.answer(request);
      prompts.push(request.prompt);
      return prompts.length === 1 ? { type: outcome, summary: " \n" } : planning[name]!.answer(request);
    };
    const result = await execute(input(f), { falsify: reading("falsify"), plan: reading("plan"), planReview: reading("planReview") });
    assert.equal(result.state, "delivered", evidence(f).delivery.reason);
    assert.deepEqual(calls, ["falsify", "plan", "planReview"].flatMap(name => name === state ? [name, name] : [name]));
    assert.doesNotMatch(prompts[0]!, /Your last report was malformed/u);
    assert.ok(prompts[1]!.includes(sentBack(summaryFault(state))), prompts[1]);
    const run = held(f, result, /^Delivered/u);
    for (const name of [`${state}-1.json`, `${state}-2.json`]) assert.ok(existsSync(join(run.directory, name)), name);
    assert.notDeepEqual(keptIn(run.directory, summaryFault(state)), [], "the fault is kept in the evidence");
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
  });
}

test("a summary fault and a structured review fault share one send-back allowance", async context => {
  const f = fixture(context); const human = person("hand off"); const prompts: string[] = [];
  const result = await execute(input(f), {
    reviewer: request => {
      prompts.push(request.prompt);
      return prompts.length === 1 ? review("approved", " ") : review("approved", "Reviewed", { criteria: undefined });
    },
  }, human);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1]!.includes(sentBack(summaryFault("review"))));
  const run = handedOff(f, result, /review report was malformed twice: criteria must be an array\./u, human);
  assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
  for (const fault of [summaryFault("review"), "criteria must be an array"]) assert.notDeepEqual(keptIn(run.directory, fault), []);
});

test("a malformed review send-back does not hide the previous round's unchanged blockers", async context => {
  const f = fixture(context); const human = person("hand off"); let reviews = 0; let edits = 0;
  const result = await execute(input(f), {
    implementer: request => { edits++; return implement(request); },
    reviewer: () => ++reviews === 2 ? review("approved", "Wrong shape", { criteria: undefined })
      : review("revise", "Handle empty input", { newSinceLastRound: "none" }),
  }, human);
  const run = handedOff(f, result, /Review is not converging/u, human);
  assert.deepEqual([reviews, edits, run.result.reviewRounds], [3, 2, 1]);
});

for (const stage of ["plan", "planReview"] as const) {
  test(`${stage} gets one summary send-back in each entry without spending the plan revision`, async context => {
    const f = fixture(context); const prompts: string[] = []; let reviewed = 0;
    const result = await execute(input(f), {
      plan: request => {
        if (stage !== "plan") return planning.plan!.answer(request);
        prompts.push(request.prompt);
        return prompts.length % 2 ? ok("planned", "x".repeat(16001)) : planning.plan!.answer(request);
      },
      planReview: request => {
        if (stage === "planReview") {
          prompts.push(request.prompt);
          if (prompts.length % 2) return ok("approved", "x".repeat(16001));
        }
        return ++reviewed === 1 ? ok("revise", "Name the test file") : planning.planReview!.answer(request);
      },
    });
    assert.equal(result.state, "delivered");
    assert.equal(prompts.length, 4);
    for (const index of [1, 3]) assert.ok(prompts[index]!.includes(sentBack(summaryFault(stage))));
    for (const index of [0, 2]) assert.doesNotMatch(prompts[index]!, /Your last report was malformed/u);
    assert.deepEqual([evidence(f).result.repairs, evidence(f).result.reviewRounds], [0, 0]);
  });
}

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
    assert.deepEqual(result.states.slice(0, 5), ["shape", "prepare", "setup", "start", "falsify"]);
    // The Operations that follow the three read-only states are the Machine's own; the ticket names only the Agent states and their order.
    assert.deepEqual(result.states.slice(0, result.states.indexOf("test")).filter(isPlanning), ["falsify", "plan", "planReview"]);
    assert.deepEqual(result.states.slice(result.states.indexOf("test")), ["test", "scopeAfterTest", "red", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success",
      ...(output === "pr" ? ["checkMerge", "cleanUp", "merged"] : ["delivered"])]);
    // A merged pull request's branch is gone; its commit is the one the receipt names.
    const commit = output === "pr" ? evidence(f).delivery.commit : git(f.repo, "rev-parse", branch);
    const run = ended(f, result, output, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
    assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", commit), "Add a greeting\nTicket: PROJ-12");
    assert.equal(git(f.repo, "rev-parse", `${commit}^`), f.head);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", commit), "greeting.test.txt\ngreeting.txt");
    assert.equal(git(f.repo, "show", `${commit}:greeting.txt`), "hello");
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
    if (output !== "pr") { assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.deepEqual(gh.views(), []); return; }
    assert.equal(pushed.atCheck(), `refs/heads/${branch} ${commit}`); assert.equal(pushed(), "");
    const body = join(run.directory, "pull-request.md");
    assert.deepEqual(gh(), ["pr", "create", "--repo", slug, "--draft", "--base", "main", "--head", branch, "--title", "Add a greeting", "--body-file", body]);
    assert.equal(readFileSync(body, "utf8"), "Add a greeting\n\n## Summary\n\nWrite hello to greeting.txt.\n\n## Checks\n\n- tests: passed\n\n## Review\n\nGreeting matches the ticket\n\nTicket: PROJ-12\n");
    assert.equal(gh.views().length, 1);
  });
}

test("an explicit branch base starts the worktree there and becomes the pull request base", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  git(f.repo, "branch", "release"); git(f.repo, "push", "-q", "origin", "release"); writeFileSync(join(f.repo, "code.txt"), "newer"); git(f.repo, "commit", "-qam", "newer"); f.head = git(f.repo, "rev-parse", "HEAD");
  const result = await execute(input(f, { output: "pr", base: "release", draft: false }));
  const run = merged(f, result);
  assert.equal(git(f.repo, "rev-parse", `${run.delivery.commit}^`), git(f.repo, "rev-parse", "release")); assert.equal(run.delivery.baseCommit, git(f.repo, "rev-parse", "release"));
  assert.deepEqual(gh()!.slice(0, 8), ["pr", "create", "--repo", slug, "--base", "release", "--head", branch]);
  assert.equal(readFileSync(join(f.repo, "code.txt"), "utf8"), "newer");
});

test("a base that is a commit rather than a branch opens the pull request against the remote's default branch by name", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  const result = await execute(input(f, { output: "pr", base: f.head }));
  merged(f, result); assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "main", "--head", branch]);
});

test("gh is given the checked base by name, so a configured gh-merge-base cannot turn the pull request elsewhere", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  // release is ahead of main on the remote; gh would take it from this configuration if it were left to choose the base.
  git(f.repo, "checkout", "-q", "-b", "release"); git(f.repo, "commit", "-q", "--allow-empty", "-m", "released"); git(f.repo, "push", "-q", "origin", "release");
  git(f.repo, "checkout", "-q", "main"); git(f.repo, "config", `branch.${branch}.gh-merge-base`, "release");
  const result = await execute(input(f, { output: "pr" }), {
    implementer: request => { git(request.cwd, "config", "branch.main.gh-merge-base", "release"); return implement(request); },
  });
  const commit = merged(f, result).delivery.commit; untouched(f);
  assert.equal(git(f.repo, "rev-parse", `${commit}^`), f.head);
  assert.deepEqual(pushed.atCheck().split("\n"), [`refs/heads/release ${git(f.repo, "rev-parse", "release")}`, `refs/heads/${branch} ${commit}`]);
  assert.equal(pushed(), `refs/heads/release ${git(f.repo, "rev-parse", "release")}`);
  assert.deepEqual(gh()!.slice(0, 9), ["pr", "create", "--repo", slug, "--draft", "--base", "main", "--head", branch]);
});

test("the default branch gh is given is the one the remote names, and a remote that names none is refused before any Agent", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const bare = join(f.root, "remote.git");
  git(f.repo, "push", "-q", "origin", "main:trunk"); git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk");
  const result = await execute(input(f, { output: "pr" }));
  merged(f, result); assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "trunk", "--head", branch]);
  const before = pushed(); const views = gh.views(); rmSync(join(f.root, "bin", "args"));
  // A detached HEAD on the remote still has a commit to compare with, but no branch for gh to be given.
  git(bare, "update-ref", "--no-deref", "HEAD", f.head); const second = { ...f, evidence: join(f.root, "evidence-2") };
  const unnamed = await execute({ ...input(second, { output: "pr" }), ticket: { ...input(f).ticket, id: "PROJ-13", title: "Add a farewell" } }, { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(unnamed.state, "refused"); assert.deepEqual(unnamed.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
  held(second, unnamed, /^Refused: Remote origin does not say which branch is its default, so the pull request base cannot be named\. Set repository\.base to a branch; nothing was changed\. Evidence: /u);
  assert.equal(pushed(), before); assert.equal(gh(), undefined); assert.deepEqual(gh.views(), views); assert.equal(git(f.repo, "branch", "--list", "ticket/proj-13*"), "");
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
  test(`${label} asks before any Agent, naming setup and its error, and hand off keeps the worktree`, async context => {
    const f = fixture(context); const human = person("hand off");
    const result = await execute(input(f, { setup: [command(code)] }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
    const run = steppedOff(f, result, "setup", "stepDecide", reason, human, 0); untouched(f);
    assert.deepEqual(result.states, ["shape", "prepare", "setup", "stepFailed", "stepDecide", "handOff", "handedOff"]);
    assert.deepEqual([run.result.checks[0].phase, run.result.checks[0].passed, existsSync(run.result.checks[0].log)], ["setup", label.startsWith("a setup"), true]);
    assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`); assert.equal(run.delivery.commit, null);
  });
}

test("a failing setup command asked about is discarded only after confirmation, and go back asks the same question again", async context => {
  const f = fixture(context); let unconfirmed = false;
  const human = person("discard", "go back", "discard", () => { unconfirmed = existsSync(join(f.worktree, "code.txt")) && git(f.repo, "rev-parse", branch) === f.head; return "confirm discard"; });
  const result = await execute(input(f, { setup: [command("process.exit(3)")] }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  assert.ok(unconfirmed, "nothing was removed before the discard was confirmed");
  assert.deepEqual(result.states, ["shape", "prepare", "setup", "stepFailed", "stepDecide", "confirmStepDiscard", "stepFailed", "stepDecide", "confirmStepDiscard", "remove", "abandon", "abandoned"]);
  const run = abandoned(f, result, "discard");
  const [first, confirm, second, again] = human.requests;
  stepAsked(f, first, "setup", /setup: tests did not meet/u, stepChoices); assert.deepEqual([second!.prompt, second!.choices], [first!.prompt, first!.choices]);
  for (const request of [confirm!, again!]) {
    assert.deepEqual(request.choices, ["confirm discard", "go back"]); assert.equal(request.suggestions, undefined);
    evidencePage(f, request, "setup", /tests did not meet/u, ["tests"], ["confirm discard", "go back"], "go back");
    for (const part of [f.worktree, branch, "will not be saved"]) assert.ok(request.prompt.includes(part), part);
    assert.doesNotMatch(request.prompt, /\bstuck\b/iu);
  }
  // Each time the step asks, its question is written; the confirmation is not a question of its own.
  asksWritten(run.directory, [first!, second!]);
  assert.deepEqual(run.result.decisions.map((made: any) => `${made.stage}: ${made.response}`),
    ["stepDecide: discard", "confirmStepDiscard: go back", "stepDecide: discard", "confirmStepDiscard: confirm discard"]);
  assert.ok(result.output.summary.includes(`Decision: discard. Worktree and ${branch} removed without saving the candidate. Evidence: `));
});

test("retry reruns only a setup that failed, as often as it is asked, and a setup that then passes goes on to deliver", async context => {
  const f = fixture(context); const counter = join(f.root, "setup-runs");
  // Fails on its first two runs and passes on the third. The count is kept outside the worktree, so it leaves nothing there.
  const flaky = `const fs = require("fs"); const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0; `
    + `fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1)); if (n < 2) { console.log("install failed " + (n + 1)); process.exit(3); }`;
  const human = person("retry", "retry");
  const result = await execute(input(f, { setup: [command(flaky, { name: "install" })] }), {}, human);
  assert.equal(result.state, "delivered"); untouched(f);
  // Whatever passes the answer on, only setup runs again: the worktree is made once, and planning starts after the setup that passed.
  assert.deepEqual(result.states.filter(state => ["shape", "prepare", "setup", "stepFailed", "stepDecide", "start", "falsify"].includes(state)).slice(0, 11),
    ["shape", "prepare", "setup", "stepFailed", "stepDecide", "setup", "stepFailed", "stepDecide", "setup", "start", "falsify"]);
  assert.equal(result.states.filter(state => state === "prepare").length, 1, "the worktree is made once");
  const run = held(f, result, /^Delivered/u);
  assert.equal(human.requests.length, 2);
  for (const request of human.requests) stepAsked(f, request, "setup", /setup: install did not meet its expected result/u, stepChoices);
  asksWritten(run.directory, human.requests);
  assert.deepEqual(run.result.checks.filter((check: any) => check.phase === "setup").map((check: any) => check.passed), [false, false, true]);
  assert.deepEqual(run.result.decisions, [{ stage: "stepDecide", response: "retry" }, { stage: "stepDecide", response: "retry" }]);
  assert.equal(readFileSync(counter, "utf8"), "3"); assert.equal(run.delivery.worktreeRemoved, true);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
});

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
  test(`an existing ${label} is refused with the reason, without asking and without changing anything`, async context => {
    const f = fixture(context); occupy(f); const human = person();
    const branches = git(f.repo, "branch", "--format=%(refname:short) %(objectname)");
    const result = await execute(input(f, { setup: [command("process.exit(1)")] }), { investigator: () => assert.fail() }, human);
    assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
    assert.deepEqual(human.requests, []);
    const run = refused(f, result, /already exists/u); assert.ok(result.output.summary.startsWith(`Refused: ${found.replace("<repo>", f.repo)} `));
    assert.ok(run.delivery.reason.startsWith(found.replace("<repo>", f.repo)), run.delivery.reason);
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
      calls.push("planReview"); assert.equal(request.cwd, f.worktree); assert.deepEqual([...request.outcomes].sort(), ["approved", "revise", "tooBroad"]);
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

type Checkpoint = { value: any; context: any; data: any };
/**
 * Primitives whose p.data hands the working data back from a checkpoint when one is given, as the launcher does for a continued run,
 * and hooks that save a checkpoint at every state entry as the launcher does: data captured before the step's input, then written on entry.
 */
function checkpointed(from?: Checkpoint) {
  let live: object | undefined;
  let captured: { data: any; context: any } | undefined;
  const saved: Record<string, Checkpoint> = {};
  // A checkpoint holds plain JSON: an undefined value or a runtime object in the working data would not come back as it was.
  const unsaveable: string[] = [];
  const capture = (context: unknown) => {
    captured = { data: live === undefined ? undefined : JSON.parse(JSON.stringify(live)), context: JSON.parse(JSON.stringify({ context })).context };
  };
  const primitives = { ...runtime, data: <T extends object>(initial: T): T => {
    runtime.data(initial);
    return (live = from ? structuredClone(from.data) as T : initial) as T;
  } };
  const hooks: RunHooks = {
    onBeforeStep: capture,
    onEnter: entry => {
      if (captured === undefined) capture(entry.context);
      if (live !== undefined && !isDeepStrictEqual(JSON.parse(JSON.stringify(live)), live)) unsaveable.push(String(entry.value));
      saved[String(entry.value)] = { value: entry.value, ...captured! };
      captured = undefined;
    },
  };
  return { options: { primitives, ...hooks }, saved, unsaveable, data: () => live as Record<string, any> | undefined };
}
/**
 * Runs a ticket as Machines Dispatch does with its sleep option: a run that sleeps at a timed wait ends there, and is continued from its
 * checkpoint as a later process would continue it once the wait is due. No input says how long a wait is. Returns how the last run ended,
 * every state the runs went through, each sleep with the time its wait began, and any state whose working data was not plain JSON.
 */
async function untilEnd(assignment: unknown, agents: Record<string, Runner> = {}, human: (request: Ask) => string = person(), onEnter?: RunHooks["onEnter"]) {
  const states: string[] = []; const sleeps: { enteredAt: string; due: string; retry?: { attempt: number; of: number } }[] = []; const unsaveable: string[] = [];
  let saves = checkpointed(); let continueAt: RunHooks["continueAt"]; let waiting = "";
  // An Operation that retries sleeps between its attempts as a timed wait does; the checkpoint then carries which attempt comes next.
  let retrying: { attempt: number; of: number } | undefined; const retries: Record<string, { attempt: number; of: number }> = {};
  for (let runs = 1; ; runs++) {
    assert.ok(runs <= 20, "the run kept sleeping");
    const result = await execute(assignment, agents, human, {
      ...saves.options, ...(continueAt ? { continueAt } : {}),
      onEnter: entry => {
        saves.options.onEnter!(entry);
        if (entry.retry) retries[String(entry.value)] = entry.retry; else delete retries[String(entry.value)];
        if (entry.kind === "wait" || entry.retry) { waiting = entry.enteredAt; retrying = entry.retry; }
        onEnter?.(entry);
      },
      onSleep: due => { sleeps.push({ enteredAt: waiting, due, ...(retrying ? { retry: retrying } : {}) }); },
    });
    // A continued run first reports the state it starts in, which the run before it reported last.
    states.push(...(continueAt ? result.states.slice(1) : result.states)); unsaveable.push(...saves.unsaveable);
    if (sleeps.length < runs) return { ...result, states, sleeps, unsaveable };
    const checkpoint = saves.saved[String(result.state)];
    assert.ok(checkpoint, `a checkpoint was saved on entering ${String(result.state)}, where the run slept`);
    const retry = retries[String(result.state)];
    continueAt = { value: checkpoint.value, context: checkpoint.context, due: new Date(0).toISOString(), ...(retry ? { retry } : {}) };
    saves = checkpointed(checkpoint);
  }
}

test("a run stopped in plan review continues from its checkpoint with its branch, base commit, and plan, and finishes as an uninterrupted run does", async context => {
  /** Every Agent request a run makes, by state, and the runners that answer as the sound-ticket run above does. */
  const answering = (stopIn?: string) => {
    const prompts: [string, string][] = [];
    const answer = (state: string, runner: Runner): Runner => request => {
      prompts.push([state, request.prompt]);
      if (state === stopIn) throw new Error(`interrupted in ${state}`);
      return runner(request);
    };
    return { prompts, agents: {
      ...Object.fromEntries(Object.entries(planning).map(([state, { answer: runner }]) => [state, answer(state, runner)])),
      tester: answer("test", tester), implementer: answer("change", implement), reviewer: answer("review", () => review()),
    } };
  };
  const finished = (f: Fixture, result: Awaited<ReturnType<typeof execute>>) => {
    assert.equal(result.state, "delivered");
    const run = held(f, result, /^Delivered/u);
    const commit = git(f.repo, "rev-parse", branch);
    assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
    // Paths and hashes differ between fixtures; what the run did and said does not.
    const stable = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(run.directory, "<evidence>").replaceAll(f.root, "<root>")
      .replaceAll(commit, "<commit>").replaceAll(f.head, "<base>"));
    const { startedAt, finishedAt, ...receipt } = run.result;
    assert.equal(startedAt, JSON.parse(readFileSync(join(run.directory, "started.json"), "utf8")).startedAt);
    assert.match(finishedAt, /^\d{4}-/u);
    return {
      run, result: stable(receipt), delivery: stable(run.delivery), output: stable(result.output),
      files: readdirSync(run.directory).sort(), tree: git(f.repo, "rev-parse", `${branch}^{tree}`),
      message: git(f.repo, "log", "-1", "--format=%s%n%b", branch), stable,
    };
  };

  // An uninterrupted run on a fixture of its own is the measure.
  const g = fixture(context); const whole = answering(); const wholeSaves = checkpointed();
  const uninterrupted = await execute(input(g, {}, { stuck: "park" }), whole.agents, person(), wholeSaves.options);
  const expected = finished(g, uninterrupted);
  assert.deepEqual(wholeSaves.unsaveable, [], "every state's working data is plain JSON");

  // The first run stops once plan review has started, after its checkpoint was saved, as a process that ends there would.
  const f = fixture(context); const first = answering("planReview"); const firstSaves = checkpointed();
  await assert.rejects(execute(input(f, {}, { stuck: "park" }), first.agents, person(), firstSaves.options), /interrupted in planReview/u);
  // The Agent state asks plan review once more after the first throw, and the run stops on the second.
  assert.deepEqual(first.prompts.map(([state]) => state), ["falsify", "plan", "planReview", "planReview"]);
  assert.deepEqual(firstSaves.unsaveable, [], "every state's working data is plain JSON");
  const checkpoint = firstSaves.saved.planReview;
  assert.ok(checkpoint, "a checkpoint was saved on entering planReview");
  assert.ok(checkpoint.data, "the run keeps its working data in saved data");
  assert.notEqual(checkpoint.context, undefined);
  // The branch, base commit, and plan are in the checkpoint as the run had them.
  assert.equal(checkpoint.data.branch, branch);
  assert.equal(checkpoint.data.baseCommit, f.head);
  assert.equal(checkpoint.data.plan, plan);
  assert.equal(git(f.repo, "rev-parse", branch), f.head);
  assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);

  // The continued run is a new Machine from the same input, given the saved data and started at the saved state.
  const rest = answering(); const restSaves = checkpointed(checkpoint);
  const continued = await execute(input(f, {}, { stuck: "park" }), rest.agents, person(),
    { ...restSaves.options, continueAt: { value: checkpoint.value, context: checkpoint.context } });
  assert.deepEqual(restSaves.unsaveable, [], "every state's working data is plain JSON");
  const restored = restSaves.data()!;
  assert.deepEqual([restored.branch, restored.baseCommit, restored.plan], [branch, git(f.repo, "rev-parse", `${branch}^`), plan]);

  // Nothing before plan review runs again, and plan review is asked exactly what it was asked before the stop.
  assert.deepEqual(continued.states, uninterrupted.states.slice(uninterrupted.states.indexOf("planReview")));
  assert.equal(rest.prompts[0]![0], "planReview");
  assert.equal(rest.prompts[0]![1], first.prompts[2]![1]);
  assert.ok(planIn(rest.prompts[0]![1]).startsWith(plan));

  // It finishes as the uninterrupted run did: one evidence directory whose numbering carries on, the same receipts, hold, and commit.
  const actual = finished(f, continued);
  assert.deepEqual(actual.files, expected.files);
  assert.ok(actual.files.includes("started.json"));
  assert.deepEqual(actual.result, expected.result);
  assert.deepEqual(actual.delivery, expected.delivery);
  assert.deepEqual(actual.output, expected.output);
  assert.equal(actual.tree, expected.tree);
  assert.equal(actual.message, expected.message);
  // Every prompt from plan review on is the one the uninterrupted run built.
  const fromPlanReview = (prompts: [string, string][], stable: (value: unknown) => unknown) =>
    stable(prompts.slice(prompts.findIndex(([state]) => state === "planReview")));
  assert.deepEqual(fromPlanReview(rest.prompts, actual.stable), fromPlanReview(whole.prompts, expected.stable));
});

for (const [policy, assume] of [["park", undefined], [undefined, undefined], ["park", false], [undefined, false]] as const) {
  test(`${policy ?? "default"} stuck policy with assume ${assume ?? "left out"} asks about a ticket falsified with two questions, both of them, one assumable, each with its options and the recommended one first`, async context => {
    const f = fixture(context); const human = person("hand off");
    const questions = [language, beside];
    const data = input(f, {}, assume === undefined ? {} : { assume });
    if (policy === undefined) Reflect.deleteProperty(data, "stuck"); else data.stuck = policy;
    const result = await execute(data, {
      falsify: () => gaps(questions, "The ticket leaves two things open"),
      plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    const run = questioned(f, result, /\S/u, human);
    // The investigator's questions go to the owner as a review's do: numbered and with no location.
    const needs: string[] = run.needs.split("\n");
    // Each keeps one line, which goes on to its options: "English" is recommended, and the investigator listed it last.
    assert.match(needs[0]!, openQuestions); assert.equal(needs.length, 3);
    for (const [index, asked] of questions.entries()) optionsFirst(needs[index + 1]!, index + 1, asked);
    // With assume off the assumable question is the owner's like the other, and nothing is said of what would have been assumed.
    assert.doesNotMatch(run.needs, /would have assumed/iu);
    showsNeed(run.prompt, run.needs, f.worktree);
    for (const question of questions) assert.ok(run.delivery.reason.includes(question.text), question.text);
    assert.deepEqual(run.result.agents, [{ stage: "falsify", outcome: "questions", summary: "The ticket leaves two things open" }]);
    assert.equal(result.states[4], "falsify"); assert.equal(result.states.some(state => state === "plan" || state === "planReview" || state === "test" || state === "change"), false);
    assert.deepEqual(candidate(f.worktree), { status: "", files: [["code.txt", 0, Buffer.from("old").toString("base64")]] });
    assert.deepEqual(run.result.checks, []);
    assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
  });
}

test("with assume left out or false, a report whose every question is assumable still asks about all of them and assumes nothing", async context => {
  for (const extra of [{}, { assume: false }]) {
    const f = fixture(context); const human = person("hand off");
    const result = await execute(input(f, {}, { stuck: "park", ...extra }), { falsify: () => gaps([beside, newline], "Two gaps, each with a conservative answer"), plan: () => assert.fail() }, human);
    const run = questioned(f, result, /stand beside it\?/u, human);
    const needs: string[] = run.needs.split("\n"); assert.equal(needs.length, 3);
    optionsFirst(needs[1]!, 1, beside); optionsFirst(needs[2]!, 2, newline);
    assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
  }
});

test("ten questions are the most a falsified ticket asks about, and all ten are kept", async context => {
  const f = fixture(context); const human = person("hand off");
  const questions = Array.from({ length: 10 }, (_, index) => gap(`What does part ${index + 1} of the greeting say?`));
  const result = await execute(input(f, {}, { stuck: "park" }), { falsify: () => gaps(questions, "The ticket leaves ten things open"), plan: () => assert.fail() }, human);
  const run = questioned(f, result, /\S/u, human);
  const needs: string[] = run.needs.split("\n"); assert.equal(needs.length, 11);
  for (const [index, asked] of questions.entries()) optionsFirst(needs[index + 1]!, index + 1, asked);
  assert.match(run.delivery.reason, /\b10 open questions:/u);
});

test("a falsify question that runs over several lines and 600 characters takes one line of the question with its text capped, and the hold stays one line", async context => {
  const f = fixture(context); const human = person("hand off");
  const long = gap(`Which language is the greeting in?\n${"The ticket names none,\nand the product ships in several. ".repeat(14)}`.trim(),
    { options: ["English", "The reader's\nlocale"], recommended: "English", why: "The product ships\nin several languages." });
  const short = gap("Does greeting.txt replace code.txt\nor stand beside it?", { why: "Nothing in the ticket\nsays which." });
  const result = await execute(input(f, {}, { stuck: "park" }), {
    falsify: () => gaps([long, short], "The ticket leaves two things open"),
    plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /Which language is the greeting in\?/u, human);
  const whole = oneLine(long.text); const cut = `${whole.slice(0, 600)}…`;
  assert.ok(whole.length > 700); assert.ok(long.text.includes("\n"));
  // The question gives each one line, with the question's text cut at 600 characters.
  const needs: string[] = run.needs.split("\n");
  // Options and a reason written over several lines stay on their question's line.
  assert.match(needs[0]!, openQuestions); assert.equal(needs.length, 3);
  optionsFirst(needs[1]!, 1, long, cut); optionsFirst(needs[2]!, 2, short);
  assert.equal(needs[1]!.includes(whole), false);
  // The reason is never cut.
  assert.ok(oneLine(run.delivery.reason).includes(whole));
  assert.doesNotMatch(result.output.summary, /\n/u);
});

const without = (asked: Gap, field: keyof Gap) => Object.fromEntries(Object.entries(asked).filter(([key]) => key !== field));
/** What questionField says of a report whose questions field is not a list it can use. */
const notAList = "questions must be an array of 1–10 entries";
/** Where the falsify prompt says the questions go. */
const questionsGo = [/\bquestions field\b/u, /\bnot (?:in )?the summary or (?:the )?message\b/u];
// Each report has one thing wrong. Where an entry is at fault it is the second, after one that is sound and assumable.
for (const [label, questions, named, reason] of [
  ["left out", undefined, /\bquestions\b/u, notAList],
  ["a string rather than an array", "Which language is the greeting in?", /\bquestions\b/u, notAList],
  ["an empty array", [], /\bquestions\b/u, notAList],
  ["an array of eleven", Array.from({ length: 11 }, (_, index) => gap(`What does part ${index + 1} of the greeting say?`)), /\bquestions\b/u, notAList],
  ["an array of plain strings, as it was before a question carried its options", ["Which language is the greeting in?"], /\bquestions\[0\]/u, "questions[0] must be an object"],
  ["an array holding a value that is not an object", [beside, 7], /\bquestions\[1\]/u, "questions[1] must be an object"],
  ["an array holding an entry with a blank text", [beside, { ...language, text: " \n" }], /\bquestions\[1\]\.text\b/u, "questions[1].text must be a non-empty string"],
  ["an array holding an entry whose text is not a string", [beside, { ...language, text: 7 }], /\bquestions\[1\]\.text\b/u, "questions[1].text must be a non-empty string"],
  ["an array holding an entry without options", [beside, without(language, "options")], /\bquestions\[1\]\.options\b/u, "questions[1].options must be a non-empty array of non-empty strings"],
  ["an array holding an entry whose options are not an array", [beside, { ...language, options: "English" }], /\bquestions\[1\]\.options\b/u, "questions[1].options must be a non-empty array of non-empty strings"],
  ["an array holding an entry with no options to choose from", [beside, { ...language, options: [] }], /\bquestions\[1\]\.options\b/u, "questions[1].options must be a non-empty array of non-empty strings"],
  ["an array holding an entry with a blank option", [beside, { ...language, options: ["English", " "] }], /\bquestions\[1\]\.options\b/u, "questions[1].options must be a non-empty array of non-empty strings"],
  ["an array holding an entry with an option that is not a string", [beside, { ...language, options: ["English", 7] }], /\bquestions\[1\]\.options\b/u, "questions[1].options must be a non-empty array of non-empty strings"],
  ["an array holding an entry without a recommended answer", [beside, without(language, "recommended")], /\bquestions\[1\]\.recommended\b/u, "questions[1].recommended must be one of its options"],
  ["an array holding an entry whose recommended answer is not one of its options", [beside, { ...language, options: ["english", "French"] }], /\bquestions\[1\]\.recommended\b/u, "questions[1].recommended must be one of its options"],
  ["an array holding an entry that does not say whether it is assumable", [beside, without(language, "assumable")], /\bquestions\[1\]\.assumable\b/u, "questions[1].assumable must be a boolean"],
  ["an array holding an entry whose assumable is not a boolean", [beside, { ...language, assumable: "true" }], /\bquestions\[1\]\.assumable\b/u, "questions[1].assumable must be a boolean"],
  ["an array holding an entry without a why", [beside, without(language, "why")], /\bquestions\[1\]\.why\b/u, "questions[1].why must be a non-empty string"],
  ["an array holding an entry with a blank why", [beside, { ...language, why: " " }], /\bquestions\[1\]\.why\b/u, "questions[1].why must be a non-empty string"],
] as [string, unknown, RegExp, string][]) {
  for (const assume of [false, true]) {
    test(`a falsify report whose questions field is ${label}, given twice, is asked about with the field named${assume ? ", with assume on as with it off" : ""}`, async context => {
      const f = fixture(context); const human = person("hand off"); const prompts: string[] = [];
      const result = await execute(input(f, {}, { stuck: "park", ...(assume ? { assume } : {}) }), {
        falsify: request => { prompts.push(request.prompt); return { type: "questions", summary: "The ticket leaves the language open", ...(questions === undefined ? {} : { questions }) }; },
        plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
      }, human);
      // The question's own words say "questions", so the field is named by questionField's reason, which it gives whole.
      const run = questioned(f, result, named, human);
      for (const said of [run.needs, run.delivery.reason, result.output.summary]) {
        assert.ok(said.includes(reason), said); assert.match(said, /\bThe falsify report was malformed twice: /u); assert.doesNotMatch(said, /Malformed/u);
      }
      // The first report went back once with the same reason; the second is the one the question sends a person to.
      assert.equal(prompts.length, 2); assert.ok(prompts[1]!.includes(reason)); assert.equal(prompts[0]!.includes(reason), false);
      assert.ok(run.needs.includes(join(run.directory, "falsify-2.json")));
      // A report that is not well formed puts none of its questions to the owner and assumes nothing, the sound entry beside the bad one included.
      assert.deepEqual(numberedLines(run.needs.split("\n")), []); assert.doesNotMatch(run.needs, openQuestions);
      assert.doesNotMatch(run.needs, /What does part 11|would have assumed/iu);
      assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
      // Each report is a stage report before it is judged, so a refused one is still what the investigator said.
      const stage = { stage: "falsify", outcome: "questions", summary: "The ticket leaves the language open" };
      assert.deepEqual([run.result.agents, run.result.agentInvocations], [[stage, stage], 2]);
      for (const name of ["agent-1.json", "agent-2.json"]) assert.deepEqual(JSON.parse(readFileSync(join(run.directory, name), "utf8")), stage);
      // Too many questions are still the investigator's: all of them are kept with the evidence, none in the question.
      if (Array.isArray(questions) && questions.length === 11) assert.notDeepEqual(holding(run.directory, (questions as Gap[]).map(question => question.text)), []);
      assert.equal(candidate(f.worktree).status, ""); assert.deepEqual(run.result.checks, []);
    });
  }
}

for (const [assumable, asked] of [[true, beside], [false, language]] as const) {
  test(`a falsify report with no questions field goes back to the investigator once with the reason and where the questions go, and ${assumable ? "an assumable" : "a not assumable"} question that follows ${assumable ? "is assumed and planned from" : "is asked"}`, async context => {
    const f = fixture(context); const human = person(...(assumable ? [] : ["hand off"])); const prompts: string[] = [];
    const reports = [{ type: "questions", summary: "The ticket leaves the language open" }, gaps([asked])];
    const result = await execute(input(f, {}, { stuck: "park", assume: true }), {
      falsify: request => { prompts.push(request.prompt); return reports[prompts.length - 1]!; },
      ...(assumable ? {} : { plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() }),
    }, human);
    assert.equal(prompts.length, 2);
    // Only the second prompt says what was wrong, in questionField's words; both say where the questions go.
    assert.equal(prompts[0]!.includes(notAList), false); assert.ok(prompts[1]!.includes(notAList));
    for (const prompt of prompts) for (const rule of questionsGo) assert.match(prompt, rule);
    if (assumable) {
      assert.equal(result.state, "delivered", evidence(f).delivery.reason);
      assert.deepEqual(route(result.states).slice(0, 3), ["falsify", "falsify", "plan"]);
      for (const state of ["stuck", "park", "decide"]) assert.equal(result.states.includes(state), false, state);
      const run = held(f, result, /^Delivered/u);
      assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "assumptions.json"), "utf8")), assumed([asked]));
      assert.deepEqual(run.delivery.assumptions, assumed([asked]));
      // The return spent no budget.
      assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
    } else {
      const run = questioned(f, result, /Which language is the greeting in\?/u, human);
      assert.equal(numberedLines(run.needs.split("\n")).length, 1);
      optionsFirst(run.needs.split("\n")[1]!, 1, asked);
      assert.doesNotMatch(run.needs, /missing or malformed/iu);
      assert.equal(existsSync(join(run.directory, "assumptions.json")), false);
    }
    // The malformed report is kept as every planning report is.
    const run = evidence(f);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(run.directory, "falsify-1.json"), "utf8")), "questions"), false);
    assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "falsify-2.json"), "utf8")).questions, [asked]);
  });
}

test("two malformed falsify reports are asked about after the second in plain words, with its reason and the evidence file that holds it", async context => {
  const f = fixture(context); const human = person("hand off"); const prompts: string[] = [];
  const second = "questions[0].why must be a non-empty string";
  const reports = [{ type: "questions", summary: "The ticket leaves the language open" }, gaps([without(language, "why")])];
  const result = await execute(input(f, {}, { stuck: "park", assume: true }), {
    falsify: request => { prompts.push(request.prompt); return reports[prompts.length - 1]!; },
    plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /\bThe falsify report was malformed twice: /u, human);
  assert.equal(prompts.length, 2); assert.equal(result.states.at(-5), "falsifyResult");
  assert.deepEqual(result.states.filter(isPlanning), ["falsify", "falsify"]);
  assert.ok(prompts[1]!.includes(notAList));
  const file = join(run.directory, "falsify-2.json");
  for (const said of [run.prompt, run.needs, run.delivery.reason, result.output.summary]) {
    assert.ok(said.includes(second), said); assert.ok(said.includes(file), said); assert.doesNotMatch(said, /Malformed/u);
  }
  // The file named holds the questions as the investigator wrote them, for a person to read.
  assert.ok(readFileSync(file, "utf8").includes(language.text));
  assert.deepEqual(numberedLines(run.needs.split("\n")), []); assert.equal(existsSync(join(run.directory, "assumptions.json")), false);
  assert.equal(run.result.agentInvocations, 2); assert.equal(candidate(f.worktree).status, "");
});

test("a run stuck on a falsify report malformed twice gives the fault in its first sentence, once, and where the report is kept under it", async context => {
  const f = fixture(context); const human = person("hand off");
  const fault = "questions[0].why must be a non-empty string";
  const reports = [{ type: "questions", summary: "The ticket leaves the language open" }, gaps([without(language, "why")])];
  let calls = 0;
  const result = await execute(input(f), {
    falsify: () => reports[calls++]!,
    plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /The falsify report was malformed twice: /u, human);
  const [first] = run.prompt.split("\n");
  assert.equal(first, `The falsify report was malformed twice: ${fault}.`); assert.ok(first!.length < 100, first);
  assert.equal(occurrences(run.prompt, fault), 1);
  assert.ok(run.prompt.includes(`\nNeeds: The report is kept in ${join(run.directory, "falsify-2.json")}.\nWorktree: `), run.prompt);
});

test("a run stuck on a review report malformed twice gives the fault in its first sentence, and only there", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { reviewer: () => review("approved", "Claims approval", { criteria: undefined }) }, human);
  handedOff(f, result, /review report was malformed twice: criteria must be an array\./u, human);
  const [request, ...others] = human.requests; assert.deepEqual(others, []);
  stuckQuestion(f, request, "reviewResult");
  assert.equal(request!.prompt.split("\n")[0], "The review report was malformed twice: criteria must be an array.");
  assert.equal(occurrences(request!.prompt, "criteria must be an array"), 1);
  assert.ok(result.output.summary.startsWith("Handed off: The review report was malformed twice: criteria must be an array. "), result.output.summary);
  assert.ok(result.output.summary.includes(". Decision: hand off. Branch: "), result.output.summary);
});

/** The Human request a presenter was given, as the runtime writes it on its own line of the presenter's prompt. */
const presentedRequest = (prompt: string): Ask => JSON.parse(prompt.split("\n").find(line => line.startsWith("Request: "))!.slice("Request: ".length));
/** The facts the Machine gave the presenter: the last section of its prompt. */
function factsOf(prompt: string) {
  const at = prompt.indexOf("\n\nMachine facts: ");
  assert.ok(at >= 0, "the presenter was given the Machine's facts");
  const facts = prompt.slice(at + "\n\nMachine facts: ".length); assert.match(facts, /\S/u, "the Machine's facts are not empty");
  return facts;
}
/** What a presenter adds to a question: a headline, the recommended option, what each option does, which destroy work, why, and a page. */
const explanation = (asked: Ask, recommended: string) => {
  const options = asked.choices ?? asked.suggestions ?? [];
  return {
    headline: `Choose ${recommended}: the run stopped where it can still finish.`, recommended,
    effects: Object.fromEntries(options.map(option => [option, `What ${option} does, in one line.`])),
    discards: options.filter(option => ["discard", "confirm discard"].includes(option) && option !== recommended),
    reason: `${recommended} fits this stop.`,
    page: `<h2>Where the run stopped</h2><pre class="mermaid">flowchart LR\n  review --> decide</pre><ul><li>${options.join("</li><li>")}</li></ul>`,
  };
};
/** A presenter as a small model would be bound: it keeps what it was given and explains each question, recommending what `pick` chooses. */
function presenter(pick: (asked: Ask) => string) {
  const prompts: string[] = []; const asked: Ask[] = [];
  return Object.assign((request: Request) => {
    prompts.push(request.prompt); const question = presentedRequest(request.prompt); asked.push(question);
    return { type: "presented", ...explanation(question, pick(question)) };
  }, { prompts, asked });
}
// The reviewer approves and every check passes, but the report is malformed: it goes back once, comes back malformed again, and the run stops.
const approvedButMalformed = () => review("approved", "Approves the greeting", { newSinceLastRound: false });

/** Inspect the deterministic presentation, without prescribing its prose or serialized facts schema. */
const pageText = (page: string) => oneLine(page.replace(/<[^>]*>/gu, " ")
  .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"')
  .replace(/&#(?:39|x27);/gu, "'").replace(/&amp;/gu, "&"));
function evidencePage(f: Fixture, request: Ask | undefined, stage: string, reason: RegExp,
  selected: readonly string[], options: readonly string[] = stuckDecisions, recommended = "hand off") {
  assert.ok(request, "the stopped run asked a Human");
  assert.equal(typeof request.page, "string", "the Machine supplies a page without a presenter");
  const page = request.page!;
  assert.ok(Buffer.byteLength(page, "utf8") < 200_000, "the escaped page is below 200 kB");
  assert.doesNotMatch(page, /<\/?(?:html|head|body|script|style|link|a|iframe)\b|<[a-z][^>]*\s(?:style|on\w+|src|href)\s*=/iu);
  assert.match(page, /<section\b[^>]*class=["']recap["']/u);
  assert.match(page, /<span\b[^>]*class=["']chip\s/u);
  const text = pageText(page);
  for (const part of ["widgets", f.repo, "PROJ-12", "Add a greeting", branch, f.worktree, ...selected]) {
    assert.ok(text.includes(oneLine(part)), `the page carries ${part.slice(0, 150)}`);
  }
  // A single recap paragraph or definition describes the stage and why it stopped.
  const sentences = [...page.matchAll(/<(p|dd)\b[^>]*>([\s\S]*?)<\/\1>/gu)].map(match => pageText(match[2]!));
  assert.ok(sentences.some(sentence => sentence.includes(stage) && reason.test(sentence)),
    `one stage sentence names ${stage} and ${reason}`);
  assert.match(request.headline ?? "", /\S/u);
  assert.ok(request.headline!.length <= 160);
  assert.equal(request.recommended, recommended);
  assert.match(page, /recommended/iu, "the page marks its recommendation");
  assert.deepEqual(Object.keys(request.effects ?? {}).sort(), [...options].sort(), "every offered option has an effect");
  for (const option of options) {
    const effect = request.effects![option]!;
    assert.match(effect, /\S/u); assert.ok(effect.length <= 160); assert.doesNotMatch(effect, /[\r\n]/u);
    assert.ok(text.includes(option), `the page explains ${option}`);
  }
  if (options.includes("more rounds")) assert.match(request.effects!["more rounds"]!, /budget|round|restart|return/iu);
  if (options.includes("hand off")) assert.match(request.effects!["hand off"]!, /keep|retain/iu);
  if (options.includes("archive")) assert.match(request.effects!.archive!, /commit|sav/iu);
  if (options.includes("discard")) assert.match(request.effects!.discard!, /confirm/iu);
  return page;
}
/** The note must already exist while the Human is waiting, before any answer or final receipt. */
function stuckNote(f: Fixture) {
  const root = join(f.evidence, ".machine-runs/machine-shop");
  const ids = readdirSync(root); assert.equal(ids.length, 1);
  return readFileSync(join(root, ids[0]!, "stuck.md"), "utf8");
}
/** Read the presenter's facts at Human entry without binding or calling a model. */
function observeHumanFacts(facts: string[]) {
  return { ...runtime, human: ((prompt, on, options = {}) => {
    const state = runtime.human(prompt, on, options);
    return { ...state, invoke: { ...state.invoke, input: () => {
      const request = state.invoke.input();
      if (options.presentWith) facts.push(options.presentWith());
      return request;
    } } };
  }) as typeof runtime.human };
}
const textFacts = (facts: string) => {
  const strings: string[] = [];
  JSON.parse(facts, (_key, value) => { if (typeof value === "string") strings.push(value); return value; });
  return oneLine(strings.join("\n"));
};

test("evidence helpers preserve full selected log tails and cap escaped blocks, tables and facts", context => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-evidence-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "gate.log");
  const lines = Array.from({ length: 90 }, (_, index) => `line ${index + 1}`);
  writeFileSync(log, lines.join("\n") + "\n");
  const tail = evidenceLog(log);
  assert.deepEqual(tail.split("\n").slice(1), lines.slice(-30));
  assert.match(tail, /60 lines omitted; see stuck\.md/u);
  assert.match(evidenceLog(join(directory, "missing.log")), /Log unavailable:.*ENOENT/u);
  const payload = '🧪<&"é'.repeat(40_000);
  for (const selected of [payload, Array.from({ length: 30 }, (_, index) => `${index}: ${payload}`).join("\n")]) {
    writeFileSync(log, selected);
    assert.equal(evidenceLog(log), selected);
    const page = renderEvidencePage({
      headline: "Decide what happens next", stopped: `verify: ${payload}`, breadcrumb: payload,
      blocks: [
        { title: "Failed gate", text: evidenceLog(log) },
        { title: "Diff", text: "1000 files changed", table: {
          headings: ["File", "Added", "Removed"], rows: Array.from({ length: 1000 }, () => [payload, "1", "0"]),
        } },
        ...Array.from({ length: 8 }, () => ({ title: "Evidence", text: payload })),
      ], effects: { "hand off": "Keep the worktree and branch." }, recommended: "hand off",
    });
    const facts = evidenceFacts({ stage: "verify", reason: payload, checks: [{ name: "gate", tail: selected }], files: [payload] });
    for (const bounded of [page, facts]) {
      assert.ok(Buffer.byteLength(bounded) < 200_000);
      assert.match(bounded, /\d+ bytes omitted; see stuck\.md/u);
      assert.doesNotMatch(bounded, /�/u);
    }
    assert.match(page, /\d+ rows omitted; see stuck\.md/u);
    assert.match(page, /&lt;&amp;&quot;/u);
    assert.doesNotMatch(page, /<script|<style|<a\b/u);
    assert.equal(JSON.parse(facts).stage, "verify");
    writeStuckEvidence(directory, selected, page);
    const note = readFileSync(join(directory, "stuck.md"), "utf8");
    assert.ok(note.includes(selected)); assert.ok(note.includes(page));
    assert.equal(readFileSync(log, "utf8"), selected);
  }
});

test("stuck evidence: legacy rejection at invocation retains the note and retries only unsupported fields", async context => {
  const f = fixture(context); const human = person("hand off"); let rejected = 0;
  const legacy = { ...runtime, human: ((prompt, on, options = {}) => {
    const state = runtime.human(prompt, on, options);
    return { ...state, invoke: { ...state.invoke, input: () => {
      const request = state.invoke.input();
      if (request.page !== undefined) { rejected++; throw new Error("Unknown Human request fields: page"); }
      return request;
    } } };
  }) as typeof runtime.human };
  const result = await execute(input(f), { falsify: () => gaps([language]) }, human, { primitives: legacy });
  assert.equal(result.state, "handedOff"); assert.equal(rejected, 1);
  assert.equal(human.requests[0]!.page, undefined);
  assert.match(stuckNote(f), /<section class="recap">/u);
});

test("a stuck run keeps its deterministic evidence when a presenter proposes other fields, and more rounds is matched as before", async context => {
  const f = fixture(context); const human = person("more rounds"); const explain = presenter(() => "more rounds"); let reviews = 0;
  const result = await execute(input(f), { presenter: explain, reviewer: () => ++reviews <= 2 ? approvedButMalformed() : review() }, human);
  assert.equal(result.state, "delivered"); assert.deepEqual([human.requests.length, explain.prompts.length, reviews], [1, 1, 3]);
  const [request] = human.requests; stuckQuestion(f, request, "reviewResult");
  const run = held(f, result, /^Delivered/u); asksWritten(run.directory, [request!]);
  // State-owned fields win over optional presenter output in the runtime.
  assert.deepEqual(explain.asked, [request]);
  evidencePage(f, request, "reviewResult", /newSinceLastRound/u, [criterion, "greeting.txt"]);
  assert.deepEqual(request!.suggestions, stuckDecisions);
  assert.deepEqual(request!.discards, ["discard"]);
  // more rounds is the decision it was: back to the stage that stopped, with fresh budgets.
  assert.equal(result.states[result.states.indexOf("decide") + 1], "repairTarget");
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
});

test("the presenter of a stuck run is given the stage, the reason, the last check results, the review verdict with its criteria, the diff's files and the evidence", async context => {
  const f = fixture(context); const human = person("hand off"); const explain = presenter(() => "more rounds");
  const result = await execute(input(f), { presenter: explain, reviewer: approvedButMalformed }, human);
  const run = handedOff(f, result, /review report was malformed twice/u, human);
  assert.equal(explain.prompts.length, 1); const facts = factsOf(explain.prompts[0]!);
  // Where the run stopped, and why.
  assert.match(facts, /\breviewResult\b/u); assert.match(facts, /\bnewSinceLastRound\b/u);
  // The last check results: the required check by name, and that it passed.
  const verify = run.result.checks.filter((check: { phase: string }) => check.phase === "verify").at(-1);
  assert.ok(verify, "the checks ran before the review"); assert.equal(verify.passed, true);
  assert.ok(facts.includes(verify.name), verify.name); assert.match(facts, /\bpass(?:ed)?\b/iu);
  // The review verdict and the criteria it gave.
  assert.match(facts, /\bapproved\b/u); assert.ok(facts.includes(criterion), criterion);
  // The diff's files, and where the reports are kept so the presenter can read them.
  for (const file of ["greeting.txt", "greeting.test.txt"]) assert.ok(facts.includes(file), file);
  assert.ok(facts.includes(run.directory), run.directory);
  const details = JSON.parse(facts);
  assert.deepEqual(details.files, [
    { path: "greeting.test.txt", added: 1, removed: 0 },
    { path: "greeting.txt", added: 1, removed: 0 },
  ]);
  assert.deepEqual(details.checks.map(({ name, phase, exitCode, passed, log }: any) => ({ name, phase, exitCode, passed, log })),
    [{ name: verify.name, phase: "verify", exitCode: 0, passed: true, log: verify.log }]);
  assert.equal(details.reports.sentBack, true);
  assert.deepEqual(details.reports.malformedReviews, [0, 1]);
  assert.equal(details.rounds.extraRound, "unused");
  assert.equal(details.questionFile, join(run.directory, "question-1.txt"));
});

test("presenter diff facts count staged and untracked files, preserving unusual paths and binary counts", async context => {
  const f = fixture(context); const human = person("hand off"); const explain = presenter(() => "more rounds");
  const unusual = "odd\tname\n.bin";
  const result = await execute(scoped(input(f), "odd*"), {
    presenter: explain, reviewer: approvedButMalformed,
    implementer: request => {
      implement(request); git(request.cwd, "add", "greeting.txt", "greeting.test.txt");
      writeFileSync(join(request.cwd, unusual), Buffer.from([0, 1, 2]));
      return ok();
    },
  }, human);
  handedOff(f, result, /review report was malformed twice/u, human);
  assert.deepEqual(JSON.parse(factsOf(explain.prompts[0]!)).files, [
    { path: "greeting.test.txt", added: 1, removed: 0 },
    { path: "greeting.txt", added: 1, removed: 0 },
    { path: unusual, added: null, removed: null },
  ]);
});

test("a failed presenter diff read omits the diff while the question still carries the other facts", async context => {
  const f = fixture(context); const calls = recordGit(context, f); const wrapper = join(f.root, "git-bin", "git");
  writeFileSync(wrapper, readFileSync(wrapper, "utf8").replace("exec ", 'if [ "$1" = diff ] && [ "$2" = --numstat ]; then exit 1; fi\nexec '));
  const human = person("hand off"); const explain = presenter(() => "more rounds");
  const result = await execute(input(f), { presenter: explain, reviewer: approvedButMalformed }, human);
  handedOff(f, result, /review report was malformed twice/u, human);
  assert.ok(calls().some(call => call.startsWith("diff --numstat")));
  const facts = JSON.parse(factsOf(explain.prompts[0]!));
  assert.equal(Object.hasOwn(facts, "files"), false); assert.equal(facts.stage, "reviewResult");
  assert.equal(human.requests[0]!.recommended, "hand off");
  evidencePage(f, human.requests[0], "reviewResult", /newSinceLastRound/u, [criterion]);
});

test("with no presenter bound, a stuck question includes deterministic evidence and preserves its prompt and suggestions", async context => {
  const f = fixture(context); const human = person("hand off");
  // The Machine offers a presenter; this run binds none.
  assert.deepEqual(runtime.optionalAgentNames(mod.default(runtime, input(f))), ["presenter"]);
  const result = await execute(input(f), { reviewer: approvedButMalformed }, human);
  const run = handedOff(f, result, /review report was malformed twice/u, human);
  const [request, ...others] = human.requests; assert.deepEqual(others, []);
  evidencePage(f, request, "reviewResult", /newSinceLastRound/u, [criterion, "greeting.txt"]);
  assert.deepEqual(request!.suggestions, stuckDecisions); assert.equal(request!.choices, undefined);
  stuckQuestion(f, request, "reviewResult"); asksWritten(run.directory, [request!]);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "hand off" }]);
});

test("with no presenter bound, a step question includes deterministic evidence and preserves its choices", async context => {
  const f = fixture(context); const human = person("hand off");
  assert.deepEqual(runtime.optionalAgentNames(mod.default(runtime, input(f))), ["presenter"]);
  const result = await execute(input(f, { setup: [command("process.exit(3)")] }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  steppedOff(f, result, "setup", "stepDecide", /setup: tests did not meet/u, human, 0);
  evidencePage(f, human.requests[0], "setup", /tests did not meet/u, ["tests"], stepChoices);
  assert.deepEqual(human.requests[0]!.choices, stepChoices); assert.equal(human.requests[0]!.suggestions, undefined);
});

for (const failure of ["throws", "returns no presented event"]) {
  test(`a presenter that ${failure} leaves the deterministic evidence intact, and more rounds is matched as before`, async context => {
    const f = fixture(context); const human = person("more rounds"); let presented = 0; let reviews = 0;
    const result = await execute(input(f), {
      presenter: () => { presented++; if (failure === "throws") throw new Error("The presenter's model is unavailable"); return ok("completed", "Nothing to present"); },
      reviewer: () => ++reviews <= 2 ? approvedButMalformed() : review(),
    }, human);
    assert.equal(result.state, "delivered"); assert.deepEqual([presented, human.requests.length], [1, 1]);
    const [request] = human.requests;
    evidencePage(f, request, "reviewResult", /newSinceLastRound/u, [criterion, "greeting.txt"]);
    stuckQuestion(f, request, "reviewResult");
    const run = held(f, result, /^Delivered/u); asksWritten(run.directory, [request!]);
    assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
  });
}

for (const stop of ["falsify questions", "plan too broad", "gates exhausted", "review exhausted", "rebase conflict"] as const) {
  test(`stuck evidence: ${stop} carries the breadcrumb, stage, evidence and every choice without a presenter`, async context => {
    const f = fixture(context); const facts: string[] = [];
    const data = input(f, { rerunFailedChecks: false }, { redGreen: false, maxRepairs: 0, maxReviewRounds: 0 });
    const agents: Record<string, Runner> = {};
    let stage: string; let reason: RegExp; let selected: string[];
    if (stop === "falsify questions") {
      agents.falsify = () => gaps([language, beside], "Two owner decisions prevent implementation");
      agents.plan = () => assert.fail("falsify questions must stop before planning");
      stage = "falsifyResult"; reason = /question/iu;
      selected = [language.text, ...language.options, language.why, beside.text, ...beside.options, beside.why];
    } else if (stop === "plan too broad") {
      agents.planReview = () => ok("tooBroad", split);
      agents.implementer = () => assert.fail("a broad plan must stop before editing");
      stage = "planReviewResult"; reason = /too broad/iu; selected = [plan, ...splitLines];
    } else if (stop === "gates exhausted") {
      data.repository.checks = [command('console.log("evidence gate: expected hello, received goodbye"); process.exit(1)', { name: "greeting-contract" })];
      stage = "repairBudget"; reason = /(?:repair|budget)/iu;
      selected = ["greeting-contract", "evidence gate: expected hello, received goodbye"];
    } else if (stop === "review exhausted") {
      agents.reviewer = () => review("revise", "The empty case remains broken", {
        criteria: [{ text: criterion, met: false, evidence: "greeting.txt:1 returns goodbye" }],
        // Outside Scope makes this an owner stop rather than the automatic extra round.
        findings: [{ severity: "blocker", text: "The default locale loses the greeting", where: "outside-scope.txt:17" }],
      });
      stage = "reviewBudget"; reason = /(?:review|budget)/iu;
      selected = [criterion, "greeting.txt:1 returns goodbye", "The default locale loses the greeting", "outside-scope.txt:17"];
    } else {
      let edits = 0;
      agents.implementer = request => ++edits === 1 ? implement(request) : ok("completed", "Conflict needs the owner's decision");
      agents.reviewer = () => { advance(f, "greeting.txt", "hi\n"); return review(); };
      stage = "repairBudget"; reason = /conflict/iu;
      selected = ["greeting.txt", "refs/machine-shop/saved/", "saved-candidate.patch"];
    }
    const human = person();
    const answer = (request: Ask) => {
      const page = evidencePage(f, request, stage, reason, selected);
      if (stop === "review exhausted") {
        assert.match(pageText(page), /unmet|not met/iu, "unmet criteria are identified as such");
        assert.match(pageText(page), /blocker/iu, "open findings retain their severity");
      }
      const note = stuckNote(f);
      assert.ok(note.includes(page), "stuck.md preserves the generated page before waiting");
      assert.equal(facts.length, 1, "facts are available at Human entry without a presenter");
      const factText = textFacts(facts[0]!);
      for (const part of [f.repo, "PROJ-12", "Add a greeting", branch, f.worktree, stage, ...selected]) {
        assert.ok(note.includes(part), `stuck.md keeps the full text of ${part.slice(0, 100)}`);
        assert.ok(factText.includes(oneLine(part)), `presenter facts carry the same evidence: ${part.slice(0, 100)}`);
      }
      human.requests.push(request);
      return "hand off";
    };
    const result = await execute(data, agents, answer, { primitives: observeHumanFacts(facts) });
    questioned(f, result, reason, human);
    assert.deepEqual(human.requests[0]!.suggestions, stuckDecisions);
  });
}

test("stuck evidence: the page renders the staged and untracked diff as a table with counts and a diff stat", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f, {}, { redGreen: false, maxReviewRounds: 0 }), {
    implementer: request => {
      implement(request); git(request.cwd, "add", "greeting.txt");
      // The default gate evaluates this file; keep the two counted lines valid JavaScript.
      writeFileSync(join(request.cwd, "greeting.test.txt"), "// first\n// second\n");
      return ok();
    }, reviewer: () => ownerReview("The owner must settle the locale"),
  }, human);
  questioned(f, result, /Review budget exhausted \(0\)/u, human);
  const page = evidencePage(f, human.requests[0], "reviewBudget", /review|budget/iu, ["greeting.txt", "greeting.test.txt"]);
  assert.match(page, /<table\b[^>]*>[\s\S]*?<thead\b[^>]*>[\s\S]*?<th\b/u);
  const rows = [...page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gu)].map(match => pageText(match[1]!));
  assert.ok(rows.some(row => /greeting\.txt/u.test(row) && /\b1\b/u.test(row) && /\b0\b/u.test(row)), "staged addition has counts");
  assert.ok(rows.some(row => /greeting\.test\.txt/u.test(row) && /\b2\b/u.test(row) && /\b0\b/u.test(row)), "untracked addition has counts");
  assert.match(pageText(page), /2 files? changed/u);
  assert.match(pageText(page), /3 insertions?/u);
});

test("stuck evidence: a long failing gate log contributes only its last 30 lines, preserving the selected tail in stuck.md and the original log", async context => {
  const f = fixture(context); const human = person("hand off");
  const lines = Array.from({ length: 90 }, (_, index) => `GATE-LINE-${String(index + 1).padStart(3, "0")}`);
  const result = await execute(input(f, {
    checks: [command(`console.log(${JSON.stringify(lines.join("\n"))}); process.exit(1)`, { name: "long-contract" })], rerunFailedChecks: false,
  }, { redGreen: false, maxRepairs: 0 }), {}, human);
  const run = questioned(f, result, /Repair budget exhausted \(0\)/u, human);
  const page = evidencePage(f, human.requests[0], "repairBudget", /repair|budget/iu, ["long-contract", ...lines.slice(-30)]);
  assert.match(page, /<pre\b/u);
  for (const line of lines.slice(0, -30)) assert.equal(page.includes(line), false, `${line} is outside the last 30 lines`);
  assert.match(pageText(page), /(?:60[^.]*?(?:lines?[^.]*?)?(?:omitted|left out)|(?:omitted|left out)[^.]*?60)/iu);
  assert.ok(page.includes("stuck.md"), "the excerpt points to the complete evidence");
  const note = stuckNote(f);
  for (const line of lines.slice(-30)) assert.ok(note.includes(line), `${line} stays in stuck.md`);
  const check = run.result.checks.find((check: any) => check.phase === "verify" && !check.passed);
  assert.ok(check); const log = readFileSync(check.log, "utf8");
  for (const line of lines) assert.ok(log.includes(line), `${line} stays in the original log`);
});

for (const failed of [2, 20]) {
  test(`evidence rendering budgets ${failed} failing gates separately before passing metadata`, () => {
    const payload = '🧪<&"é'.repeat(10_000);
    const failures = Array.from({ length: failed }, (_, index) => ({
      name: `failed-gate-${index}`, phase: "verify", passed: false, exitCode: 1,
      log: `/evidence/${index}.log`, tail: `${payload}\nDIAGNOSTIC-${index}: expected hello`,
    }));
    const passes = Array.from({ length: 20 - failed }, () => ({
      name: `passing-${payload}`, phase: "verify", passed: true, exitCode: 0, log: `/evidence/${payload}.log`,
    }));
    const page = renderEvidencePage({
      headline: "Decide what happens next", stopped: "Stopped in repairBudget: gates failed", breadcrumb: "widgets / PROJ-12 / ticket/proj-12 / worktree",
      blocks: [
        ...failures.map(({ name, tail, exitCode }) => ({ title: `Failing gate: ${name}`, text: `name: ${name}\nexitCode: ${exitCode}`, tail })),
        { title: "Passing checks", text: JSON.stringify(passes) },
      ], effects: { "hand off": "Keep the worktree and branch." }, recommended: "hand off",
    });
    const facts = evidenceFacts({ stage: "repairBudget", checks: [...passes, ...failures], reason: payload });
    for (const bounded of [page, facts]) {
      assert.ok(Buffer.byteLength(bounded) < 200_000);
      assert.match(bounded, /\d+ bytes omitted; see stuck\.md/u);
      assert.doesNotMatch(bounded, /�/u);
      for (const { name } of failures) assert.ok(bounded.includes(name), `retains ${name}`);
      for (let index = 0; index < failed; index++) assert.ok(bounded.includes(`DIAGNOSTIC-${index}: expected hello`), `retains gate ${index}'s diagnostic tail`);
    }
    const checks = JSON.parse(facts).checks;
    assert.equal(checks.length, 20);
    for (const { name, exitCode, log, tail } of failures) {
      const check = checks.find((entry: any) => entry.name === name);
      assert.equal(check.exitCode, exitCode); assert.equal(check.passed, false); assert.equal(check.log, log);
      assert.ok(check.tail.endsWith(tail.split("\n").at(-1)));
    }
  });
}

test("stuck evidence: multiple failing gates retain their own identities and diagnostic tails despite noisy logs and passing metadata", async context => {
  const f = fixture(context); const human = person("hand off"); const facts: string[] = [];
  const failures = ["first-contract", "second-contract"].map(name => {
    const full = [`OLD-${name}`, ...Array.from({ length: 29 }, () => '🧪<&"é'.repeat(2_000)), `DIAGNOSTIC-${name}: expected hello`].join("\n");
    const file = join(f.root, `${name}.txt`); writeFileSync(file, full);
    return { name, full, check: command(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8")); process.exitCode = 1`, { name }) };
  });
  const result = await execute(input(f, {
    checks: [command("", { name: `passing-${"metadata".repeat(2_000)}` }), ...failures.map(failure => failure.check)],
    rerunFailedChecks: false,
  }, { redGreen: false, maxRepairs: 0 }), {}, human, { primitives: observeHumanFacts(facts) });
  const run = questioned(f, result, /Repair budget exhausted \(0\)/u, human);
  const page = evidencePage(f, human.requests[0], "repairBudget", /repair|budget/iu,
    failures.flatMap(({ name }) => [name, `DIAGNOSTIC-${name}: expected hello`]));
  assert.equal(facts.length, 1);
  assert.ok(Buffer.byteLength(facts[0]!) < 200_000);
  for (const bounded of [pageText(page), textFacts(facts[0]!)]) {
    assert.match(bounded, /\d+ bytes omitted; see stuck\.md/u);
    assert.doesNotMatch(bounded, /�/u);
    for (const { name } of failures) {
      assert.ok(bounded.includes(name));
      assert.ok(bounded.includes(`DIAGNOSTIC-${name}: expected hello`), `${name} keeps its diagnostic tail`);
      assert.equal(bounded.includes(`OLD-${name}`), false, "only the last 30 lines are selected");
    }
  }
  for (const { name, full } of failures) {
    const checkFacts = JSON.parse(facts[0]!).checks.find((check: any) => check.name === name);
    assert.equal(checkFacts.passed, false);
    assert.equal(checkFacts.exitCode, 1);
    assert.ok(checkFacts.tail.endsWith(`DIAGNOSTIC-${name}: expected hello`));
    assert.ok(stuckNote(f).includes(full.split("\n").slice(-30).join("\n")));
    const check = run.result.checks.find((check: any) => check.name === name);
    assert.equal(readFileSync(check.log, "utf8"), full);
  }
});

for (const overflow of ["one oversized line", "thirty oversized escaped Unicode lines", "oversized questions and options"]) {
  test(`stuck evidence: ${overflow} is byte-capped in the page and facts, with full selected evidence in stuck.md`, async context => {
    const f = fixture(context); const human = person("hand off"); const facts: string[] = [];
    const payload = '🧪<&"é'.repeat(overflow === "thirty oversized escaped Unicode lines" ? 2_000 : 6_000);
    const full = overflow === "one oversized line" ? `START-LONG ${payload.repeat(3)} END-LONG`
      : overflow === "thirty oversized escaped Unicode lines" ? Array.from({ length: 30 }, (_, index) => `TAIL-${index + 1} ${payload}`).join("\n")
        : `QUESTION-START ${payload.repeat(3)} QUESTION-END`;
    // Keep large data out of argv: the gate reads an evidence fixture outside the checkout.
    const file = join(f.root, "oversized-evidence.txt"); writeFileSync(file, full);
    const data = input(f, { rerunFailedChecks: false }, { redGreen: false, maxRepairs: 0 });
    const agents: Record<string, Runner> = {
      presenter: request => { facts.push(factsOf(request.prompt)); return ok("completed", "No presentation override"); },
    };
    if (overflow === "oversized questions and options") {
      const option = `OPTION-START ${payload.repeat(3)} OPTION-END`;
      agents.falsify = () => gaps([gap(full, { options: [option, "Keep existing behavior"], recommended: option, why: full })]);
    } else {
      // Let stdout drain before the failing exit so the gate log contains the entire fixture.
      data.repository.checks = [command(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8")); process.exitCode = 1`, { name: "overflow-contract" })];
    }
    const result = await execute(data, agents, human);
    assert.equal(result.state, "handedOff"); assert.equal(human.requests.length, 1); assert.equal(facts.length, 1);
    const request = human.requests[0]!;
    assert.equal(typeof request.page, "string", "overflow must never omit the page");
    assert.ok(Buffer.byteLength(request.page!, "utf8") < 200_000, "budget includes escaping and UTF-8 bytes");
    assert.ok(Buffer.byteLength(facts[0]!, "utf8") < 200_000, "serialized presenter facts are independently bounded");
    for (const excerpt of [pageText(request.page!), facts[0]!]) {
      assert.match(excerpt, /(?:\b\d+\s+(?:bytes?|characters?|lines?)\s+(?:(?:were|are)\s+)?(?:omitted|left out)|(?:omitted|left out)\s*:?\s*\d+\s+(?:bytes?|characters?|lines?))/iu,
        "a cut states the omitted amount");
      assert.ok(excerpt.includes("stuck.md"));
      assert.equal(excerpt.includes(full), false, "large evidence is actually excerpted");
      assert.equal(excerpt.includes("�"), false, "UTF-8 truncation does not split a code point");
    }
    const note = stuckNote(f);
    assert.ok(note.includes(full), "stuck.md keeps complete selected evidence, beyond the excerpt");
    if (overflow === "oversized questions and options") assert.ok(note.includes(`OPTION-START ${payload.repeat(3)} OPTION-END`));
    assert.ok(note.includes(request.page!), "the bounded page is also saved");
    if (overflow !== "oversized questions and options") {
      const check = evidence(f).result.checks.find((check: any) => !check.passed);
      assert.ok(readFileSync(check.log, "utf8").includes(full), "the original log is retained");
    }
  });
}

test("stuck evidence: HTML-like questions, options and Unicode are escaped in the page and kept literally in text facts", async context => {
  const f = fixture(context); const human = person("hand off"); const facts: string[] = [];
  const unsafe = gap('Keep <script>alert("x")</script> & café 🧪?', {
    options: ['<a href="https://example.invalid">Keep</a>', '<img src="x" onerror="alert(1)">'],
    recommended: '<a href="https://example.invalid">Keep</a>', why: "<style>body{display:none}</style> is evidence, not markup.",
  });
  const result = await execute(input(f), {
    falsify: () => gaps([unsafe]),
    presenter: request => { facts.push(factsOf(request.prompt)); return ok(); },
  }, human);
  assert.equal(result.state, "handedOff");
  const page = evidencePage(f, human.requests[0], "falsifyResult", /question/iu, [unsafe.text, ...unsafe.options, unsafe.why]);
  assert.ok(page.includes("&lt;script&gt;")); assert.ok(page.includes("&amp;"));
  const textFacts = JSON.stringify(JSON.parse(facts[0]!));
  for (const part of [f.repo, "PROJ-12", "Add a greeting", unsafe.text, ...unsafe.options, unsafe.why]) {
    assert.ok(textFacts.includes(JSON.stringify(part).slice(1, -1)), `presenter facts include ${part}`);
    assert.ok(stuckNote(f).includes(part), `stuck.md includes ${part}`);
  }
});

test("stuck evidence: a strict legacy runtime rejects presentation fields, then receives the original request with the page saved only in stuck.md", async context => {
  const f = fixture(context); const human = person("hand off"); const rejected: string[][] = [];
  // This runtime has the optional presenter API, but no presentation fields on Human requests.
  // Reject keys rather than silently dropping them, so an accidental dependency fails visibly.
  const legacy = { ...runtime, human: ((prompt, on, options = {}) => {
    const known = new Set(["choices", "suggestions", "present", "presentWith", "presentIn"]);
    const unknown = Object.keys(options).filter(key => !known.has(key));
    if (unknown.length) {
      rejected.push(unknown);
      throw new Error(`Unknown Human request fields: ${unknown.join(", ")}`);
    }
    const state = runtime.human(prompt, on, options);
    return { ...state, invoke: { ...state.invoke, input: () => {
      const request = state.invoke.input();
      const unknown = Object.keys(request).filter(key => !["prompt", "choices", "suggestions"].includes(key));
      if (unknown.length) {
        rejected.push(unknown);
        throw new Error(`Unknown Human request fields: ${unknown.join(", ")}`);
      }
      return request;
    } } };
  }) as typeof runtime.human };
  const result = await execute(input(f), { falsify: () => gaps([language]) }, human, { primitives: legacy });
  assert.equal(result.state, "handedOff"); assert.equal(human.requests.length, 1);
  assert.ok(rejected.some(fields => fields.includes("page")), "the fallback was exercised after an actual unsupported-field rejection");
  const request = human.requests[0]!;
  assert.deepEqual(request, { prompt: request.prompt, suggestions: stuckDecisions });
  stuckQuestion(f, request, "falsifyResult");
  const note = stuckNote(f);
  for (const part of [f.repo, "PROJ-12", "Add a greeting", branch, f.worktree, "falsifyResult", language.text, ...language.options, language.why]) {
    assert.ok(pageText(note).includes(part), `legacy stuck.md keeps ${part}`);
  }
  assert.match(note, /<section\b[^>]*class=["']recap["']/u);
  assert.match(note, /<span\b[^>]*class=["']chip\s/u);
  const run = questioned(f, result, /question/iu, human); asksWritten(run.directory, [request]);
});

test("stuck evidence: legacy compatibility propagates unrelated Human validation errors", async context => {
  const f = fixture(context); const failure = new Error("Human choices must include at least one value");
  const rejecting = { ...runtime, human: (() => { throw failure; }) as typeof runtime.human };
  await assert.rejects(execute(input(f), {}, person(), { primitives: rejecting }), error => error === failure);
  assert.deepEqual(readdirSync(f.root), ["widgets"], "an unrelated construction error performs no work");
});

test("with a presenter bound, Discard. still asks for confirmation, whose choices are unchanged, and go back returns to the stuck question", async context => {
  const f = fixture(context); const human = person("Discard.", "go back", "hand off"); const explain = presenter(asked => asked.choices ? "go back" : "more rounds");
  const result = await execute(input(f), { presenter: explain, reviewer: approvedButMalformed }, human);
  handedOff(f, result, /review report was malformed twice/u, human);
  assert.deepEqual(result.states.filter(state => ["decide", "confirmDiscard"].includes(state)), ["decide", "confirmDiscard", "decide"]);
  const [decide, confirm, again] = human.requests; assert.equal(human.requests.length, 3); assert.equal(explain.prompts.length, 3);
  for (const asked of [decide!, again!]) {
    evidencePage(f, asked, "reviewResult", /newSinceLastRound/u, [criterion, "greeting.txt"]);
    assert.deepEqual(asked.suggestions, stuckDecisions);
  }
  assert.deepEqual(explain.asked, human.requests);
  evidencePage(f, confirm, "reviewResult", /newSinceLastRound/u, [criterion, "greeting.txt"], ["confirm discard", "go back"], "go back");
  assert.deepEqual(confirm!.choices, ["confirm discard", "go back"]);
  assert.deepEqual(confirm!.discards, ["confirm discard"]);
  const run = evidence(f); asksWritten(run.directory, [decide!, again!]);
  assert.deepEqual(run.result.decisions.map((made: any) => `${made.stage}: ${made.response}`), ["decide: Discard.", "confirmDiscard: go back", "decide: hand off"]);
});

test("with a presenter bound, a reply that is not a choice is refused on a confirmation as before, even the presenter's own label", async context => {
  const f = fixture(context); const human = person("discard", "confirm discard (discards work)"); const explain = presenter(asked => asked.choices ? "go back" : "more rounds");
  await assert.rejects(execute(input(f), { presenter: explain, reviewer: approvedButMalformed }, human), /Expected one of: confirm discard, go back/u);
  assert.equal(explain.prompts.length, 2); assert.deepEqual(human.requests[1]!.discards, ["confirm discard"]);
  assert.ok(existsSync(f.worktree), "nothing was removed");
});

test("a step question with a presenter bound is explained with the step's facts, its choices unchanged, and hand off matched as before", async context => {
  const f = fixture(context); const human = person("hand off"); const explain = presenter(() => "retry");
  const result = await execute(input(f, { setup: [command("process.exit(3)")] }), { presenter: explain, investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  const run = steppedOff(f, result, "setup", "stepDecide", /setup: tests did not meet/u, human, 0);
  const [request] = human.requests;
  assert.deepEqual(explain.asked, [request]);
  evidencePage(f, request, "setup", /tests did not meet/u, ["tests"], stepChoices);
  assert.deepEqual([request!.recommended, request!.discards], ["hand off", ["discard"]]);
  const facts = factsOf(explain.prompts[0]!);
  assert.match(facts, /\bsetup\b/u); assert.match(facts, /tests did not meet/u);
  assert.ok(facts.includes(run.result.checks[0].name)); assert.ok(facts.includes(run.directory), run.directory);
});

for (const valid of [false, true]) {
  test(`more rounds after ${valid ? "a corrected" : "a second malformed"} falsify report keeps the one-return allowance spent and ${valid ? "clears" : "updates"} the validation feedback`, async context => {
    const f = fixture(context); const human = person("more rounds", "hand off"); const prompts: string[] = [];
    const missing = { type: "questions", summary: "The questions are missing" };
    const secondReason = "questions[0].why must be a non-empty string";
    const reports = [missing, gaps([valid ? language : without(language, "why")]), missing];
    const result = await execute(input(f, {}, { stuck: "ask", maxRepairs: 0, maxReviewRounds: 0 }), {
      falsify: request => { prompts.push(request.prompt); return reports[prompts.length - 1]!; },
      plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    assert.equal(result.state, "handedOff");
    assert.equal(prompts.length, 3); assert.equal(human.requests.length, 2);
    assert.ok(prompts[1]!.includes(`Your last report was malformed: ${notAList}. Return it again in the required shape.`));
    if (valid) assert.doesNotMatch(prompts[2]!, /Your last report was malformed/u);
    else assert.ok(prompts[2]!.includes(`Your last report was malformed: ${secondReason}. Return it again in the required shape.`));
    const run = held(f, result, /The falsify report was malformed twice: /u);
    assert.ok(run.delivery.reason.includes(notAList));
    assert.ok(run.delivery.reason.includes(join(run.directory, "falsify-3.json")));
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
    assert.equal(run.result.agentInvocations, 3);
    assert.equal(candidate(f.worktree).status, "");
  });
}

test("a valid falsify questions report first is judged at once, with no return to the investigator", async context => {
  for (const [assumable, asked] of [[true, beside], [false, language]] as const) {
    const f = fixture(context); const human = person(...(assumable ? [] : ["hand off"])); let falsified = 0;
    const result = await execute(input(f, {}, { stuck: "park", assume: true }), {
      falsify: () => { falsified++; return gaps([asked]); },
    }, human);
    assert.equal(falsified, 1);
    assert.equal(result.states.filter(state => state === "falsify").length, 1);
    if (assumable) assert.equal(result.state, "delivered", evidence(f).delivery.reason);
    else {
      const run = questioned(f, result, /Which language is the greeting in\?/u, human);
      assert.equal(run.result.agentInvocations, 1);
      assert.equal(numberedLines(run.needs.split("\n")).length, 1);
    }
  }
});

test("the falsify prompt asks for each question's text, options, recommended answer, whether it is assumable, and why, with assume on as with it off", async context => {
  const asks: string[][] = [];
  for (const extra of [{}, { assume: true }]) {
    const f = fixture(context);
    const result = await execute(input(f, {}, extra), {
      // The paragraphs that name this run's own directories differ from one run to the next; the rest is what the investigator is asked.
      falsify: request => { asks.push(request.prompt.split("\n\n").filter(part => !part.includes(f.root))); return planning.falsify!.answer(request); },
    });
    assert.equal(result.state, "delivered");
  }
  for (const ask of asks) {
    const prompt = ask.join("\n\n");
    for (const field of ["text", "options", "recommended", "assumable", "why"]) assert.match(prompt, new RegExp(`\\b${field}\\b`, "u"), field);
    // The questions go in the report's questions field, not in its summary or message.
    for (const rule of questionsGo) assert.match(prompt, rule);
    // Assumable is for a gap whose conservative answer loses nothing if wrong; a product decision, a change of scope, or anything irreversible never is.
    for (const rule of [/\bconservative\b/iu, /\bloses? nothing\b|\bnothing (?:is )?lost\b/iu, /\bproduct decision\b/iu, /\bchange of scope\b|\bscope change\b|\bchang\w+ (?:the |its )?scope\b/iu, /\birreversibl/iu]) {
      assert.match(prompt, rule);
    }
  }
  // The investigator is asked the same either way: assume changes what the run does with the answer, not the question.
  assert.equal(asks.length, 2); assert.deepEqual(asks[1], asks[0]);
});

test("assume is a boolean that adds no state, and anything else fails before effects", context => {
  const f = fixture(context);
  for (const assume of [null, "yes", "true", 1, 0, {}]) assert.throws(() => mod.default(runtime, input(f, {}, { assume })), /assume must be a boolean/u);
  const states = (extra: object) => Object.keys(mod.default(runtime, input(f, {}, extra)).states);
  // The switch is carried by the states there are: no Human state and no other is added for it.
  for (const assume of [false, true]) assert.deepEqual(states({ assume }), states({}));
  assert.deepEqual(readdirSync(f.root), ["widgets"]);
});

test("with assume on, a report whose every question is assumable goes on to plan with the recommended answers written down, handed on, listed in the pull request, and kept on the receipt", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f); const calls: string[] = []; const prompts: Record<string, string> = {};
  const keeping = (name: string, work: Runner): Runner => request => { calls.push(name); prompts[name] = request.prompt; return work(request); };
  const questions = [beside, newline];
  // Nobody is asked: a Human request would fail the run.
  const result = await execute(input(f, { output: "pr" }, { assume: true }), {
    falsify: keeping("falsify", () => gaps(questions, "Two gaps, each with a conservative answer")),
    plan: keeping("plan", planning.plan!.answer), planReview: keeping("planReview", planning.planReview!.answer),
    tester: keeping("tester", tester), implementer: keeping("implementer", implement), reviewer: keeping("reviewer", () => review()),
  });
  assert.equal(result.state, "merged", evidence(f).delivery.reason);
  assert.deepEqual(calls, ["falsify", "plan", "planReview", "tester", "implementer", "reviewer"]);
  assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "test", "change", "review"]); assert.equal(result.states.includes("stuck"), false);
  const run = merged(f, result);
  // The evidence directory holds the answers the run went on with.
  const file = readFileSync(join(run.directory, "assumptions.json"), "utf8");
  assert.deepEqual(JSON.parse(file), assumed(questions));
  // Everyone who works after falsify is given that file's own text under its heading, not a summary of it.
  assert.doesNotMatch(prompts.falsify!, /^Assumptions:/mu);
  for (const stage of ["plan", "planReview", "tester", "implementer", "reviewer"]) assert.ok(assumptionsIn(prompts[stage]!).startsWith(`${file.trimEnd()}\n`), stage);
  for (const role of ["tester", "implementer"]) assert.ok(planIn(prompts[role]!).startsWith(`${plan}\n`), role);
  // The plan was made without standing feedback: the questions were settled, not left open.
  assert.doesNotMatch(prompts.plan!, /Current failure\/feedback:/u);
  assert.ok(prompts.reviewer!.split("\n").some(line => /\bassum/iu.test(line) && /\bdiscussion\b/iu.test(line)), "the reviewer is told that an assumption it disagrees with is a discussion finding");
  const args = gh()!; const path = args[args.indexOf("--body-file") + 1]!;
  assert.equal(path, join(run.directory, "pull-request.md"));
  const section = (readFileSync(path, "utf8").split(/^## Assumptions\n+/mu)[1] ?? "").split(/^## /mu)[0]!;
  const listed = section.split("\n").filter(line => line.startsWith("- "));
  assert.equal(listed.length, questions.length, section);
  for (const [index, asked] of questions.entries()) {
    // One line each: the question, then the answer the run took.
    const at = listed[index]!.indexOf(oneLine(asked.text));
    assert.ok(at >= 0 && listed[index]!.indexOf(oneLine(asked.recommended), at + oneLine(asked.text).length) > at, listed[index]);
  }
  assert.deepEqual(run.delivery.assumptions, assumed(questions));
  assert.equal(git(f.repo, "show", "--name-only", "--format=", run.delivery.commit), "greeting.test.txt\ngreeting.txt");
});

for (const assume of [undefined, true]) {
  test(`a sound ticket with assume ${assume ? "on" : "left out"} has no assumptions in any prompt, in the pull request, or on the receipt`, async context => {
    const f = fixture(context); remote(f); const gh = fakeGh(context, f); const prompts: string[] = [];
    const keeping = (work: Runner): Runner => request => { prompts.push(request.prompt); return work(request); };
    const result = await execute(input(f, { output: "pr" }, assume ? { assume } : {}), {
      falsify: keeping(planning.falsify!.answer), plan: keeping(planning.plan!.answer), planReview: keeping(planning.planReview!.answer),
      tester: keeping(tester), implementer: keeping(implement), reviewer: keeping(() => review()),
    });
    assert.equal(result.state, "merged", evidence(f).delivery.reason); assert.equal(prompts.length, 6);
    for (const prompt of prompts) assert.doesNotMatch(prompt, /^Assumptions:/mu);
    const run = merged(f, result);
    const args = gh()!;
    assert.doesNotMatch(readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8"), /## Assumptions/u);
    assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
  });
}

test("the reviewer of a run that assumed is asked for the same report and the same outcomes as the reviewer of a sound one", async context => {
  const asked: { outcomes: string[]; report: string | undefined }[] = [];
  for (const [extra, falsify] of [[{}, planning.falsify!.answer], [{ assume: true }, () => gaps([beside], "One gap with a conservative answer")]] as const) {
    const f = fixture(context);
    const result = await execute(input(f, {}, extra), {
      falsify,
      reviewer: request => {
        asked.push({ outcomes: [...request.outcomes].sort(), report: request.prompt.split("\n").find(line => line.includes("MACHINES_EVENT {")) });
        return review();
      },
    });
    assert.equal(result.state, "delivered");
  }
  assert.equal(asked.length, 2); assert.ok(asked[0]!.report); assert.deepEqual(asked[1], asked[0]);
  assert.deepEqual(asked[0]!.outcomes, ["approved", "blocked", "revise"]);
});

test("with assume on, a mixed report asks the one question that is not assumable and says which others it would have assumed", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f, {}, { assume: true, stuck: "park" }), {
    falsify: () => gaps([beside, language, newline], "Three gaps, one of them the owner's"),
    plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /Which language is the greeting in\?/u, human);
  // Only the question that needs the owner is theirs to answer: it is the one numbered and counted.
  assert.match(run.delivery.reason, /\b1 open question:/u);
  const needs: string[] = run.needs.split("\n");
  assert.match(needs[0]!, openQuestions); optionsFirst(needs[1]!, 1, language); assert.deepEqual(numberedLines(needs), [needs[1]]);
  // The others follow, each with the answer the run would have gone on with had it not stopped.
  const others = needs.slice(2);
  assert.match(others.join("\n"), /would have assumed/iu); assert.equal(others.join("\n").includes(language.text), false);
  for (const other of [beside, newline]) {
    const line = others.find(one => one.includes(other.text)) ?? "";
    assert.ok(line.indexOf(other.recommended, line.indexOf(other.text) + other.text.length) > 0, `${other.text} is not listed with the answer ${other.recommended}`);
  }
  showsNeed(run.prompt, run.needs, f.worktree);
  // Nothing was assumed: the run stopped before plan, and a stop records no assumptions.
  assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
  assert.equal(result.states.some(state => state === "plan" || state === "planReview" || state === "test" || state === "change"), false);
  assert.deepEqual(candidate(f.worktree), { status: "", files: [["code.txt", 0, Buffer.from("old").toString("base64")]] });
});

test("with assume on, a report with no assumable question asks about all of them, as with assume off", async context => {
  const f = fixture(context); const human = person("hand off");
  const questions = [language, gap("Who is greeted?")];
  const result = await execute(input(f, {}, { assume: true, stuck: "park" }), { falsify: () => gaps(questions, "The ticket leaves two things open"), plan: () => assert.fail() }, human);
  const run = questioned(f, result, /Which language is the greeting in\?/u, human);
  const needs: string[] = run.needs.split("\n"); assert.equal(needs.length, 3);
  for (const [index, asked] of questions.entries()) optionsFirst(needs[index + 1]!, index + 1, asked);
  assert.doesNotMatch(run.needs, /would have assumed/iu);
  assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
});

test("more rounds after a mixed report returns to falsify, and a report then wholly assumable is planned from its own assumptions with no standing feedback", async context => {
  const f = fixture(context); const human = person("more rounds"); let falsified = 0; let planned = "";
  const result = await execute(input(f, {}, { assume: true }), {
    falsify: () => ++falsified === 1 ? gaps([language, beside], "Two gaps, one of them the owner's") : gaps([newline], "One gap with a conservative answer"),
    plan: request => { planned = request.prompt; return planning.plan!.answer(request); },
  }, human);
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  assert.deepEqual(route(result.states), ["falsify", "decide", "falsify", "plan", "planReview", "test", "change", "review"]);
  // The decision shows the one question that stopped the run, and beside it what the run would have assumed.
  const shown = human.requests[0]!.prompt; assert.equal(human.requests.length, 1);
  assert.equal(shown.split("\n")[0], "Answer 1 open question before any code is written."); assert.ok(shown.includes(`1. ${language.text}`));
  assert.match(shown, /would have assumed/iu);
  const others = needsIn(shown, f.worktree).slice(needsIn(shown, f.worktree).search(/would have assumed/iu));
  assert.ok(others.includes(beside.text) && others.includes(beside.recommended)); assert.equal(others.includes(language.text), false);
  // The second report is the one that stands: its answer is assumed, and nothing of the first is left over.
  assert.doesNotMatch(planned, /Current failure\/feedback:/u);
  const run = held(f, result, /^Delivered/u);
  const file = readFileSync(join(run.directory, "assumptions.json"), "utf8");
  assert.deepEqual(JSON.parse(file), assumed([newline])); assert.deepEqual(run.delivery.assumptions, assumed([newline]));
  assert.ok(assumptionsIn(planned).startsWith(`${file.trimEnd()}\n`));
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
});

test("an assumption the reviewer disagrees with in two successive reviews is asked of the owner as any discussion is, with the assumptions still on the receipt", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const [first, second] = [
    { text: "The run assumed greeting.txt stands beside code.txt, but nothing reads code.txt once it exists", where: "assumptions.json" },
    { text: "Is greeting.txt meant to replace code.txt after all?", where: "assumptions.json" },
  ];
  const result = await execute(input(f, {}, { assume: true, stuck: "park" }), {
    falsify: () => gaps([beside], "One gap with a conservative answer"),
    // A first review that questions the assumption still gives the implementer one round with it.
    implementer: request => {
      assert.ok(assumptionsIn(request.prompt).includes(JSON.stringify(beside.recommended)));
      if (++edits === 2) assert.ok(request.prompt.includes(`Discussion: ${first.text} (${first.where})`));
      return implement(request);
    },
    reviewer: request => {
      assert.ok(assumptionsIn(request.prompt).includes(JSON.stringify(beside.recommended)));
      return review("approved", "The answer the run took looks wrong", { findings: discussions([++reviews === 1 ? first : second]), newSinceLastRound: "A new question" });
    },
  }, human);
  // The stop is the review's own: assume settles nothing outside falsify, and the question keeps the form of any review question.
  const run = questioned(f, result, /replace code\.txt after all\?/u, human); assert.deepEqual([edits, reviews], [2, 2]);
  assert.equal(result.states.at(-5), "reviewResult");
  const [reason, needs]: string[][] = [run.delivery.reason.split("\n"), run.needs.split("\n")];
  assert.match(reason[0]!, /\b1 open question:$/u); assert.deepEqual(reason.slice(1), questionLines([second]));
  assert.match(needs[0]!, openQuestions); assert.deepEqual(needs.slice(1), questionLines([second]));
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "assumptions.json"), "utf8")), assumed([beside]));
  assert.deepEqual(run.delivery.assumptions, assumed([beside]));
});

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

test("a plan the reviewer sends back twice is asked about with the reviewer's summary as what is needed, before anything is edited", async context => {
  const f = fixture(context); const human = person("hand off"); let plans = 0; let planReviews = 0;
  const result = await execute(input(f, {}, { stuck: "park" }), {
    plan: () => ok("planned", `Attempt ${++plans}: add greeting.txt.`),
    planReview: () => ok("revise", ++planReviews === 1 ? "Name the test that proves the greeting" : "The plan still names no test"),
    tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /\S/u, human);
  assert.deepEqual([plans, planReviews], [2, 2]);
  assert.ok(run.needs.includes("The plan still names no test")); assert.ok(result.output.summary.includes("The plan still names no test"));
  assert.doesNotMatch(run.needs, /Name the test that proves the greeting/u);
  assert.deepEqual(result.states.filter(isPlanning), ["falsify", "plan", "planReview", "plan", "planReview"]);
  assert.equal(candidate(f.worktree).status, ""); assert.deepEqual(run.result.checks, []);
});

test("a second plan revision whose summary runs over several lines and 600 characters is asked about with needs capped on one line, as any other blocker", async context => {
  const f = fixture(context); const human = person("hand off"); let planReviews = 0;
  const feedback = `The plan still names no test.\n${"Say which file proves the greeting.\n".repeat(30)}`.trim();
  const result = await execute(input(f, {}, { stuck: "park" }), {
    planReview: () => ok("revise", ++planReviews === 1 ? "Name the test that proves the greeting" : feedback),
    tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /The plan still names no test/u, human);
  // The first sentence is what is needed; the rest of the summary follows under Needs, on one line cut at 600 characters.
  const needs = `${oneLine(feedback.slice("The plan still names no test.".length))}`.slice(0, 600) + "…";
  assert.equal(run.needs, `The plan still names no test.\n${needs}`);
  // The full reason stays in the receipt.
  assert.equal(run.delivery.reason, feedback);
  assert.equal(run.prompt.split("\n").find(line => line.startsWith("Needs: ")), `Needs: ${needs}`);
});

/** A split the plan reviewer suggests for a ticket too broad for one run: one smaller ticket per line. */
const split = "PROJ-12a: write hello to greeting.txt.\nPROJ-12b: cover greeting.txt in greeting.test.txt.";
const splitLines = split.split("\n");
/** What a run stopped by a too broad verdict says: the suggested split, flattened onto one line where the line breaks are dropped. */
const splitSaid = /PROJ-12a: write hello to greeting\.txt\.\s+PROJ-12b: cover greeting\.txt in greeting\.test\.txt\./u;
/** A plan reviewer that finds the ticket too broad the first time it is asked, then reviews as the default one does. */
const broadOnce = (reviews: string[] = []): Runner => request => {
  reviews.push(request.prompt);
  return reviews.length === 1 ? ok("tooBroad", split) : planning.planReview!.answer(request);
};
/** A planner that keeps every prompt it is given and plans as the default one does. */
const planner = (plans: string[]): Runner => request => { plans.push(request.prompt); return planning.plan!.answer(request); };

for (const length of [6001, 9000]) {
  test(`a plan of ${length} characters goes to plan review whole without being sent back for length, and is the one worked from`, async context => {
    const f = fixture(context); const long = "p".repeat(length); const plans: string[] = [];
    const later: Record<string, string[]> = { planReview: [], tester: [], implementer: [] };
    const seen = (stage: string, work: Runner): Runner => request => { later[stage]!.push(request.prompt); return work(request); };
    const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), {
      plan: request => { plans.push(request.prompt); return ok("planned", long); },
      planReview: seen("planReview", planning.planReview!.answer), tester: seen("tester", tester), implementer: seen("implementer", implement),
    });
    assert.equal(result.state, "delivered", evidence(f).delivery.reason);
    assert.deepEqual([plans.length, later.planReview!.length, later.tester!.length, later.implementer!.length], [1, 1, 1, 1]);
    assert.deepEqual(result.states.slice(0, result.states.indexOf("test")).filter(isPlanning), ["falsify", "plan", "planReview"]);
    for (const state of ["stuck", "decide"]) assert.equal(result.states.includes(state), false, state);
    // The reviewer, the tester, and the implementer all read the whole plan.
    for (const prompt of Object.values(later).flat()) assert.ok(planIn(prompt).startsWith(`${long}\n`));
    const run = held(f, result, /^Delivered/u);
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
    assert.deepEqual(run.result.agents.filter((agent: any) => agent.stage === "plan").map((agent: any) => agent.summary), [long]);
  });
}

test("the planner is given no length limit and is asked for a concise plan, and the plan reviewer is told to send back a wordy plan and when to call a ticket too broad", async context => {
  const f = fixture(context); const prompts: Record<string, string> = {};
  const result = await execute(input(f), {
    plan: request => { prompts.plan = request.prompt; return planning.plan!.answer(request); },
    planReview: request => { prompts.planReview = request.prompt; return planning.planReview!.answer(request); },
  });
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  const asked = prompts.plan!.split(/^Plan:\n/mu)[0]!;
  assert.doesNotMatch(asked, /\b6000\b|\blimit\b|\bat most \d+ characters\b|\b\d+ characters\b/iu, "the planner is given no length limit");
  assert.match(asked, /\bconcise\b/iu); assert.match(asked, /\bfiles\b/iu); assert.match(asked, /\btests\b/iu); assert.match(asked, /\b(?:not|never|without) restat\w* the ticket\b/iu);
  const told = prompts.planReview!.split(/^Plan:\n/mu)[0]!;
  assert.match(told, /\btooBroad\b/u); assert.match(told, /\bsplit\b/iu); assert.match(told, /\bsmaller tickets\b/iu);
  // A wordy plan is an ordinary revision.
  assert.match(told, /\brevise\b/u); assert.match(told, /\brestat\w* the ticket\b/iu); assert.match(told, /\bdetail\b[^.]*\bimplementer\b/iu);
  assert.doesNotMatch(told, /\b6000\b|\blimit\b/iu);
});

test("a plan reviewer's revision asking for a shorter plan returns to the planner with that feedback as any revision does, spending no budget", async context => {
  const f = fixture(context); const plans: string[] = []; const planReviews: string[] = [];
  const first = `Restating the ticket: ${"Write hello to greeting.txt. ".repeat(40)}Then add greeting.txt and greeting.test.txt.`;
  const shorter = "The plan restates the ticket and carries detail the implementer does not need; name the files and the tests in fewer words.";
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), {
    plan: request => { plans.push(request.prompt); return ok("planned", plans.length === 1 ? first : plan); },
    planReview: request => { planReviews.push(request.prompt); return planReviews.length === 1 ? ok("revise", shorter) : ok("approved", "Concise, and names its files and test"); },
  });
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  assert.deepEqual(result.states.slice(0, result.states.indexOf("test")).filter(isPlanning), ["falsify", "plan", "planReview", "plan", "planReview"]);
  for (const state of ["stuck", "decide"]) assert.equal(result.states.includes(state), false, state);
  assert.equal(plans[0]!.includes(shorter), false); assert.ok(plans[1]!.includes(shorter), plans[1]);
  // The planner is asked again for the reviewer's reasons alone: no prompt names a length or a limit.
  for (const prompt of plans) assert.doesNotMatch(prompt.split(/^Plan:\n/mu)[0]!, /\b6000\b|\blimit\b|\blast plan was\b/iu);
  assert.ok(planIn(planReviews[0]!).startsWith(`${first}\n`)); assert.ok(planIn(planReviews[1]!).startsWith(`${plan}\n`));
  const run = held(f, result, /^Delivered/u);
  assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
});

test("a too broad verdict from plan review stops before anything is edited, and the question it asks holds the suggested split", async context => {
  const f = fixture(context); const human = person("hand off"); const plans: string[] = []; const planReviews: string[] = [];
  const result = await execute(input(f), {
    plan: planner(plans), planReview: broadOnce(planReviews),
    tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, splitSaid, human);
  assert.deepEqual([plans.length, planReviews.length], [1, 1]); assert.equal(result.states.at(-5), "planReviewResult");
  assert.deepEqual(result.states.filter(isPlanning), ["falsify", "plan", "planReview"]);
  // The question, the file it is written to, and the receipt each hold the split; the question and the receipt keep its lines.
  for (const line of splitLines) {
    assert.ok(run.prompt.includes(line), line); assert.ok(run.delivery.reason.includes(line), line);
    assert.ok(readFileSync(join(run.directory, "question-1.txt"), "utf8").includes(line), line);
  }
  assert.ok(run.delivery.reason.includes(split), "the receipt keeps the split one ticket per line");
  for (const said of [run.prompt, run.delivery.reason, result.output.summary]) assert.match(said, /\btoo broad\b/iu);
  assert.doesNotMatch(run.delivery.reason, /\bcharacters\b|\blimit\b|malformed/iu);
  assert.equal(candidate(f.worktree).status, ""); assert.deepEqual(run.result.checks, []);
  assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
});

test("a too broad verdict leaves the reviewer's one revision: after more rounds the plan goes back to plan, a revise is planned again, and an approval goes on", async context => {
  const f = fixture(context); const human = person("more rounds"); const plans: string[] = []; let planReviews = 0;
  const result = await execute(input(f), {
    plan: planner(plans),
    planReview: () => [() => ok("tooBroad", split), () => ok("revise", "Name the test that proves the greeting"), () => ok("approved", "The plan names its test")][planReviews++]!(),
  }, human);
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "decide", "plan", "planReview", "plan", "planReview", "test", "change", "review"]);
  const at = result.states.indexOf("decide");
  assert.deepEqual(result.states.slice(at - 2, at + 3), ["planReviewResult", "stuck", "decide", "repairTarget", "plan"]);
  assert.equal(human.requests.length, 1); stuckQuestion(f, human.requests[0], "planReviewResult");
  assert.ok(plans[2]!.includes("Name the test that proves the greeting"), plans[2]);
  const run = held(f, result, /^Delivered/u);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
});

test("a run continued from the checkpoint saved on entering stuck, after its question was written, writes that question again instead of failing", async context => {
  // A second plan revision stops the run, as it did before plan review could find a ticket too broad.
  const f = fixture(context); const slept: Ask[] = []; let planReviews = 0;
  const agents = {
    planReview: () => ok("revise", ++planReviews === 1 ? "Name the test that proves the greeting" : "The plan still names no test"),
    tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  };
  const saves = checkpointed();
  const first = await execute(input(f), agents, person(), { ...saves.options, onHumanSleep: request => { slept.push(request); } });
  assert.equal(String(first.state), "decide"); assert.equal(slept.length, 1);
  evidencePage(f, slept[0], "planReviewResult", /plan still names no test/iu, [plan, "The plan still names no test"]);
  assert.ok(stuckNote(f).includes(slept[0]!.page!), "the page is saved before the run sleeps");
  const runs = join(f.evidence, ".machine-runs/machine-shop"); const [id] = readdirSync(runs);
  asksWritten(join(runs, id!), slept);
  // The process ends after question-1.txt was written and before the question was put, so the run continues where stuck was entered.
  const checkpoint = saves.saved.stuck; assert.ok(checkpoint, "a checkpoint was saved on entering stuck");
  assert.equal(checkpoint.data.questions, 0);
  const rest = checkpointed(checkpoint); const human = person("hand off");
  const continued = await execute(input(f), agents, human, { ...rest.options, continueAt: { value: checkpoint.value, context: checkpoint.context } })
    .catch(error => assert.fail(`continuing at stuck failed: ${error.message}`));
  assert.deepEqual(continued.states.slice(0, 2), ["stuck", "decide"]);
  assert.equal(human.requests.length, 1); stuckQuestion(f, human.requests[0], "planReviewResult");
  evidencePage(f, human.requests[0], "planReviewResult", /plan still names no test/iu, [plan, "The plan still names no test"]);
  assert.equal(human.requests[0]!.page, slept[0]!.page, "restarting stuck rebuilds the same saved-state evidence");
  const run = handedOff(f, continued, /The plan still names no test/u, human); assert.equal(planReviews, 2);
  // The question is numbered as it was and rewritten as it is now put; there is no second one.
  asksWritten(run.directory, [human.requests[0]!]);
  assert.equal(statSync(join(run.directory, "question-1.txt")).mode & 0o777, 0o600);
});

test("the source keeps no plan length limit: no planLimit, no shorten outcome, and no length bookkeeping", () => {
  const source = readFileSync(resolve("ticket-task.ts"), "utf8");
  for (const gone of [/\bplanLimit\b/u, /\bshorten\b/u, /\blengthReturned\b/u, /\boverLimit\b/u, /\b6000\b/u, /\b6_000\b/u]) assert.doesNotMatch(source, gone);
});

const editsNothing = { planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() };

test("a too broad verdict asks one question holding the note's text, and an answer renews the run and goes back to plan in the same worktree with the answer in the planner's prompt", async context => {
  const f = fixture(context); const answer = "Keep it to two files: greeting.txt and greeting.test.txt."; const human = person(answer);
  const plans: string[] = []; const later: Record<string, string[]> = { planReview: [], tester: [], implementer: [], reviewer: [] }; const cwds = new Set<string>();
  const seen = (stage: string, work: Runner): Runner => request => { cwds.add(request.cwd); later[stage]!.push(request.prompt); return work(request); };
  const planned = planner(plans);
  const result = await execute(input(f), {
    plan: request => { cwds.add(request.cwd); return planned(request); },
    planReview: seen("planReview", broadOnce()), tester: seen("tester", tester), implementer: seen("implementer", implement), reviewer: seen("reviewer", () => review()),
  }, human);
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "decide", "plan", "planReview", "test", "change", "review"]);
  const at = result.states.indexOf("decide");
  assert.deepEqual(result.states.slice(at - 2, at + 3), ["planReviewResult", "stuck", "decide", "repairTarget", "plan"]);
  for (const state of ["park", "parked", "handOff", "confirmDiscard"]) assert.equal(result.states.includes(state), false, state);
  // The one question is the park note's text: the reason with the suggested split, what is needed, and where to look.
  assert.equal(human.requests.length, 1);
  const needs = stuckQuestion(f, human.requests[0], "planReviewResult");
  assert.match(human.requests[0]!.prompt, splitSaid); assert.doesNotMatch(needs, /^Clarify how/u); assert.match(needs, splitSaid);
  // The planner is asked again with the answer, and so is everyone after it; no prompt before the question had it.
  assert.equal(plans.length, 2);
  assert.equal(plans[0]!.includes(answer), false); assert.equal(later.planReview![0]!.includes(answer), false);
  assert.ok(plans[1]!.includes(answer), plans[1]); assert.ok(answersIn(plans[1]!).includes(answer), plans[1]);
  for (const [stage, prompts] of Object.entries(later)) {
    const after = stage === "planReview" ? prompts.slice(1) : prompts;
    assert.ok(after.length && after.every(prompt => answersIn(prompt).includes(answer)), stage);
  }
  assert.ok(planIn(later.tester![0]!).startsWith(`${plan}\n`));
  // One worktree throughout: every Agent worked in it, and the run made it once and removed it on delivery.
  assert.deepEqual([...cwds], [f.worktree]);
  const run = held(f, result, /^Delivered/u); untouched(f);
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, Object.hasOwn(run.delivery, "resumed")], [true, true, false]);
  assert.equal(existsSync(join(run.directory, "park.txt")), false);
  // The answer is recorded as the owner gave it, and neither budget was spent.
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: answer }]);
  assert.ok(existsSync(join(run.directory, "human-1.json")));
  assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 0]);
});

for (const reply of ["hand off", "discard"] as const) {
  test(`replying ${reply} to the question a too broad verdict asks ${reply === "hand off" ? "ends handedOff" : "asks for its confirmation, where go back asks the question again"}, as the decision did`, async context => {
    const f = fixture(context); const plans: string[] = [];
    const human = reply === "hand off" ? person("hand off") : person("discard", "go back", "discard", "confirm discard");
    const result = await execute(input(f), { plan: planner(plans), ...editsNothing, planReview: broadOnce() }, human);
    assert.equal(plans.length, 1);
    if (reply === "hand off") { questioned(f, result, splitSaid, human); return; }
    assert.deepEqual(result.states.slice(result.states.indexOf("decide")), ["decide", "confirmDiscard", "stuck", "decide", "confirmDiscard", "remove", "abandon", "abandoned"]);
    const [first, confirm, again, confirmed] = human.requests;
    stuckQuestion(f, first, "planReviewResult"); assert.match(first!.prompt, splitSaid);
    for (const request of [confirm!, confirmed!]) {
      assert.deepEqual(request.choices, ["confirm discard", "go back"]); assert.equal(request.prompt.split("\n")[0], "Discard the candidate for ticket PROJ-12?");
    }
    assert.deepEqual([again!.prompt, again!.suggestions], [first!.prompt, first!.suggestions]);
    const run = abandoned(f, result, "discard");
    assert.deepEqual(run.result.decisions.map((made: any) => `${made.stage}: ${made.response}`), ["decide: discard", "confirmDiscard: go back", "decide: discard", "confirmDiscard: confirm discard"]);
    // Going back asks the question again, and that ask is written as the next question.
    asksWritten(run.directory, [first!, again!]);
  });
}

test("a blank reply to the question asks it again", async context => {
  const f = fixture(context); const plans: string[] = []; const human = person(" \n", "hand off");
  const result = await execute(input(f), { plan: planner(plans), ...editsNothing, planReview: broadOnce() }, human);
  assert.equal(plans.length, 1); assert.equal(result.states.filter(state => state === "decide").length, 2);
  assert.equal(result.states.slice(result.states.indexOf("decide")).some(state => isPlanning(state) || state === "repairTarget"), false);
  const [first, again] = human.requests;
  assert.deepEqual([again!.prompt, again!.suggestions], [first!.prompt, first!.suggestions]);
  stuckQuestion(f, first, "planReviewResult");
  const run = handedOff(f, result, splitSaid, human);
  asksWritten(run.directory, [first!, again!]);
});

test("stuck park, ask, or left out all take a stuck run to the same question, and none of them parks", async context => {
  const routes: string[][] = [];
  for (const policy of ["park", "ask", undefined]) {
    const f = fixture(context); const human = person("hand off"); const plans: string[] = [];
    const data = input(f); if (policy === undefined) Reflect.deleteProperty(data, "stuck"); else data.stuck = policy;
    const result = await execute(data, { plan: planner(plans), ...editsNothing, planReview: broadOnce() }, human);
    questioned(f, result, splitSaid, human);
    routes.push(result.states);
  }
  assert.deepEqual(routes[1], routes[0]); assert.deepEqual(routes[2], routes[0]);
});

test("under the sleep option a stuck run sleeps on its question with nothing ended, and continuing it with an answer goes back to plan", async context => {
  const f = fixture(context); const answer = "Keep it to two files."; const plans: string[] = []; const slept: Ask[] = [];
  const agents = { plan: planner(plans), planReview: broadOnce() };
  const saves = checkpointed();
  const first = await execute(input(f), agents, person(), { ...saves.options, onHumanSleep: request => { slept.push(request); } });
  assert.equal(String(first.state), "decide"); assert.equal(first.states.at(-1), "decide"); assert.deepEqual(saves.unsaveable, []);
  assert.equal(slept.length, 1); stuckQuestion(f, slept[0], "planReviewResult"); assert.match(slept[0]!.prompt, splitSaid);
  evidencePage(f, slept[0], "planReviewResult", /too broad/iu, [plan, ...splitLines]);
  assert.ok(stuckNote(f).includes(slept[0]!.page!), "sleep preserves the deterministic page");
  // Nothing has ended: no final receipt or park note, and the worktree is kept on its branch.
  const runs = join(f.evidence, ".machine-runs/machine-shop"); const [id, ...others] = readdirSync(runs); assert.deepEqual(others, []);
  for (const name of ["delivery.json", "result.json", "park.txt"]) assert.equal(existsSync(join(runs, id!, name)), false, name);
  // The question it sleeps on is already in the evidence.
  asksWritten(join(runs, id!), slept);
  assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
  // A later process continues the run at its question with the owner's answer.
  const checkpoint = saves.saved.decide; assert.ok(checkpoint, "a checkpoint was saved on entering decide");
  const rest = checkpointed(checkpoint);
  const continued = await execute(input(f), agents, person(), { ...rest.options, continueAt: { value: checkpoint.value, context: checkpoint.context }, answer });
  assert.equal(continued.state, "delivered", evidence(f).delivery.reason);
  assert.deepEqual(continued.states.slice(0, 3), ["decide", "repairTarget", "plan"]);
  assert.equal(plans.length, 2); assert.ok(answersIn(plans[1]!).includes(answer), plans[1]);
  const run = held(f, continued, /^Delivered/u); untouched(f);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: answer }]);
  // Continuing at the question does not write it again.
  asksWritten(run.directory, slept);
});

test("a run continued at its question with a blank reply asks again and writes question-2.txt beside the first, which stays as it was", async context => {
  const f = fixture(context); const plans: string[] = []; const slept: Ask[] = [];
  const agents = { plan: planner(plans), ...editsNothing, planReview: broadOnce() };
  const saves = checkpointed();
  const first = await execute(input(f), agents, person(), { ...saves.options, onHumanSleep: request => { slept.push(request); } });
  assert.equal(String(first.state), "decide"); assert.equal(slept.length, 1);
  const runs = join(f.evidence, ".machine-runs/machine-shop"); const [id] = readdirSync(runs);
  asksWritten(join(runs, id!), slept);
  // The count of questions is carried in the saved data, so the continued run numbers its next ask 2.
  const checkpoint = saves.saved.decide!; const rest = checkpointed(checkpoint); const human = person("hand off");
  const continued = await execute(input(f), agents, human, { ...rest.options, continueAt: { value: checkpoint.value, context: checkpoint.context }, answer: " \n" });
  assert.deepEqual(continued.states.slice(0, 2), ["decide", "stuck"]);
  assert.equal(human.requests.length, 1); stuckQuestion(f, human.requests[0], "planReviewResult");
  const run = handedOff(f, continued, splitSaid, human);
  asksWritten(run.directory, [slept[0]!, human.requests[0]!]);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "hand off" }]);
});

test("no state of the run parks, whatever stuck is: there is neither a park nor a parked state, and nothing writes park.txt", context => {
  const f = fixture(context);
  for (const stuck of ["park", "ask", undefined]) {
    const data = input(f); if (stuck === undefined) Reflect.deleteProperty(data, "stuck"); else data.stuck = stuck;
    const states = Object.keys(mod.default(runtime, data).states);
    for (const state of ["park", "parked"]) assert.equal(states.includes(state), false, `${state} with stuck ${stuck}`);
    for (const state of ["stuck", "decide", "handOff", "handedOff"]) assert.ok(states.includes(state), `${state} with stuck ${stuck}`);
  }
  const source = readFileSync(resolve("ticket-task.ts"), "utf8");
  assert.doesNotMatch(source, /park\.txt/u, "ticket-task.ts still writes park.txt");
  assert.doesNotMatch(source, /["']parked["']/u, "ticket-task.ts still has a parked outcome");
});

for (const reply of ["Hand off", " hand off. ", "HAND OFF!", "hand off…", "Hand off?!", "\thand off ;"]) {
  test(`the reply ${JSON.stringify(reply)} is the hand off decision, matched ignoring case, surrounding whitespace and trailing punctuation`, async context => {
    const f = fixture(context); const plans: string[] = []; const human = person(reply);
    const result = await execute(input(f), { plan: planner(plans), ...editsNothing, planReview: broadOnce() }, human);
    assert.equal(plans.length, 1, "the reply is not taken as an answer that sends the run back to plan");
    // handedOff checks that delivery.json and the summary record the decision as hand off.
    const run = handedOff(f, result, splitSaid, human);
    assert.deepEqual(result.states.slice(-4), ["stuck", "decide", "handOff", "handedOff"]);
    // The reply is kept as the owner gave it.
    assert.deepEqual(run.result.decisions, [{ stage: "decide", response: reply }]);
    asksWritten(run.directory, human.requests);
  });
}

test("Discard. asks for confirmation as discard does, and confirm discard there stays exact: Confirm discard is refused", async context => {
  const f = fixture(context); const human = person("Discard.", "Confirm discard");
  await assert.rejects(execute(input(f), { ...editsNothing, planReview: broadOnce() }, human), /Expected one of: confirm discard, go back/u);
  assert.equal(human.requests.length, 2); assert.deepEqual(human.requests[1]!.choices, ["confirm discard", "go back"]);
  assert.ok(existsSync(f.worktree), "nothing was removed");
});

test("DISCARD! then confirm discard abandons the run with the decision recorded as discard", async context => {
  const f = fixture(context); const human = person("DISCARD!", "confirm discard");
  const result = await execute(input(f), { ...editsNothing, planReview: broadOnce() }, human);
  const run = abandoned(f, result, "discard");
  assert.deepEqual(run.result.decisions.map((made: any) => `${made.stage}: ${made.response}`), ["decide: DISCARD!", "confirmDiscard: confirm discard"]);
});

test("Archive. is the archive decision, and is recorded as archive", async context => {
  const f = fixture(context); const human = person("Archive.");
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, human);
  assert.deepEqual(result.states.slice(result.states.indexOf("decide"), result.states.indexOf("decide") + 2), ["decide", "archive"]);
  const run = abandoned(f, result, "archive");
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "Archive." }]);
  assert.deepEqual(run.delivery.archive, { branch: archiveBranch, commit: git(f.repo, "rev-parse", archiveBranch) });
});

test("More rounds? is the more rounds decision: it goes back to plan without becoming an answer", async context => {
  const f = fixture(context); const plans: string[] = []; const human = person("More rounds?");
  const result = await execute(input(f), { plan: planner(plans), planReview: broadOnce() }, human);
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  assert.equal(plans.length, 2);
  for (const prompt of plans) assert.equal(prompt.includes("More rounds?"), false, prompt);
  assert.equal(answersIn(plans[1]!), "", "more rounds carries no answer");
  const run = held(f, result, /^Delivered.* Decision: more rounds\. /u);
  assert.equal(run.delivery.decision, "more rounds");
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "More rounds?" }]);
});

test("a reply that only begins with a decision is still an answer", async context => {
  const f = fixture(context); const plans: string[] = []; const answer = "hand off please"; const human = person(answer);
  const result = await execute(input(f), { plan: planner(plans), planReview: broadOnce() }, human);
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  assert.equal(plans.length, 2); assert.ok(answersIn(plans[1]!).includes(answer), plans[1]);
});

test("an answer to a spent review budget renews the budgets as more rounds does and goes back to the implementer with the findings that stopped the run and the answer", async context => {
  const f = fixture(context); const answer = "The greeting language is English."; const human = person(answer);
  const prompts: string[] = []; let reviews = 0;
  const result = await execute(input(f, {}, { maxReviewRounds: 1 }), {
    implementer: request => { prompts.push(request.prompt); writeFileSync(join(request.cwd, "greeting.txt"), `hello ${prompts.length}\n`); return ok(); },
    reviewer: () => ++reviews < 4 ? ownerReview(`Finding ${reviews}`) : review(),
  }, human);
  assert.equal(result.state, "delivered", evidence(f).delivery.reason);
  assert.deepEqual([prompts.length, reviews, human.requests.length], [4, 4, 1]);
  const at = result.states.indexOf("decide");
  assert.deepEqual(result.states.slice(at - 2, at + 3), ["reviewBudget", "stuck", "decide", "repairTarget", "change"]);
  const needs = stuckQuestion(f, human.requests[0], "reviewBudget");
  assert.match(needs, /^Review budget used up \(1 of 1\)\.\nFinding 2/u);
  // The round after the answer is briefed with the findings that stopped the run and with the answer, not with the spent budget.
  const feedback = prompts[2]!.split("Current failure/feedback: ")[1] ?? "";
  assert.ok(feedback.includes("Finding 2"), feedback); assert.ok(feedback.includes(answer), feedback); assert.doesNotMatch(feedback, /budget exhausted/u);
  // The answer stands for the rest of the run.
  assert.equal(prompts[1]!.includes(answer), false); assert.ok(answersIn(prompts[3]!).includes(answer), prompts[3]);
  // A fresh review budget: the third revise went back to the implementer instead of asking again.
  const run = held(f, result, /^Delivered/u); untouched(f);
  assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 2]);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: answer }]);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello 4");
});

for (const assume of [true, false]) {
  test(`with assume ${assume ? "on" : "off"}, a falsify question that is not assumable is asked, and its answer goes back to falsify and reaches the planner`, async context => {
    const f = fixture(context); const answer = "English, for every reader."; const human = person(answer);
    const falsified: string[] = []; const plans: string[] = [];
    const result = await execute(input(f, {}, { assume }), {
      falsify: request => { falsified.push(request.prompt); return falsified.length === 1 ? gaps([language, beside], "Two gaps, one of them the owner's") : planning.falsify!.answer(request); },
      plan: request => { plans.push(request.prompt); return planning.plan!.answer(request); },
    }, human);
    assert.equal(result.state, "delivered", evidence(f).delivery.reason);
    assert.deepEqual(route(result.states), ["falsify", "decide", "falsify", "plan", "planReview", "test", "change", "review"]);
    const at = result.states.indexOf("decide");
    assert.deepEqual(result.states.slice(at - 2, at + 3), ["falsifyResult", "stuck", "decide", "repairTarget", "falsify"]);
    // The question is the one only the owner can answer, with what the run would have assumed beside it when assume is on.
    assert.equal(human.requests.length, 1);
    const needs = stuckQuestion(f, human.requests[0], "falsifyResult").split("\n");
    assert.match(needs[0]!, openQuestions); optionsFirst(needs[1]!, 1, language);
    assert.equal(numberedLines(needs).length, assume ? 1 : 2);
    if (assume) assert.match(needs.join("\n"), /would have assumed/iu);
    // falsify is asked again with the answer, and the planner of the ticket it then finds sound is given it under its own heading.
    assert.equal(falsified.length, 2); assert.equal(falsified[0]!.includes(answer), false); assert.ok(falsified[1]!.includes(answer));
    assert.equal(plans.length, 1); assert.ok(answersIn(plans[0]!).includes(answer), plans[0]);
    const run = held(f, result, /^Delivered/u);
    assert.deepEqual(run.result.decisions, [{ stage: "decide", response: answer }]);
    assert.equal(existsSync(join(run.directory, "assumptions.json")), false);
  });
}

test("a run stuck on six falsify questions counts them in a first sentence under 100 characters, gives each question with its options and why once, and offers the same decisions", async context => {
  const f = fixture(context); const human = person("hand off");
  const six = Array.from({ length: 6 }, (_, index) => gap(`Which greeting goes on line ${index + 1}?`, {
    options: [`Greeting ${index + 1}a`, `Greeting ${index + 1}b`], recommended: `Greeting ${index + 1}b`, why: `Line ${index + 1} is not named in the ticket.`,
  }));
  const result = await execute(input(f, {}, { assume: false }), {
    falsify: () => gaps(six, "Six lines are open"),
    plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /Which greeting goes on line 1\?/u, human);
  const lines = run.prompt.split("\n");
  // What is needed, then where the run stands, once, then the questions, once, under Needs.
  assert.deepEqual(lines.slice(0, 5), ["Answer 6 open questions before any code is written.", "", standsAt("falsifyResult"), "Repair rounds used: 0 of 3.", "Review rounds used: 0 of 2."]);
  assert.equal(needsIn(run.prompt, f.worktree), six.map((asked, index) => `${index + 1}. ${asked.text} Options: ${asked.recommended} (recommended); ${asked.options[0]} Why: ${asked.why}`).join("\n"));
  for (const asked of six) for (const part of [asked.text, ...asked.options, asked.why]) assert.equal(occurrences(run.prompt, part), 1, part);
  // The decisions, their wording, and what each does are as before.
  assert.deepEqual(lines.slice(-5), [
    "hand off: stop here and keep the worktree and branch exactly as they are, with nothing committed, for another workflow or a person. (recommended)",
    "more rounds: restart the repair budget and return to falsify with the standing feedback.",
    `archive: commit the candidate as delivery would have and keep that commit as the branch ${archiveBranch}, then remove the worktree and delete ${branch}. Ignored files are not kept.`,
    "discard: remove the worktree and delete the branch without saving the candidate; asks for confirmation first.",
    "any other reply: answer the question and return to the stage that stopped with fresh budgets and this answer as standing feedback.",
  ]);
  assert.ok(result.output.summary.startsWith("Handed off: Answer 6 open questions before any code is written. "), result.output.summary);
});

test("a plan over 16000 characters goes back once with the exact fault, then is refused as an empty one is", async context => {
  const f = fixture(context); const human = person("hand off"); const plans: string[] = [];
  const result = await execute(input(f, {}, { stuck: "park" }), {
    plan: request => { plans.push(request.prompt); return ok("planned", "p".repeat(16_001)); },
    planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /\bsummary\b/u, human);
  assert.equal(plans.length, 2); assert.equal(result.states.at(-5), "planResult");
  assert.deepEqual(result.states.filter(isPlanning), ["falsify", "plan", "plan"]);
  assert.match(run.delivery.reason, /\bplan\b/u); assert.match(run.delivery.reason, /\b16000 characters\b/u);
  assert.doesNotMatch(run.delivery.reason, /sent back|too broad/u);
  assert.ok(plans[1]!.includes(sentBack(summaryFault("plan"))));
  assert.notDeepEqual(keptIn(run.directory, summaryFault("plan")), []);
  assert.equal(candidate(f.worktree).status, "");
});

for (const [label, answer] of [
  ["the whole event as JSON text in its summary", () => ({ type: "planned", summary: JSON.stringify({ type: "planned", summary: plan }) })],
  ["the plan only as its message", () => ({ type: "planned", message: plan })],
  ["the whole event as JSON text in its message", () => ({ type: "planned", message: JSON.stringify({ type: "planned", summary: plan }, null, 2) })],
] as const) {
  test(`a runner that hands back ${label} gives the reviewer, the tester, and the implementer the prose plan the stage report holds`, async context => {
    const f = fixture(context); const prompts: Record<string, string> = {};
    const result = await execute(input(f, {}, { stuck: "park" }), {
      plan: answer,
      planReview: request => { prompts.planReview = request.prompt; return planning.planReview!.answer(request); },
      tester: request => { prompts.tester = request.prompt; return tester(request); },
      implementer: request => { prompts.implementer = request.prompt; return implement(request); },
    });
    assert.equal(result.state, "delivered", evidence(f).delivery.reason);
    const run = held(f, result, /^Delivered/u);
    const reported: string = run.result.agents[1].summary;
    assert.deepEqual(run.result.agents[1], { stage: "plan", outcome: "planned", summary: plan });
    for (const stage of ["planReview", "tester", "implementer"]) {
      // The plan follows its heading as it was written, not as the JSON that carried it.
      assert.ok(planIn(prompts[stage]!).startsWith(`${reported}\n`), stage);
      assert.equal(planIn(prompts[stage]!).trimStart().startsWith("{"), false, stage);
    }
  });
}

/** The outcomes each planning state can return, every one of which needs a summary. */
const reporting: Record<string, string[]> = { falsify: ["sound", "questions"], plan: ["planned"], planReview: ["approved", "revise", "tooBroad"] };
for (const policy of ["park", "ask"] as const) {
  for (const [label, summary] of [["no summary", {}], ["an empty summary", { summary: "" }], ["a blank summary", { summary: " \n" }]] as const) {
    test(`with stuck ${policy}, a report with ${label} from falsify, plan, or planReview goes back once, then stops for the owner with the state and the summary named`, async context => {
      for (const [state, outcomes] of Object.entries(reporting)) for (const outcome of outcomes) {
        const f = fixture(context); const human = person("hand off"); const calls: string[] = [];
        const reading = (name: string): Runner => request => {
          calls.push(name);
          if (name !== state) return planning[name]!.answer(request);
          return { type: outcome, ...summary, ...(outcome === "questions" ? { questions: [language] } : {}) };
        };
        // A run that fails outright, as with "Operation failed in state", stops for nobody.
        const result = await execute(input(f, {}, { stuck: policy }), {
          falsify: reading("falsify"), plan: reading("plan"), planReview: reading("planReview"),
          tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
        }, human).catch(error => assert.fail(`${state} returning ${outcome} failed the run: ${error.message}`));
        // Both policies ask the same one question.
        const run = questioned(f, result, /\bsummary\b/u, human);
        assert.match(run.delivery.reason, new RegExp(`\\b${state}\\b`, "u"), `${state} returning ${outcome}`);
        assert.doesNotMatch(run.delivery.reason, /Operation failed/u);
        assert.equal(result.states.at(-5), `${state}Result`);
        assert.deepEqual(calls, [...upTo(state), state]); assert.equal(candidate(f.worktree).status, "");
      }
    });
  }
}

test("more rounds after falsify questions returns to falsify, and a ticket then found sound is planned, reviewed, and tested before it is implemented", async context => {
  const f = fixture(context); const human = person("more rounds"); const prompts: Record<string, string> = {}; let falsified = 0;
  const result = await execute(input(f), {
    falsify: request => ++falsified === 1
      ? { type: "questions", summary: "The ticket leaves the language open", questions: [language] } : planning.falsify!.answer(request),
    plan: request => {
      assert.doesNotMatch(request.prompt, /Current failure\/feedback:/u, "sound clears the settled falsify questions");
      return planning.plan!.answer(request);
    },
    tester: request => { prompts.tester = request.prompt; return tester(request); },
    implementer: request => { assert.ok(prompts.tester, "the tester runs before the implementer"); prompts.implementer = request.prompt; return implement(request); },
  }, human);
  assert.equal(result.state, "delivered");
  assert.deepEqual(route(result.states), ["falsify", "decide", "falsify", "plan", "planReview", "test", "change", "review"]);
  assert.match(human.requests[0]!.prompt, /Which language is the greeting in\?/u); assert.equal(human.requests.length, 1);
  assert.match(human.requests[0]!.prompt, /return to falsify with the standing feedback/u);
  for (const role of ["tester", "implementer"]) assert.ok(planIn(prompts[role]!).startsWith(`${plan}\n`), role);
  const run = held(f, result, /^Delivered/u);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
  assert.deepEqual(run.result.agents.map((agent: any) => `${agent.stage}: ${agent.outcome}`),
    ["falsify: questions", "falsify: sound", "plan: planned", "planReview: approved", "test: completed", "change: completed", "review: approved"]);
  const reports = [1, 2].map(round => JSON.parse(readFileSync(join(run.directory, `falsify-${round}.json`), "utf8")));
  assert.deepEqual(reports.map(report => report.type), ["questions", "sound"]);
  assert.deepEqual(reports[0].questions, [language]);
});

test("more rounds after a second plan revision returns to plan with the reviewer's feedback, and the plan then approved goes to the tester before the implementer", async context => {
  const f = fixture(context); const human = person("more rounds"); const plans: string[] = []; const prompts: Record<string, string> = {}; let planReviews = 0;
  const result = await execute(input(f), {
    plan: request => { plans.push(request.prompt); return ok("planned", `Attempt ${plans.length}: add greeting.txt.`); },
    planReview: () => ++planReviews === 1 ? ok("revise", "Name the test that proves the greeting")
      : planReviews === 2 ? ok("revise", "The plan still names no test") : ok("approved", "The plan now names its test"),
    tester: request => { prompts.tester = request.prompt; return tester(request); },
    implementer: request => { assert.ok(prompts.tester, "the tester runs before the implementer"); prompts.implementer = request.prompt; return implement(request); },
  }, human);
  assert.equal(result.state, "delivered");
  assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "plan", "planReview", "decide", "plan", "planReview", "test", "change", "review"]);
  assert.match(human.requests[0]!.prompt, /The plan still names no test/u); assert.equal(human.requests.length, 1);
  assert.match(human.requests[0]!.prompt, /return to plan with the standing feedback/u);
  // The planner a person sent back to is briefed with what the reviewer last said, as on the first revision; a decision is not an answer.
  assert.ok(plans[2]!.includes("Current failure/feedback: The plan still names no test")); assert.doesNotMatch(plans[2]!, /^Answers from the ticket owner:/mu);
  for (const role of ["tester", "implementer"]) assert.ok(planIn(prompts[role]!).startsWith("Attempt 3: add greeting.txt.\n"), role);
  const run = held(f, result, /^Delivered/u);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
  for (const round of [1, 2, 3]) {
    const report = JSON.parse(readFileSync(join(run.directory, `plan-${round}.json`), "utf8"));
    const reviewed = JSON.parse(readFileSync(join(run.directory, `planReview-${round}.json`), "utf8"));
    assert.deepEqual(report, ok("planned", `Attempt ${round}: add greeting.txt.`));
    assert.equal(reviewed.type, round === 3 ? "approved" : "revise");
  }
});

for (const state of ["falsify", "plan"]) {
  test(`more rounds after a stop in ${state} that stops again asks again, and never reaches the tester or the implementer`, async context => {
    const f = fixture(context); const human = person("more rounds", "hand off"); let planReviews = 0;
    const result = await execute(input(f), {
      ...(state === "falsify" ? { falsify: () => ({ type: "questions", summary: "The ticket leaves the language open", questions: [language] }) }
        : { planReview: () => ok("revise", `The plan names no test, round ${++planReviews}`) }),
      tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    handedOff(f, result, state === "falsify" ? /Which language is the greeting in\?/u : /The plan names no test, round \d/u, human);
    const went = route(result.states); const first = went.indexOf("decide");
    assert.deepEqual(went.slice(0, first + 1), state === "falsify" ? ["falsify", "decide"] : ["falsify", "plan", "planReview", "plan", "planReview", "decide"]);
    // The grant goes back to the state that stopped; without an approved plan nothing after it is one that edits.
    assert.equal(went[first + 1], state); assert.equal(went.at(-1), "decide");
    assert.equal(went.some(visited => visited === "test" || visited === "change" || visited === "review"), false);
    assert.equal(candidate(f.worktree).status, "");
  });
}

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
    const run = handedOff(f, result, /read-only stage/u, human);
    assert.deepEqual(calls, upTo(state));
    assert.equal(readFileSync(join(f.worktree, "code.txt"), "utf8"), "edited");
    // What the state reported is kept before its guard runs, so the one that edited is among the stage reports.
    assert.deepEqual(run.result.agents.map((agent: any) => agent.stage), upTo(state));
    assert.equal(run.result.agentInvocations, upTo(state).length);
  });
}

test("a tester blocker waits for a decision with what is missing, before any implementation", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f), { tester: () => ok("blocked", "Acceptance criteria\nare missing"), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human);
  handedOff(f, result, /Acceptance criteria\s+are missing/u, human);
  assert.ok(result.output.summary.startsWith(`Handed off: Acceptance criteria are missing. Decision: hand off. Branch: ${branch}. Worktree kept at ${f.worktree}. Evidence: `), result.output.summary);
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
  // Each failed round runs the gate once more by itself, and it fails again.
  assert.equal(edits, 3); assert.deepEqual(run.result.checks.map(c => c.passed), [true, false, false, false, false, false, false]);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined);
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
  const [request, ...others] = human.requests; assert.deepEqual(others, []);
  assert.deepEqual([request!.suggestions, request!.choices], [stuckDecisions, undefined]);
  // The spent budget is the first sentence, and what failed last is said once, under it.
  assert.equal(request!.prompt.split("\n")[0], "Repair budget used up (2 of 2).");
  const failed = `verify: tests did not meet its expected result; inspect ${run.result.checks[5].log}`;
  for (const part of [standsAt("repairBudget"), `Needs: ${failed}`, run.result.checks[6].log,
    "Repair rounds used: 2 of 2.", `Worktree: ${f.worktree}`, `Branch: ${branch}`]) assert.ok(request!.prompt.includes(part), part);
  assert.equal(occurrences(request!.prompt, failed), 1); assert.equal(request!.prompt.includes("Add a greeting"), false);
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
  assert.deepEqual(run.result.checks.map(check => check.passed), [true, false, false, false, false, false, false, false, false]);
  assert.equal(human.requests.length, 1);
  assert.ok(human.requests[0]!.prompt.includes("Repair rounds used: 3 of 3."));
});

test("the default review budget allows two retries and one fresh budget for fixable blockers before asking", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const result = await execute(input(f), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => review("revise", `Finding ${++reviews}`),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(2\)\. Finding 6/u, human);
  assert.deepEqual([edits, reviews, run.result.repairs, run.result.reviewRounds, run.result.checksPassed], [6, 6, 0, 2, true]);
  assert.ok(human.requests[0]!.prompt.includes("Review rounds used: 2 of 2."));
});

test("a base that does not resolve is refused in prepare without a Human step", async context => {
  const f = fixture(context);
  const result = await execute(input(f, { base: "no-such-branch" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]);
  const run = held(f, result, /^Refused: Base no-such-branch does not resolve/u); untouched(f);
  assert.deepEqual([run.delivery.outcome, run.delivery.decision, run.delivery.worktreeCreated, run.result.decisions], ["refused", undefined, false, []]);
  assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
});

test("more rounds restarts the budget with the standing findings, and an approval then delivers", async context => {
  const f = fixture(context); const human = person("more rounds"); const prompts: string[] = []; let reviews = 0;
  const result = await execute(input(f, {}, { maxRepairs: 1, maxReviewRounds: 1 }), {
    implementer: request => { prompts.push(request.prompt); writeFileSync(join(request.cwd, "greeting.txt"), `hello ${prompts.length}\n`); return ok(); },
    reviewer: () => ++reviews < 3 ? ownerReview(`Finding ${reviews}`) : review("approved", "Greeting matches the ticket"),
  }, human);
  assert.equal(result.state, "delivered"); assert.deepEqual([prompts.length, reviews, human.requests.length], [3, 3, 1]);
  assert.deepEqual(result.states.slice(-15), ["reviewBudget", "stuck", "decide", "repairTarget", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  assert.ok(human.requests[0]!.prompt.startsWith("Review budget used up (1 of 1).\n")); assert.ok(human.requests[0]!.prompt.includes("\nNeeds: Finding 2"));
  // The pass a person granted is briefed exactly as the ordinary repair before it was.
  assert.ok(prompts[1]!.includes("Current failure/feedback: Finding 1")); assert.ok(prompts[2]!.includes("Current failure/feedback: Finding 2"));
  assert.doesNotMatch(prompts[2]!, /budget exhausted/u);
  const commit = git(f.repo, "rev-parse", branch);
  const run = held(f, result, new RegExp(`^Delivered ${branch} at ${commit}\\. Decision: more rounds\\. Evidence: `, "u")); untouched(f);
  assert.deepEqual([run.delivery.outcome, run.delivery.decision, run.delivery.commit, run.delivery.worktreeRemoved], ["delivered", "more rounds", commit, true]);
  assert.deepEqual([run.result.outcome, run.result.repairs, run.result.reviewRounds, run.result.agentInvocations], ["completed", 0, 1, 10]);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
  asksWritten(run.directory, human.requests);
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
  assert.deepEqual([run.result.repairs, run.result.checks.length], [3, 13]);
  assert.deepEqual(run.result.decisions.map((made: any) => made.response), ["more rounds", "more rounds", "hand off"]);
});

test("more rounds after a budget of zero still gives the implementer one pass", async context => {
  const f = fixture(context); const human = person("more rounds"); let reviews = 0;
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ++reviews === 1 ? ownerReview("Handle the empty case") : review("approved") }, human);
  assert.equal(result.state, "delivered"); assert.equal(reviews, 2); assert.ok(human.requests[0]!.prompt.includes("Repair rounds used: 0 of 0."));
});

/**
 * A revise whose only finding is a blocker inside Scope. Its text differs from the summary, so it reaches a prompt only as feedback and not
 * through the stage reports, and each round's text and newSinceLastRound differ, so the review never stops as not converging.
 */
const fixableReview = (round: number, where = "greeting.txt:1", extra = {}) => review("revise", `Review ${round}`, {
  findings: [{ severity: "blocker", text: `Blocker ${round}`, where }], newSinceLastRound: `New in round ${round}`, ...extra,
});
/** The line of a stuck question that says the one extra review round was used; undefined when it says nothing of it. */
const extraRoundLine = (prompt: string) => prompt.split("\n").find(line => /extra (review )?round/iu.test(line) && /\bused\b/u.test(line));

test("a spent review budget whose last revise has only in-Scope blockers goes back to the implementer once with them, and asks the owner only when a second budget is spent", async context => {
  const f = fixture(context); const prompts: string[] = []; const reviewed: string[] = []; const asked: number[] = [];
  const human = person(() => { asked.push(prompts.length); return "more rounds"; }, () => { asked.push(prompts.length); return "hand off"; });
  const result = await execute(input(f, {}, { maxReviewRounds: 1 }), {
    implementer: request => { prompts.push(request.prompt); writeFileSync(join(request.cwd, "greeting.txt"), `hello ${prompts.length}\n`); return ok(); },
    reviewer: request => { reviewed.push(request.prompt); return fixableReview(reviewed.length); },
  }, human);
  const run = handedOff(f, result, /budget exhausted \(1\)\. Review 6/u, human);
  // The first budget is spent at the second review; the run goes on to two more passes instead of asking, and asks after the fourth.
  // More rounds then renews the budget as ever, but the extra round is not given again: the next spent budget asks straight away.
  assert.deepEqual(asked, [4, 6]); assert.equal(reviewed.length, 6);
  assert.equal(result.states.filter(state => state === "stuck").length, 2);
  assert.match(stuckQuestion(f, human.requests[0], "reviewBudget"), /^Review budget used up \(1 of 1\)\.\nReview 4/u);
  // The implementer's first pass in the extra round carries the blocker that spent the budget, and it stands for the round's later pass too.
  assert.ok(prompts[2]!.includes("Blocker 2"), prompts[2]);
  assert.ok(prompts[3]!.includes("Blocker 2"), prompts[3]); assert.ok(prompts[3]!.includes("Blocker 3"), prompts[3]);
  assert.equal(prompts[1]!.includes("Blocker 2"), false);
  // The reviewer is asked as before: the standing blocker is the implementer's, not the reviewer's.
  assert.equal(reviewed[3]!.includes("Blocker 2"), false, reviewed[3]);
  asksWritten(run.directory, human.requests);
  assert.deepEqual(run.result.decisions.map((made: any) => made.response), ["more rounds", "hand off"]);
});

for (const [where, output] of [["greeting.txt:1", "branch"], ["./greeting.test.txt:1-4", "pr"], ["greeting.txt", "branch"]] as const) {
  test(`an extra review round at ${where} that ends approved commits and delivers by ${output} without asking the owner`, async context => {
    const f = fixture(context); if (output === "pr") { remote(f); fakeGh(context, f); }
    const human = person(); let edits = 0; let reviews = 0;
    const result = await execute(input(f, { output }, { maxReviewRounds: 1 }), {
      implementer: request => { edits++; writeFileSync(join(request.cwd, "greeting.txt"), `hello ${edits}\n`); return ok(); },
      reviewer: () => ++reviews < 3 ? fixableReview(reviews, where, reviews === 2 ? { findings: [
        { severity: "blocker", text: `Blocker ${reviews}`, where }, { severity: "minor", text: "Name the greeting", where: "greeting.txt:1" },
      ] } : {}) : review(),
    }, human);
    assert.deepEqual([edits, reviews, human.requests.length], [3, 3, 0]);
    assert.equal(result.states.includes("stuck"), false); assert.equal(result.states.includes("decide"), false);
    const run = ended(f, result, output);
    assert.deepEqual([run.result.outcome, run.delivery.outcome], ["completed", "delivered"]);
    assert.equal(git(f.repo, "show", `${run.delivery.commit ?? branch}:greeting.txt`), "hello 3");
  });
}

for (const [label, findings] of [
  ["a blocker outside Scope", [{ severity: "blocker", text: "Blocker 1", where: "elsewhere.txt:3" }]],
  ["a blocker that names no path", [{ severity: "blocker", text: "Blocker 1", where: "" }]],
  ["a second blocker outside Scope", [{ severity: "blocker", text: "Blocker 1", where: "greeting.txt:1" }, { severity: "blocker", text: "Blocker 1b", where: "src/elsewhere.ts:4-9" }]],
  ["a minor finding outside Scope", [{ severity: "blocker", text: "Blocker 1", where: "greeting.txt:1" }, { severity: "minor", text: "Tidy the notes", where: "docs/notes.md:2" }]],
] as const) {
  test(`a spent review budget whose last revise has ${label} asks the owner at once, as before`, async context => {
    const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
    const result = await execute(input(f, {}, { maxReviewRounds: 0 }), {
      implementer: request => { edits++; return implement(request); },
      reviewer: () => { reviews++; return fixableReview(1, undefined, { findings }); },
    }, human);
    handedOff(f, result, /budget exhausted \(0\)\. Review 1/u, human);
    assert.deepEqual([edits, reviews, human.requests.length], [1, 1, 1]);
    assert.equal(extraRoundLine(human.requests[0]!.prompt), undefined, human.requests[0]!.prompt);
  });
}

const unmet = [{ text: criterion, met: false, evidence: "greeting.txt:1" }];
for (const [label, extra] of [
  ["an unmet criterion and no finding", { criteria: unmet, findings: [] }],
  ["an unmet criterion and only a minor finding", { criteria: unmet, findings: [{ severity: "minor", text: "Name the greeting", where: "greeting.txt:1" }] }],
  ["only a discussion finding", { findings: [{ severity: "discussion", text: "Should the greeting be localized?", where: "greeting.txt:1" }] }],
  ["a blocker and a discussion finding", { findings: [
    { severity: "blocker", text: "Blocker 1", where: "greeting.txt:1" }, { severity: "discussion", text: "Should the greeting be localized?", where: "greeting.txt:1" },
  ] }],
] as const) {
  test(`a spent review budget whose last revise has ${label} asks the owner at once, as before`, async context => {
    const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
    const result = await execute(input(f, {}, { maxReviewRounds: 0 }), {
      implementer: request => { edits++; return implement(request); },
      reviewer: () => { reviews++; return fixableReview(1, undefined, extra); },
    }, human);
    handedOff(f, result, /budget exhausted \(0\)\. Review 1/u, human);
    assert.deepEqual([edits, reviews, human.requests.length], [1, 1, 1]);
    assert.equal(extraRoundLine(human.requests[0]!.prompt), undefined, human.requests[0]!.prompt);
  });
}

test("a run that stops after its extra review round says the round was used and gives the reviewer's newSinceLastRound", async context => {
  const f = fixture(context); const human = person("hand off"); let reviews = 0;
  const result = await execute(input(f, {}, { maxReviewRounds: 0 }), {
    implementer: implement, reviewer: () => fixableReview(++reviews),
  }, human);
  const run = handedOff(f, result, /budget exhausted \(0\)\. Review 2/u, human);
  assert.equal(reviews, 2);
  const [request] = human.requests;
  assert.match(stuckQuestion(f, request, "reviewBudget"), /^Review budget used up \(0 of 0\)\.\nReview 2/u);
  // Said above what is needed, with the reviewer's own account of what was new in the round.
  assert.ok(extraRoundLine(standingOf(request!.prompt)), request!.prompt);
  assert.ok(standingOf(request!.prompt).includes("New in round 2"), request!.prompt);
  asksWritten(run.directory, human.requests);
});

test("a run stopped another way during its extra review round says the round was used and gives the reviewer's newSinceLastRound", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const result = await execute(input(f, {}, { maxReviewRounds: 1 }), {
    implementer: request => { if (++edits === 4) return ok("blocked", "The greeting file is locked"); writeFileSync(join(request.cwd, "greeting.txt"), `hello ${edits}\n`); return ok(); },
    reviewer: () => fixableReview(++reviews),
  }, human);
  handedOff(f, result, /The greeting file is locked/u, human);
  assert.deepEqual([edits, reviews, human.requests.length], [4, 3, 1]);
  const [request] = human.requests;
  assert.match(stuckQuestion(f, request, "change"), /^The greeting file is locked/u);
  assert.ok(extraRoundLine(standingOf(request!.prompt)), request!.prompt);
  assert.ok(standingOf(request!.prompt).includes("New in round 3"), request!.prompt);
});

test("the extra review budget keeps spent repair rounds and reports when no review has finished in it", async context => {
  const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0;
  const result = await execute(input(f, { checks: [command('process.exit(require("fs").readFileSync("greeting.txt", "utf8") === "fail" ? 1 : 0)')] }, {
    maxRepairs: 1, maxReviewRounds: 0,
  }), {
    implementer: request => {
      writeFileSync(join(request.cwd, "greeting.txt"), ++edits === 2 ? "hello\n" : "fail");
      return ok();
    },
    reviewer: () => fixableReview(++reviews),
  }, human);
  const run = handedOff(f, result, /Repair budget exhausted \(1\)/u, human);
  assert.deepEqual([edits, reviews, run.result.repairs], [3, 1, 1]);
  assert.deepEqual(run.result.checks.map(check => check.passed), [true, false, false, true, false, false]);
  assert.ok(extraRoundLine(standingOf(human.requests[0]!.prompt)));
  assert.match(standingOf(human.requests[0]!.prompt), /No review has finished in the extra round yet/u);
});

test("hand off leaves the worktree, the branch, and the uncommitted candidate as they were", async context => {
  const f = fixture(context); let before: unknown;
  const human = person(() => { before = candidate(f.worktree); return "hand off"; });
  const result = await execute(scoped(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), "code.txt"), {
    implementer: request => { writeFileSync(join(request.cwd, "code.txt"), "new"); return implement(request); }, reviewer: () => ownerReview("Handle the empty case"),
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
    reviewer: () => ownerReview("Handle the empty case"),
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
    reviewer: () => ownerReview("Handle the empty case"),
  }, human);
  abandoned(f, result, "archive");
  assert.equal(before, "?? greeting.test.txt\n?? greeting.txt\n!! build/out.bin\n!! debug.log");
  assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", archiveBranch), ".gitignore\ncode.txt\ngreeting.test.txt\ngreeting.txt");
  assert.ok(human.requests[0]!.prompt.includes(`archive: commit the candidate as delivery would have and keep that commit as the branch ${archiveBranch}, then remove the worktree and delete ${branch}. Ignored files are not kept.`));
});

/**
 * An archive or a removal that fails after the owner chose it fails the run plainly: the state's own message, with any log it names,
 * is the run's error, and nothing is turned into an ending. The worktree and the ticket branch stay, and the choice is in the evidence.
 */
async function failsPlainly(f: Fixture, running: Promise<unknown>, state: "archive" | "remove", message: RegExp, decisions: string[]) {
  let error: Error | undefined;
  await assert.rejects(running, (thrown: Error) => { error = thrown; return true; });
  assert.ok(error!.message.startsWith(`Operation failed in state "${state}": `), error!.message); assert.match(error!.message, message);
  const directory = runDirectory(f); untouched(f);
  assert.deepEqual(readdirSync(directory).filter(name => /^human-\d+\.json$/u.test(name)).sort().map(name => JSON.parse(readFileSync(join(directory, name), "utf8")).response), decisions);
  assert.ok(existsSync(join(f.worktree, "code.txt"))); assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
  assert.equal(git(f.repo, "worktree", "list").split("\n").length, 2);
  return { directory, message: error!.message };
}

test("a candidate that does not differ from its base is not archived: the run fails with the reason, and nothing is removed", async context => {
  const f = fixture(context);
  writeFileSync(join(f.repo, ".gitignore"), "*.log\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "ignore"); f.head = git(f.repo, "rev-parse", "HEAD");
  // An ignored file is no difference: delivery would not have committed it either.
  const human = person(() => { writeFileSync(join(f.worktree, "debug.log"), "what the tester learned\n"); return "archive"; });
  await failsPlainly(f, execute(input(f), { tester: () => ok("blocked", "The ticket names no file"), implementer: () => assert.fail(), reviewer: () => assert.fail() }, human), "archive",
    new RegExp(`candidate could not be archived, so nothing was removed: the candidate does not differ from its base commit ${f.head}, so there is nothing to archive; discard removes it`, "u"), ["archive"]);
  assert.equal(candidate(f.worktree, true).status, "!! debug.log"); assert.equal(git(f.worktree, "diff", "--cached", "--name-only"), "");
  assert.equal(git(f.repo, "rev-parse", branch), f.head); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
});

test("an existing archive branch fails the archive before anything is staged, and nothing is removed", async context => {
  const f = fixture(context); git(f.repo, "branch", archiveBranch);
  let before: ReturnType<typeof candidate> | undefined; let index = "";
  const human = person(() => { before = candidate(f.worktree); index = git(f.worktree, "ls-files", "--stage"); return "archive"; });
  await failsPlainly(f, execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, human), "archive",
    new RegExp(`candidate could not be archived, so nothing was removed: branch ${archiveBranch} already exists in .+, and nothing was staged`, "u"), ["archive"]);
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
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, person("archive"));
  const run = abandoned(f, result, "archive"); const commit = git(f.repo, "rev-parse", archiveBranch);
  assert.deepEqual(run.delivery, {
    schemaVersion: 1, outcome: "abandoned", reason: "Review budget exhausted (0). Handle the empty case\nBlocker: Handle the empty case (outside-scope.txt:1)", decision: "archive",
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
      reviewer: () => ownerReview("Handle the empty case"),
    }, person("archive"));
    const run = abandoned(f, result, "archive");
    assert.equal(git(f.repo, "log", "--format=%s", `${f.head}..${archiveBranch}`), further ? "Archive: Add a greeting\nagent commit" : "agent commit");
    assert.equal(git(f.repo, "show", `${archiveBranch}:greeting.txt`), "hello"); assert.equal(git(f.repo, "show", `${archiveBranch}:code.txt`), further ? "new" : "old");
    assert.deepEqual(run.delivery.archive, { branch: archiveBranch, commit: git(f.repo, "rev-parse", archiveBranch) });
  });
}

test("a worktree that is not clean after the archive commit fails the run with nothing removed and no archive branch", async context => {
  const f = fixture(context);
  // --no-verify skips the hooks that can refuse a commit; this one runs after it.
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/post-commit"), "#!/bin/sh\necho late > late.txt\n", { mode: 0o755 });
  await failsPlainly(f, execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, person("archive")), "archive",
    new RegExp(`candidate could not be archived, so nothing was removed: the worktree is not clean after the archive commit, so ${archiveBranch} would not hold all of the candidate`, "u"), ["archive"]);
  assert.equal(git(f.repo, "rev-list", "--count", `main..${branch}`), "1"); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
  assert.equal(git(f.repo, "log", "-1", "--format=%s", branch), "Archive: Add a greeting");
  assert.equal(readFileSync(join(f.worktree, "late.txt"), "utf8"), "late\n"); assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
});

test("a hook that resets HEAD off the archive commit and leaves a clean worktree fails the run with nothing removed and no archive branch", async context => {
  const f = fixture(context);
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/post-commit"), "#!/bin/sh\ngit reset --quiet --hard HEAD~1\n", { mode: 0o755 });
  await failsPlainly(f, execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, person("archive")), "archive",
    new RegExp(`candidate could not be archived, so nothing was removed: a commit hook or Git configuration moved HEAD off the archive commit or changed what it holds, so ${archiveBranch} would not hold the candidate; HEAD is at ${f.head}`, "u"), ["archive"]);
  assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
  // The reset left nothing for the clean check to see: the worktree is on the base without the candidate.
  assert.equal(git(f.worktree, "status", "--porcelain"), ""); assert.equal(git(f.repo, "rev-parse", branch), f.head); assert.ok(!existsSync(join(f.worktree, "greeting.txt")));
  // The archive commit is still where the hook left it, since the worktree and its reflog were kept.
  assert.equal(git(f.worktree, "log", "-1", "--format=%s", "HEAD@{1}"), "Archive: Add a greeting"); assert.equal(git(f.worktree, "show", "HEAD@{1}:greeting.txt"), "hello");
});

for (const [changed, script] of [
  ["subject", 'sed -i "1s/.*/Rewritten/" "$1"'],
  ["ticket", 'sed -i "s/^Ticket: PROJ-12$/Ticket: PROJ-123/" "$1"'],
] as const) {
  test(`a hook that rewrites the archive commit's ${changed} fails the run with nothing removed and no archive branch`, async context => {
    const f = fixture(context);
    // --no-verify skips commit-msg, not the hook that prepares the message.
    mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/prepare-commit-msg"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    await failsPlainly(f, execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, person("archive")), "archive",
      new RegExp(`candidate could not be archived, so nothing was removed: a commit hook or Git configuration changed the archive commit's message, so ${archiveBranch} would not name the ticket; HEAD is at [0-9a-f]{40}, which holds the candidate`, "u"), ["archive"]);
    assert.equal(git(f.repo, "rev-list", "--count", `main..${branch}`), "1"); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
    // The candidate is whole in the commit the hook reworded, on the ticket branch that was kept.
    assert.equal(git(f.worktree, "status", "--porcelain"), ""); assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head);
    assert.equal(git(f.repo, "log", "-1", "--format=%B", branch), changed === "subject" ? "Rewritten\n\nTicket: PROJ-12" : "Archive: Add a greeting\n\nTicket: PROJ-123");
    assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello"); assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
  });
}

test("a hook that adds to the archive commit's message without changing its subject or ticket does not prevent the archive", async context => {
  const f = fixture(context);
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/prepare-commit-msg"), '#!/bin/sh\nprintf "\\nPrepared-by: hook\\n" >> "$1"\n', { mode: 0o755 });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, person("archive"));
  abandoned(f, result, "archive");
  assert.equal(git(f.repo, "log", "-1", "--format=%B", archiveBranch), "Archive: Add a greeting\n\nTicket: PROJ-12\n\nPrepared-by: hook");
});

test("a candidate that cannot be staged fails the run with the saved log, and nothing is removed", async context => {
  const f = fixture(context);
  // Git refuses to add an embedded repository that has no commit.
  const human = person(() => { git(f.worktree, "init", "-q", "embedded"); return "archive"; });
  const run = await failsPlainly(f, execute(input(f, { checks: [command("process.exit(1)")] }, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => assert.fail() }, human), "archive",
    /candidate could not be archived, so nothing was removed; inspect .+git-add\.log/u, ["archive"]);
  assert.ok(run.message.includes(join(run.directory, "git-add.log"))); assert.ok(existsSync(join(run.directory, "git-add.log")));
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n"); assert.equal(git(f.repo, "rev-parse", branch), f.head);
  assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
});

test("discard then go back returns to the decision with the worktree, branch, and candidate as they were", async context => {
  const f = fixture(context); let before: unknown; let between: unknown;
  const human = person(() => { before = candidate(f.worktree); return "discard"; }, "go back", () => { between = candidate(f.worktree); return "hand off"; });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, human);
  assert.deepEqual(result.states.slice(-6), ["decide", "confirmDiscard", "stuck", "decide", "handOff", "handedOff"]);
  const run = handedOff(f, result, /budget exhausted \(0\)\. Handle the empty case/u, human);
  assert.deepEqual(between, before); assert.deepEqual(candidate(f.worktree), before);
  const [first, confirm, second] = human.requests;
  assert.deepEqual(confirm!.choices, ["confirm discard", "go back"]);
  assert.equal(first!.prompt.split("\n")[0], "Review budget used up (0 of 0).");
  assert.equal(confirm!.prompt.split("\n")[0], "Discard the candidate for ticket PROJ-12?");
  for (const request of [first!, confirm!]) {
    assert.equal(request.prompt.split("\n")[1], ""); assert.equal(request.prompt.split("\n")[2], standsAt("reviewBudget"));
    assert.equal(request.prompt.includes("Add a greeting"), false);
    // The reason is said once in each: under the first sentence in the question, and under Needs in the confirmation.
    assert.equal(occurrences(request.prompt, "Blocker: Handle the empty case (outside-scope.txt:1)"), 1);
    assert.match(request.prompt, /Repair rounds used: 0 of 0\./u); assert.match(request.prompt, /Review rounds used: 0 of 0\./u);
    assert.ok(request.prompt.includes(`Evidence: ${run.directory}`));
    assert.doesNotMatch(request.prompt, /^#/mu);
  }
  assert.ok(first!.prompt.indexOf("hand off:") < first!.prompt.indexOf("more rounds:"));
  assert.match(first!.prompt, /hand off: .+ \(recommended\)/u);
  assert.ok(confirm!.prompt.indexOf("confirm discard:") < confirm!.prompt.indexOf("go back:"));
  assert.doesNotMatch(confirm!.prompt, /\(recommended\)/u);
  assert.ok(confirm!.prompt.includes("\nNeeds: Review budget used up (0 of 0).\n"), confirm!.prompt);
  assert.ok(confirm!.prompt.indexOf("will not be saved") < confirm!.prompt.indexOf("\nNeeds: "));
  for (const part of [f.worktree, branch, "will not be saved"]) assert.ok(confirm!.prompt.includes(part), part);
  assert.deepEqual([second!.prompt, second!.suggestions], [first!.prompt, first!.suggestions]); assert.deepEqual(first!.suggestions, stuckDecisions);
  assert.deepEqual(run.result.decisions.map((made: any) => `${made.stage}: ${made.response}`), ["decide: discard", "confirmDiscard: go back", "decide: hand off"]);
  assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
});

test("discard removes the worktree and branch only after it is confirmed, and archives nothing", async context => {
  const f = fixture(context); let unconfirmed = false;
  const human = person("discard", () => {
    unconfirmed = existsSync(join(f.worktree, "greeting.txt")) && git(f.repo, "rev-parse", branch) === f.head && git(f.repo, "config", "--local", "--get", `branch.${branch}.ticket`) === "proj-12";
    return "confirm discard";
  });
  const result = await execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, human);
  assert.ok(unconfirmed); assert.deepEqual(result.states.slice(-5), ["decide", "confirmDiscard", "remove", "abandon", "abandoned"]);
  const run = abandoned(f, result, "discard");
  // The ticket record goes with the branch.
  assert.doesNotMatch(git(f.repo, "config", "--local", "--list"), /^branch\./mu);
  assert.equal(run.delivery.archive, undefined); assert.doesNotMatch(result.output.summary, /archived/u);
  assert.ok(result.output.summary.includes(`Decision: discard. Worktree and ${branch} removed without saving the candidate. Evidence: `));
  assert.deepEqual(run.result.decisions.map((made: any) => made.response), ["discard", "confirm discard"]);
});

test("a worktree that cannot be removed after a confirmed discard fails the run with the saved log", async context => {
  const f = fixture(context);
  const human = person("discard", () => { git(f.repo, "worktree", "lock", f.worktree); return "confirm discard"; });
  const run = await failsPlainly(f, execute(input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, human), "remove",
    /git worktree failed; inspect .+git-worktree\.log/u, ["discard", "confirm discard"]);
  assert.match(readFileSync(join(run.directory, "git-worktree.log"), "utf8"), /locked/u); assert.equal(git(f.repo, "branch", "--list", "archive/*"), "");
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n"); assert.equal(git(f.repo, "rev-parse", branch), f.head);
});

/** Ends a first run handed off with its uncommitted candidate, and returns the fixture a second run records its own evidence under. */
async function handOff(f: Fixture) {
  const first = await execute(input(f, { setup: [command('console.log("installed")', { name: "install" })] }, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, person("hand off"));
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
/** Unrelated refs stay fixed; the ticket branch and candidate recovery refs are checked separately. */
const others = (f: Fixture) => git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(ref => !ref.startsWith(`refs/heads/${branch} `) && !ref.startsWith("refs/machine-shop/saved/")).join("\n");
/** A reason names a commit by its hash, in full or abbreviated. */
const names = (reason: string, commit: string) => reason.includes(commit.slice(0, 7));
/** A push that deletes a remote branch rather than sending a commit. */
const deletes = (call: string) => /(?:^|\s)(?:--delete|-d)(?:\s|$)|(?:^|\s):refs\/heads\//u.test(call);
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
/**
 * A stop that `rebase` adds asks as every other stop does: through `stuck`, with the one question that names the state it stopped in, and
 * no park note. Answered with hand off, the candidate stays uncommitted in the kept worktree, for a resumed run to take up.
 */
function questionedIn(state: string, f: Fixture, result: { state: unknown; output: any; states: string[] }, reason: RegExp, human: { requests: Ask[] }) {
  assert.equal(result.state, "handedOff"); assert.deepEqual(result.states.slice(-5), [state, "stuck", "decide", "handOff", "handedOff"]);
  for (const other of ["park", "parked", "failure"]) assert.equal(result.states.includes(other), false, other);
  const run = held(f, result, /^Handed off: /u);
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision], ["blocked", "handed-off", "hand off"]);
  assert.match(run.delivery.reason, reason);
  const request = human.requests.at(-1)!; const needs = stuckQuestion(f, request, state);
  assert.match(oneLine(needs), spoken(reason)); assert.ok(request.prompt.includes(`Evidence: ${run.directory}`));
  assert.equal(existsSync(join(run.directory, "park.txt")), false); assert.equal(Object.hasOwn(run.delivery, "park"), false);
  handOffSummary(result.output.summary, f.worktree);
  return Object.assign(run, { prompt: request.prompt, needs });
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
/** The delivered branch holds exactly the ticket commit above a base tip; a merged pull request's branch is gone, so its delivered commit is given instead. */
function onTip(f: Fixture, tip: string, ref = branch) {
  assert.equal(git(f.repo, "rev-list", "--count", `${tip}..${ref}`), "1"); assert.equal(git(f.repo, "rev-parse", `${ref}^`), tip);
  assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", ref), "Add a greeting\nTicket: PROJ-12");
  return git(f.repo, "rev-parse", ref);
}
/** What a delivery left to look at: the ticket branch, or the commit the receipt names once a merged pull request took the branch away. */
const deliveredRef = (f: Fixture, output: string) => output === "pr" ? evidence(f).delivery.commit as string : branch;

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
    assert.deepEqual(result.states.slice(result.states.indexOf("reviewResult")), ["reviewResult", "commit", "rebase", "deliver", "success",
      ...(output === "pr" ? ["checkMerge", "cleanUp", "merged"] : ["delivered"])]);
    // Exactly the ticket commit lies above the new tip, under the ticket's message, and no other ref moved.
    const ref = deliveredRef(f, output);
    const commit = onTip(f, tip, ref); const run = ended(f, result, output, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", ref), "greeting.test.txt\ngreeting.txt");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", ref), "code.txt\ngreeting.test.txt\ngreeting.txt\nlater.txt\nlatest.txt");
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
    // The only commit pushed is the rebased one; deleting the merged branch afterwards goes to the same remote.
    // The test publishes the base to origin by name; the run pushes to the URL prepare read.
    const pushes = calls().filter(call => /^push\b/u.test(call) && !call.startsWith("push -q origin "));
    assert.deepEqual(pushes.filter(call => !deletes(call)), [`push --no-follow-tags ${hosted}.git ${commit}:refs/heads/${branch}`]);
    for (const call of pushes.filter(deletes)) assert.ok(call.includes(`${hosted}.git`) && call.includes(branch), call);
    assert.equal(pushed.atCheck(), `refs/heads/main ${tip}\nrefs/heads/${branch} ${commit}`); assert.equal(pushed(), `refs/heads/main ${tip}`);
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
  test(`a base ${label} under review is not rebased onto: the commit is undone, the run asks only hand off or discard for delivery by hand, and a resume is refused`, async context => {
    const f = fixture(context); const started = advance(f, "second.txt", "second\n"); const calls = recordGit(context, f); const human = person("hand off");
    let before: Candidate | undefined; let tip = ""; let refs = "";
    const result = await execute(input(f), {
      reviewer: request => { before = candidate(request.cwd); move(f); tip = f.head = git(f.repo, "rev-parse", "HEAD"); refs = others(f); return review(); },
    }, human);
    // A retry cannot succeed on a base that went back, so the question naming rebase offers only hand off and discard.
    const run = steppedOff(f, result, "rebase", "keepDecide", /by hand/iu, human); assert.deepEqual(result.states.slice(-7, -5), ["reviewResult", "commit"]);
    assert.deepEqual(phases(run), ["red", "verify"]);
    assert.ok(names(run.delivery.reason, started), "the reason names the base the run started from"); assert.ok(names(run.delivery.reason, tip), "the reason names the new tip");
    assert.ok(names(human.requests[0]!.prompt, started) && names(human.requests[0]!.prompt, tip), "the question names both commits");
    uncommitted(f, run, started, before!); assert.equal(others(f), refs); assert.equal(git(f.repo, "status", "--porcelain", "--untracked-files=all"), "");
    assert.ok(undone(calls(), started), "git reset --mixed <baseCommit>");
    assert.equal(calls().some(call => /(?:^|\s)rebase\s(?:.*\s)?--onto(?:\s|$)/u.test(call)), false);
    // Resume is not promised here: the branch's base is not in the new tip, and adopt refuses it as before, changing nothing.
    const again = next(f, 2);
    const refusal = await execute(input(again, {}, { resume: true }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    assert.equal(refusal.state, "refused"); assert.deepEqual(refusal.states, ["shape", "prepare", "refuse", "refused"]);
    held(again, refusal, /^Refused: Cannot resume: ticket\/proj-12-add-a-greeting holds 1 commit that is not in the base commit .+ or the base moved back; only an uncommitted candidate is resumed, and nothing was changed\. Evidence: /u);
    uncommitted(f, undefined, started, before!); assert.equal(others(f), refs);
  });
}

/** What the run tells the implementer it moved, ahead of the conflicts: the replay that conflicted, its files, and the tip it moved onto. */
const movedAtDelivery = /^Replay onto (\S+) conflicted in "?greeting\.txt"?; the run moved the approved candidate onto (\S+)/u;
/** Today's stop after a replay conflict, which a run that already moved its candidate says again, word for word, before saying so. */
const replayStop = /^Replay onto \S+ failed with conflicts in greeting\.txt\. The approved candidate is uncommitted on \S+; a resumed run moves it onto the current base and sends conflicts to the implementer to settle\. Inspect rebase logs in \S+\./u;
/** The first implementation, then the settling of the conflict the move left, keeping both greetings. */
const settles = (prompts: string[], settled = "hello\nhi\n") => (request: Request) => {
  if (prompts.push(request.prompt) === 1) return implement(request);
  writeFileSync(join(request.cwd, "greeting.txt"), settled); return ok("completed", "Kept both greetings");
};

test("a delivery replay conflict moves the approved candidate onto the tip in the same run: the implementer settles it, it is reviewed again, and it is delivered with no person asked", async context => {
  const f = fixture(context); const started = f.head; const human = person(); let tip = ""; let files: Record<string, string> = {};
  const prompts: string[] = []; const reviews: string[] = [];
  const result = await execute(input(f), {
    implementer: request => {
      if (prompts.length === 1) {
        // The conflict is in the worktree, on the tip, with nothing committed.
        assert.deepEqual(repositoryTurns(f), [], "Conflict repair must release the repository turn");
        assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(git(f.repo, "rev-parse", branch), tip);
        assert.match(git(request.cwd, "ls-files", "-u"), /\tgreeting\.txt$/mu);
        assert.match(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), /^<<<<<<< /mu);
      }
      return settles(prompts)(request);
    },
    reviewer: request => {
      reviews.push(request.prompt);
      if (reviews.length === 1) { files = stood({ ...f, worktree: request.cwd }); tip = advance(f, "greeting.txt", "hi\n"); return review(); }
      // The second review sees the moved, settled candidate on the tip.
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(git(request.cwd, "ls-files", "-u"), "");
      assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), "hello\nhi\n");
      return review();
    },
  }, human, assertRepositoryTurn(f));
  assert.equal(result.state, "delivered"); assert.equal(human.requests.length, 0);
  // The states show the move: from rebase back to the implementer, then scope, checks, a fresh review, commit, and a clean rebase.
  assert.deepEqual(result.states.slice(result.states.indexOf("rebase")), ["rebase", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult",
    "commit", "rebase", "deliver", "success", "delivered"]);
  for (const state of ["stuck", "decide", "repairBudget", "reviewBudget"]) assert.equal(result.states.includes(state), false, state);
  // The implementer was told the replay conflicted, in which file, and that the run moved the candidate onto the tip.
  assert.equal(prompts.length, 2); assert.doesNotMatch(prompts[1]!, /git add/u);
  const feedback = prompts[1]!.split("Current failure/feedback: ")[1] ?? "";
  const said = movedAtDelivery.exec(feedback); assert.ok(said, feedback);
  assert.ok(names(said[1]!, tip) && names(said[2]!, tip), "the evidence names the tip the replay tried and the move went onto");
  assert.ok(names(prompts[1]!, started), "the implementer's prompt names the base the candidate was approved on");
  assert.equal(reviews.length, 2); assert.ok(names(reviews[1]!, tip), "the second review is told the candidate was moved onto the tip");
  const commit = onTip(f, tip); const run = held(f, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello\nhi");
  assert.deepEqual(phases(run), ["red", "verify", "verify"]);
  assert.deepEqual([run.result.outcome, run.result.checksPassed, run.result.repairs, run.result.reviewRounds], ["completed", true, 0, 0]);
  assert.deepEqual(run.result.agents.filter((agent: any) => agent.stage === "review").length, 2);
  assert.deepEqual([run.delivery.baseCommit, run.delivery.commit], [tip, commit]); rebasedFrom(f, run, started);
  // The candidate was saved as it was approved, on the base it was approved on, once.
  savedAsItStood(f, run.directory, started, files);
});

test("a second replay conflict in the same run stops with today's text, says the run already moved once, and hand off then leaves the candidate uncommitted, as that choice says", async context => {
  const f = fixture(context); const human = person("hand off");
  let before: Candidate | undefined; let moved = ""; let tip = ""; const prompts: string[] = []; let reviews = 0;
  const result = await execute(input(f), {
    implementer: settles(prompts),
    reviewer: request => {
      before = candidate(request.cwd);
      // Each review sees the base change the greeting again, so each replay conflicts.
      if (++reviews === 1) moved = advance(f, "greeting.txt", "hi\n"); else tip = advance(f, "greeting.txt", "hey\n");
      return review();
    },
  }, human, assertRepositoryTurn(f));
  assert.equal(result.state, "handedOff"); assert.deepEqual(result.states.slice(-5), ["rebase", "stuck", "decide", "handOff", "handedOff"]);
  assert.deepEqual(result.states.filter(state => ["commit", "rebase", "decide", "change", "failure"].includes(state)), ["change", "commit", "rebase", "change", "commit", "rebase", "decide"]);
  assert.equal(reviews, 2); assert.equal(prompts.length, 2); assert.match(prompts[1]!.split("Current failure/feedback: ")[1] ?? "", movedAtDelivery);
  // The question is the one every stop asks, once, with today's text and its decisions unchanged.
  assert.equal(human.requests.length, 1);
  const run = questionedIn("rebase", f, result, replayStop, human); untouched(f);
  assert.ok(names(run.delivery.reason, tip), "the reason names the tip"); assert.ok(names(run.delivery.reason, moved), "the reason names the tip the run moved onto");
  for (const text of [run.delivery.reason, run.prompt]) assert.match(oneLine(text), /already moved its candidate once, after a replay conflict/u);
  assert.match(run.prompt, /Stopped in rebase\./u);
  assert.deepEqual([run.result.outcome, run.delivery.outcome, run.delivery.decision, run.delivery.archive], ["blocked", "handed-off", "hand off", undefined]);
  // The candidate is uncommitted on the tip it was moved onto, and only the one move saved a candidate.
  uncommitted(f, run, moved, before!); assert.equal(savedRefs(f).length, 1);
});

test("a resumed run that moved in prepare and then meets a replay conflict stops, saying it already moved its candidate once, when it resumed", async context => {
  const f = fixture(context); const again = await handOff(f); let before: Candidate | undefined; let tip = ""; const human = person("hand off");
  // The base moves while the ticket waits, touching nothing the candidate touches, so prepare moves it cleanly.
  const moved = advance(again);
  const result = await execute(input(again, {}, { resume: true }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => { before = candidate(request.cwd); tip = advance(f, "greeting.txt", "hi\n"); return review(); },
  }, human);
  assert.deepEqual(result.states, ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase",
    "stuck", "decide", "handOff", "handedOff"]);
  const run = questionedIn("rebase", again, result, replayStop, human); untouched(f);
  assert.ok(names(run.delivery.reason, tip), "the reason names the tip");
  for (const text of [run.delivery.reason, run.prompt]) assert.match(oneLine(text), /already moved its candidate once, when it resumed/u);
  assert.doesNotMatch(run.delivery.reason, /after a replay conflict/u);
  uncommitted(f, run, moved, before!); assert.equal(savedRefs(f).length, 1); assert.equal(human.requests.length, 1);
});

test("a move after a replay conflict whose settling leaves markers spends the repair budget as a resumed run's does, then delivers once they are settled", async context => {
  const f = fixture(context); let tip = ""; let reviews = 0; const prompts: string[] = [];
  const result = await execute(input(f), {
    implementer: request => {
      // The first settling round leaves the markers in place; the next one keeps both greetings.
      if (prompts.length === 1) { prompts.push(request.prompt); return ok("completed", "Could not settle the greeting"); }
      return settles(prompts)(request);
    },
    reviewer: () => { if (++reviews === 1) tip = advance(f, "greeting.txt", "hi\n"); return review(); },
  }, person());
  assert.equal(result.state, "delivered");
  const from = result.states.indexOf("rebase");
  assert.deepEqual(result.states.slice(from).filter(state => ["change", "scopeAfterChange", "repairBudget", "verify", "review", "rebase", "deliver", "stuck"].includes(state)),
    ["rebase", "change", "scopeAfterChange", "repairBudget", "change", "scopeAfterChange", "verify", "review", "rebase", "deliver"]);
  assert.equal(prompts.length, 3); assert.match(prompts[2]!, /Unsettled conflicts: "greeting\.txt"\./u);
  onTip(f, tip); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello\nhi");
  assert.deepEqual([evidence(f).result.repairs, reviews], [1, 2]);
});

test("a move after a replay conflict with no repair budget left for its markers asks the owner from repairBudget, naming the file, as a resumed run does", async context => {
  const f = fixture(context); let tip = ""; let reviews = 0; const prompts: string[] = []; const human = person("hand off");
  const result = await execute(input(f, {}, { maxRepairs: 0 }), {
    implementer: request => prompts.push(request.prompt) === 1 ? implement(request) : ok("completed", "Could not settle the greeting"),
    reviewer: () => { if (++reviews === 1) tip = advance(f, "greeting.txt", "hi\n"); return review(); },
  }, human);
  assert.deepEqual([prompts.length, reviews], [2, 1]);
  const run = questionedIn("repairBudget", f, result, /Unsettled conflicts: "greeting\.txt"\./u, human); untouched(f);
  assert.match(run.prompt.split("\n")[0]!, /^Repair budget used up \(0 of 0\) with 1 unsettled conflict in "?greeting\.txt"?\.$/u);
  assert.match(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), /^<<<<<<< /mu);
  assert.equal(git(f.repo, "rev-parse", branch), tip); assert.equal(savedRefs(f).length, 1);
});

test("a tip that already holds the change leaves nothing to replay: the candidate goes back uncommitted on its original base and the run asks, saying so, as a resumed run does again", async context => {
  const f = fixture(context); const started = f.head; const human = person("hand off", "hand off"); let before: Candidate | undefined; let tip = ""; let refs = "";
  const first = await execute(input(f, {}, { stuck: "park" }), {
    reviewer: request => {
      before = candidate(request.cwd);
      // The same change reaches the base by another road while this one is under review, after a commit of the base's own.
      advance(f); writeFileSync(join(f.repo, "greeting.test.txt"), readFileSync(join(request.cwd, "greeting.test.txt")));
      tip = advance(f, "greeting.txt", "hello\n"); refs = others(f); return review();
    },
  }, human);
  const stopped = (at: Fixture, result: Awaited<ReturnType<typeof execute>>) => {
    const run = questionedIn(at === f ? "rebase" : "prepare", at, result, /already holds/iu, human); untouched(f);
    assert.ok(names(run.delivery.reason, tip), "the reason names the tip");
    // Nothing of the tip stays behind in the worktree: the candidate is the one that was approved, on the base it was approved on.
    uncommitted(f, run, started, before!); assert.equal(existsSync(join(f.worktree, "later.txt")), false); assert.equal(others(f), refs);
  };
  stopped(f, first);
  const again = next(f, 2);
  const second = await execute(input(again, {}, { resume: true, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail() }, human);
  stopped(again, second); assert.deepEqual(phases(evidence(again)), []); assert.equal(savedRefs(f).length, 1); assert.equal(human.requests.length, 2);
});

for (const [label, hook, script] of [
  ["a refusing hook", "pre-rebase", "exit 1"],
  ["a changed subject", "post-rewrite", 'test "$1" = rebase || exit 0\ngit -c core.hooksPath=/dev/null commit --amend -qm changed'],
  ["an extra commit", "post-rewrite", 'test "$1" = rebase || exit 0\ngit -c core.hooksPath=/dev/null commit --allow-empty -qm extra'],
  ["a dirty tracked file", "post-rewrite", 'test "$1" = rebase || exit 0\necho altered > greeting.txt'],
] as const) {
  test(`replay with ${label} conservatively restores the approved candidate, and resumes after the hook is removed`, async context => {
    const f = fixture(context); const started = f.head; let before: Candidate | undefined; let tip = ""; const human = person("hand off");
    const path = join(f.repo, ".git/hooks", hook);
    const result = await execute(input(f, {}, { stuck: "park" }), {
      reviewer: request => {
        before = candidate(request.cwd); tip = advance(f);
        writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
        return review();
      },
    }, human);
    const run = questionedIn("rebase", f, result, /Replay onto/u, human);
    uncommitted(f, run, started, before!); untouched(f);
    assert.ok(names(run.delivery.reason, tip));
    // A replay refused without conflicts stops as before: nothing is moved or sent to the implementer.
    assert.equal(result.states.filter(state => state === "change").length, 1); assert.deepEqual(savedRefs(f), []);
    assert.doesNotMatch(run.delivery.reason, /failed with conflicts|conflicted in|already moved|moved the approved candidate/iu);
    rmSync(path);
    const again = next(f, 2);
    const resumed = await execute(input(again, {}, { resume: true, stuck: "park" }), {
      investigator: () => assert.fail(), implementer: () => assert.fail(),
    });
    assert.equal(resumed.state, "delivered"); accepted(resumed.states); onTip(f, tip);
    assert.deepEqual(phases(evidence(again)), ["verify"]);
  });
}

test("setup that switches branches after replay restores only the ticket branch and counts as failed checks", async context => {
  const f = fixture(context); const started = f.head; let before: Candidate | undefined; const human = person("hand off");
  git(f.repo, "branch", "other", started);
  const setup = [command('if (require("fs").existsSync("later.txt")) require("child_process").execFileSync("git", ["checkout", "-q", "other"], { stdio: "ignore" });', { name: "install" })];
  const result = await execute(input(f, { setup }, { stuck: "park" }), {
    reviewer: request => { before = candidate(request.cwd); advance(f); return review(); },
  }, human);
  const run = questionedIn("rebase", f, result, /setup: install.*moved HEAD/u, human);
  uncommitted(f, run, started, before!); untouched(f);
  assert.equal(run.result.checksPassed, false);
  assert.equal(git(f.repo, "rev-parse", "other"), started);
  const again = next(f, 2);
  const resumed = await execute(input(again, {}, { resume: true, stuck: "park" }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
  });
  assert.equal(resumed.state, "delivered"); accepted(resumed.states); onTip(f, f.head);
});

test("setup leftovers on the new tip fail checks and stop uncommitted without asking the implementer to repair them", async context => {
  const f = fixture(context); let tip = ""; const human = person("hand off");
  const setup = [command('const fs = require("fs"); if (fs.existsSync("later.txt")) fs.writeFileSync("setup-output.txt", "leftover");', { name: "install" })];
  const result = await execute(input(f, { setup }, { stuck: "park" }), {
    reviewer: () => { tip = advance(f); return review(); },
  }, human);
  const run = questionedIn("rebase", f, result, /setup: install.*unignored/u, human);
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
    const stops = second === "blocks" || second === "edits the checkout";
    const f = fixture(context); const started = advance(f, "lines.txt", numbered()); const human = person(...(stops ? ["hand off"] : []));
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
    untouched(f); assert.equal(human.requests.length, stops ? 1 : 0);
    const run = evidence(f); const again = ["commit", "rebase", "verify", "sealReview", "review", "reviewResult"];
    // It is not a stop: the run goes from rebase straight back to verify and a fresh review, and nothing is verified as `reverify`.
    assert.deepEqual(result.states.slice(result.states.indexOf("commit"), result.states.indexOf("commit") + again.length), again);
    assert.deepEqual(run.result.checks.slice(0, 5).map((check: any) => [check.phase, check.name, check.passed]),
      [["setup", "install", true], ["red", "tests", true], ["verify", "tests", true], ["setup", "install", true], ["verify", "tests", true]]);
    assert.match(readFileSync(run.result.checks[3].log, "utf8"), /on the new base/u); assert.equal(phases(run).includes("reverify"), false);
    if (stops) {
      // The fresh review stops the run as any review does, with the candidate uncommitted on the new tip.
      const stop = questionedIn("reviewResult", f, result, second === "blocks" ? /contradicts the ticket/u : /read-only stage/u, human); assert.equal(reviews, 2);
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

/** A run whose first review approves while the base changes a line near the ticket's, so the replayed patch differs and the candidate is reviewed again on the tip. */
function replayedDiffering(f: Fixture, later: (reviews: number) => unknown) {
  const started = advance(f, "lines.txt", numbered()); const moved = { started, tip: "", reviews: 0, prompts: [] as string[] };
  const agents = {
    implementer: (request: Request) => {
      if (moved.prompts.push(request.prompt) === 1) writeFileSync(join(request.cwd, "lines.txt"), numbered({ 5: "five" }));
      writeFileSync(join(request.cwd, "greeting.txt"), moved.prompts.length === 1 ? "hello\n" : "hello again\n"); return ok();
    },
    reviewer: () => {
      if (++moved.reviews === 1) { moved.tip = advance(f, "lines.txt", numbered({ 7: "seven" })); return review(); }
      return later(moved.reviews);
    },
  };
  return { moved, agents, data: scoped(input(f, {}, { stuck: "park" }), "lines.txt") };
}
/** No blocker and nothing new: beside an earlier report of the same patch this is a review that is not converging. */
const stillUnmet = () => review("approved", "The greeting is not established on the new base", {
  criteria: [{ text: "Reviewer paraphrase", met: false, evidence: "greeting.txt:1" }], newSinceLastRound: "none",
});

for (const third of ["approves", "repeats its report"] as const) {
  test(`the review after a replay whose patch differs is a first review of the new patch: an unmet criterion with nothing new gets a repair round, and a next review that ${third} ${third === "approves" ? "delivers on the tip" : "stops as not converging"}`, async context => {
    const f = fixture(context); const human = person(...(third === "repeats its report" ? ["hand off"] : []));
    const { moved, agents, data } = replayedDiffering(f, reviews => reviews === 2 || third === "repeats its report" ? stillUnmet() : review());
    const result = await execute(data, agents, human);
    untouched(f); assert.equal(human.requests.length, third === "repeats its report" ? 1 : 0);
    // The approval before the rebase read another patch: beside it, the re-review's report would be an unchanged one and stop the run.
    const after = result.states.slice(result.states.indexOf("rebase"));
    assert.deepEqual(after.slice(0, 8), ["rebase", "verify", "sealReview", "review", "reviewResult", "reviewBudget", "change", "scopeAfterChange"],
      "the first review of the new patch sends its unmet criterion to the implementer");
    assert.deepEqual([moved.reviews, moved.prompts.length], [3, 2]);
    assert.match(moved.prompts[1]!.split("Current failure/feedback: ")[1] ?? "", new RegExp(`Unmet criterion: ${criterion}`, "u"));
    const run = evidence(f); assert.deepEqual([run.result.repairs, run.result.reviewRounds], [0, 1]);
    if (third === "repeats its report") {
      // The second review of the new patch is compared with the first, as any later review is with the one before it.
      const stop = questionedIn("reviewResult", f, result, /^Review is not converging: newSinceLastRound is none and criteria remain unmet: /u, human);
      assert.equal(stop.delivery.reason, `Review is not converging: newSinceLastRound is none and criteria remain unmet: ${criterion}`);
      assert.deepEqual([git(f.worktree, "rev-parse", "HEAD"), stop.delivery.baseCommit, stop.delivery.commit], [moved.tip, moved.tip, null]);
      assert.deepEqual(result.states.filter(state => ["reviewBudget", "repairBudget", "stuck"].includes(state)), ["reviewBudget", "stuck"]);
      return;
    }
    assert.equal(result.state, "delivered"); assert.equal(result.states.includes("stuck"), false);
    assert.deepEqual(result.states.filter(state => ["change", "commit", "rebase", "reviewBudget", "repairBudget"].includes(state)),
      ["change", "commit", "rebase", "reviewBudget", "change", "commit", "rebase"]);
    const commit = onTip(f, moved.tip); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello again");
    assert.deepEqual([run.delivery.outcome, run.delivery.baseCommit, run.delivery.commit, run.result.checksPassed], ["delivered", moved.tip, commit, true]);
    rebasedFrom(f, run, moved.started);
  });
}

test("a question in the review after a replay whose patch differs gets its one repair round, and goes to the owner when the next review of that patch still asks", async context => {
  const f = fixture(context); const human = person("hand off");
  const { moved, agents, data } = replayedDiffering(f, reviews => review("approved", "A question for the owner", { findings: discussions([reviews === 2 ? asked[0]! : askedAgain[0]!]) }));
  const result = await execute(data, agents, human);
  untouched(f); assert.equal(human.requests.length, 1);
  assert.deepEqual(result.states.slice(result.states.indexOf("rebase")).slice(0, 7), ["rebase", "verify", "sealReview", "review", "reviewResult", "reviewBudget", "change"]);
  const stop = questionedIn("reviewResult", f, result, new RegExp(`${counted(1)}:\\s${literal(questionLines([askedAgain[0]!])[0]!)}`, "u"), human);
  assert.deepEqual([moved.reviews, moved.prompts.length], [3, 2]); assert.deepEqual(numberedLines(stop.needs.split("\n")), questionLines([askedAgain[0]!]));
  assert.equal(git(f.worktree, "rev-parse", "HEAD"), moved.tip);
});

const greetsLater ='const fs = require("fs"); if (fs.existsSync("later.txt") && !fs.readFileSync("greeting.txt", "utf8").includes("later")) { console.log("greeting.txt does not mention later.txt"); process.exit(1); }';
for (const [label, extra] of [
  ["is repaired within the budget", {}],
  ["is asked about on a spent budget, handed off, and a resumed run repairs it", { maxRepairs: 0, stuck: "park" }],
  ["waits on a spent budget, and more rounds repair it", { maxRepairs: 0 }],
] as const) {
  test(`gates that fail on the rebased tree are a gate failure on the new base: the commit is undone there and the failure ${label}`, async context => {
    const f = fixture(context); const started = f.head; const parks = "stuck" in extra; const asks = "maxRepairs" in extra && !parks;
    const human = person(...(asks ? ["more rounds"] : parks ? ["hand off"] : [])); const checks = [command(), command(greetsLater, { name: "later-gate" })];
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
    const failed = [["red", "tests", true], ["verify", "tests", true], ["verify", "later-gate", true], ["reverify", "tests", true], ["reverify", "later-gate", false], ["reverify", "later-gate", false]];
    const evidenced = (run: { result: any }) => run.result.checks.map((check: any) => [check.phase, check.name, check.passed]);
    if (parks) {
      const stop = questionedIn("repairBudget", f, result, /Repair budget exhausted \(0\)\..*later-gate/su, human); untouched(f);
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
    if (parks) { assert.deepEqual(phases(run), ["verify", "verify", "verify", "verify", "verify"]); assert.equal(human.requests.length, 1); return; }
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

/** A run whose first review approves while the base gains later.txt: the replayed patch is the approved one, later-gate fails in `reverify`, and the implementer repairs the candidate on the tip. */
function reverifyRepaired(f: Fixture, later: (reviews: number) => unknown) {
  const moved = { started: f.head, tip: "", reviews: 0, prompts: [] as string[] };
  const agents = {
    implementer: (request: Request) => {
      if (moved.prompts.push(request.prompt) === 1) return implement(request);
      // Every later round keeps what the criterion and the gate on the new base each ask of the file.
      writeFileSync(join(request.cwd, "greeting.txt"), moved.prompts.length === 2 ? "hello later\n" : "hello again later\n"); return ok();
    },
    reviewer: () => {
      if (++moved.reviews === 1) { moved.tip = advance(f); return review(); }
      return later(moved.reviews);
    },
  };
  return { moved, agents, data: input(f, { checks: [command(), command(greetsLater, { name: "later-gate" })] }, { stuck: "park" }) };
}
/** From `rebase` on: the failed gate takes a repair round, and the review of the repaired candidate sends what it found back to the implementer. */
const repairedThenRevised = ["rebase", "repairBudget", "repairTarget", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "reviewBudget", "change"];

for (const third of ["approves", "repeats its report"] as const) {
  test(`the review after a repaired reverify failure is a first review of the new patch: an unmet criterion with nothing new gets a repair round, and a next review that ${third} ${third === "approves" ? "delivers on the tip" : "stops as not converging"}`, async context => {
    const f = fixture(context); const human = person(...(third === "repeats its report" ? ["hand off"] : []));
    const { moved, agents, data } = reverifyRepaired(f, reviews => reviews === 2 || third === "repeats its report" ? stillUnmet() : review());
    const result = await execute(data, agents, human);
    untouched(f); assert.equal(human.requests.length, third === "repeats its report" ? 1 : 0);
    // The approval before the rebase read the patch the repair has since changed: beside it, this report would be an unchanged one and stop the run.
    assert.deepEqual(result.states.slice(result.states.indexOf("rebase")).slice(0, repairedThenRevised.length), repairedThenRevised,
      "the first review of the repaired patch sends its unmet criterion to the implementer");
    assert.deepEqual([moved.reviews, moved.prompts.length], [3, 3]);
    assert.match(moved.prompts[1]!.split("Current failure/feedback: ")[1] ?? "", /later-gate/u);
    assert.match(moved.prompts[2]!.split("Current failure/feedback: ")[1] ?? "", new RegExp(`Unmet criterion: ${criterion}`, "u"));
    // The gate failure used the repair budget and the review its own, one round each.
    const run = evidence(f); assert.deepEqual([run.result.repairs, run.result.reviewRounds], [1, 1]);
    if (third === "repeats its report") {
      // The second review of the new patch is compared with the first, as any later review is with the one before it.
      const stop = questionedIn("reviewResult", f, result, /^Review is not converging: newSinceLastRound is none and criteria remain unmet: /u, human);
      assert.equal(stop.delivery.reason, `Review is not converging: newSinceLastRound is none and criteria remain unmet: ${criterion}`);
      assert.deepEqual([git(f.worktree, "rev-parse", "HEAD"), stop.delivery.baseCommit, stop.delivery.commit], [moved.tip, moved.tip, null]);
      assert.deepEqual(result.states.filter(state => ["reviewBudget", "repairBudget", "stuck"].includes(state)), ["repairBudget", "reviewBudget", "stuck"]);
      return;
    }
    assert.equal(result.state, "delivered"); assert.equal(result.states.includes("stuck"), false);
    assert.deepEqual(result.states.filter(state => ["change", "commit", "rebase", "reviewBudget", "repairBudget"].includes(state)),
      ["change", "commit", "rebase", "repairBudget", "change", "reviewBudget", "change", "commit", "rebase"]);
    const commit = onTip(f, moved.tip); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello again later");
    assert.deepEqual([run.delivery.outcome, run.delivery.baseCommit, run.delivery.commit, run.result.checksPassed], ["delivered", moved.tip, commit, true]);
    assert.equal(git(f.repo, "show", `${rebasedFrom(f, run, moved.started)}:greeting.txt`), "hello");
  });
}

test("a question in the review after a repaired reverify failure gets its one repair round, and goes to the owner when the next review of that patch still asks", async context => {
  const f = fixture(context); const human = person("hand off");
  const { moved, agents, data } = reverifyRepaired(f, reviews => review("approved", "A question for the owner", { findings: discussions([reviews === 2 ? asked[0]! : askedAgain[0]!]) }));
  const result = await execute(data, agents, human);
  untouched(f); assert.equal(human.requests.length, 1);
  // No report from before the rebase can hold a question: only the reviews of the repaired patch count toward asking twice.
  assert.deepEqual(result.states.slice(result.states.indexOf("rebase")).slice(0, repairedThenRevised.length), repairedThenRevised);
  const stop = questionedIn("reviewResult", f, result, new RegExp(`${counted(1)}:\\s${literal(questionLines([askedAgain[0]!])[0]!)}`, "u"), human);
  assert.deepEqual([moved.reviews, moved.prompts.length], [3, 3]); assert.deepEqual(numberedLines(stop.needs.split("\n")), questionLines([askedAgain[0]!]));
  assert.deepEqual([stop.result.repairs, stop.result.reviewRounds], [1, 1]);
  assert.equal(git(f.worktree, "rev-parse", "HEAD"), moved.tip);
});

for (const policy of ["park", "ask"] as const) {
  test(`a setup command that fails on the new tip is not the implementer's to repair: the commit is undone there and the run asks with stuck ${policy}, ${policy === "park" ? "naming the command; handed off, a resumed run delivers on the tip" : "where archive keeps the candidate on the tip"}`, async context => {
    const f = fixture(context); const human = person(policy === "ask" ? "archive" : "hand off"); const calls = recordGit(context, f);
    let tip = ""; let before: Candidate | undefined; let edits = 0;
    const setup = [command('process.exit(require("fs").existsSync("later.txt") ? 3 : 0)', { name: "install" })];
    const result = await execute(input(f, { setup }, { stuck: policy }), {
      implementer: request => { edits++; return implement(request); },
      reviewer: request => { before = candidate(request.cwd); tip = advance(f); return review(); },
    }, human);
    assert.equal(edits, 1); assert.equal(result.states.includes("repairBudget"), false); assert.ok(undone(calls(), tip), "git reset --mixed <tip>");
    // Either policy takes the stop to the one question.
    assert.deepEqual(result.states.slice(result.states.indexOf("rebase"), result.states.indexOf("rebase") + 3), ["rebase", "stuck", "decide"]);
    if (policy === "ask") {
      assert.deepEqual(result.states.slice(result.states.indexOf("rebase")), ["rebase", "stuck", "decide", "archive", "remove", "abandon", "abandoned"]);
      assert.match(human.requests[0]!.prompt, /Stopped in rebase\./u); assert.match(human.requests[0]!.prompt, /\binstall\b/u);
      const run = abandoned(f, result, "archive");
      // The archive is the candidate as delivery would have committed it, on the tip it was left on.
      assert.equal(git(f.repo, "rev-parse", `${archiveBranch}^`), tip); assert.equal(git(f.repo, "show", "--name-only", "--format=", archiveBranch), "greeting.test.txt\ngreeting.txt");
      assert.deepEqual([run.delivery.archive, run.delivery.baseCommit, run.result.checksPassed], [{ branch: archiveBranch, commit: git(f.repo, "rev-parse", archiveBranch) }, tip, false]);
      return;
    }
    const run = questionedIn("rebase", f, result, /\binstall\b/u, human); untouched(f);
    // A failed setup on the tip is a failed check: nothing passed on that tree.
    assert.equal(run.result.checksPassed, false);
    assert.deepEqual(run.result.checks.map((check: any) => [check.phase, check.name, check.passed]), [["setup", "install", true], ["red", "tests", true], ["verify", "tests", true], ["setup", "install", false]]);
    uncommitted(f, run, tip, before!, ["later.txt"]); assert.equal(human.requests.length, 1);
    // A resumed run does not set up again; it verifies and reviews the candidate on the tip and delivers there.
    const again = next(f, 2);
    const second = await execute(input(again, { setup }, { resume: true, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail() }, human);
    assert.equal(second.state, "delivered"); accepted(second.states); const commit = onTip(f, tip);
    assert.deepEqual([phases(evidence(again)), evidence(again).delivery.baseCommit, evidence(again).delivery.commit, evidence(again).result.checksPassed], [["verify"], tip, commit, true]);
  });
}

/** The base gains ignore rules in a commit of its own; without others, one that matches a file the candidate adds. */
const ignoring = (f: Fixture, rules = "greeting.txt\n") => advance(f, ".gitignore", rules);
for (const trigger of ["a replayed patch that differs", "a gate that fails in reverify", "a setup command that fails on the tip"] as const) {
  test(`${trigger} is not undone onto a tip whose .gitignore matches a file the approved commit added: the candidate goes back whole and uncommitted on its original base, and the run asks, naming the file and the rule's file, as a resumed run does again`, async context => {
    const f = fixture(context); const differs = trigger === "a replayed patch that differs"; const human = person("hand off", "hand off");
    const started = differs ? advance(f, "lines.txt", numbered()) : f.head;
    const repository = trigger === "a gate that fails in reverify" ? { checks: [command(), command(greetsLater, { name: "later-gate" })] }
      : trigger === "a setup command that fails on the tip" ? { setup: [command('process.exit(require("fs").existsSync("later.txt") ? 3 : 0)', { name: "install" })] } : {};
    const data = (at: Fixture, extra = {}) => { const made = input(at, repository, { stuck: "park", ...extra }); return differs ? scoped(made, "lines.txt") : made; };
    let tip = ""; let reviews = 0; let edits = 0; let refs = ""; let before: Candidate | undefined; let whole: Candidate | undefined;
    const agents = {
      implementer: (request: Request) => { edits++; if (differs) writeFileSync(join(request.cwd, "lines.txt"), numbered({ 5: "five" })); return implement(request); },
      reviewer: (request: Request) => {
        if (++reviews > 1 && git(request.cwd, "rev-parse", "HEAD") !== started) return review();
        // What was approved, with nothing of it ignored: the base it stands on has no ignore rules yet.
        before = candidate(request.cwd); whole = candidate(request.cwd, true); assert.deepEqual(whole, before);
        if (reviews > 1) return review();
        // Under review the base gains a rule that ignores greeting.txt, then the commit that makes this replay one to undo.
        ignoring(f); tip = differs ? advance(f, "lines.txt", numbered({ 7: "seven" })) : advance(f); refs = others(f);
        return review();
      },
    };
    const stopped = (at: Fixture, result: Awaited<ReturnType<typeof execute>>) => {
      // Undone onto the tip, greeting.txt would be ignored there and the next commit would deliver without it.
      const stage = at === f ? "rebase" : "prepare";
      assert.deepEqual(result.states.slice(result.states.indexOf(stage)), [stage, "stuck", "decide", "handOff", "handedOff"], "the replay is not undone onto the tip to go on from there");
      const run = questionedIn(stage, at, result, /greeting\.txt/u, human); untouched(f);
      assert.match(run.delivery.reason, /\.gitignore/u, "the reason names the file that holds the rule"); assert.ok(names(run.delivery.reason, tip), "the reason names the new tip");
      assert.doesNotMatch(run.delivery.reason, /greeting\.test\.txt/u, "a file no rule matches is not named as one that would be dropped");
      // What a person is asked for is cut at 600 characters; the file and the rule's file are within it.
      assert.match(run.needs, /greeting\.txt/u); assert.match(run.needs, /\.gitignore/u);
      assert.equal(result.states.includes("repairBudget"), false); assert.equal(result.states.includes("failure"), false);
      // The approved candidate is whole on the base it was approved on: every file is there, none is ignored, and nothing of the tip stays behind.
      uncommitted(f, run, started, before!); assert.deepEqual(candidate(f.worktree, true), whole);
      assert.doesNotMatch(candidate(f.worktree, true).status, /^!!/mu); assert.match(candidate(f.worktree).status, /^\?\? greeting\.txt$/mu);
      assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
      for (const brought of [".gitignore", "later.txt"]) assert.equal(existsSync(join(f.worktree, brought)), false, brought);
      assert.equal(others(f), refs);
      return run;
    };
    const first = await execute(data(f), agents, human);
    stopped(f, first); assert.deepEqual([edits, reviews], [1, 1]);
    // Resume checks the tip rules before setup or review and restores the same candidate.
    const again = next(f, 2);
    const second = await execute(data(again, { resume: true }), { ...agents, investigator: () => assert.fail() }, human);
    stopped(again, second); assert.deepEqual(phases(evidence(again)), []); assert.equal(savedRefs(f).length, 1); assert.deepEqual([edits, reviews], [1, 1]); assert.equal(human.requests.length, 2);
  });
}

/** Setup writes kept/out.txt on every tree and cache/out.txt only where the tip's later.txt is, and says in its log which it did. */
const writesOutputs = 'const fs = require("fs"); const write = dir => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + "/out.txt", "built\\n"); }; '
  + 'write("kept"); const tip = fs.existsSync("later.txt"); if (tip) write("cache"); console.log(tip ? "wrote cache on the tip" : "wrote kept only");';
/**
 * A run that meets an ignore stop with setup outputs in the worktree. The base ignores kept/ from the start, so prepare stays clean. Under
 * review it gains rules for greeting.txt and cache/, then later.txt: setup stays clean on the tip, later-gate fails there in `reverify`,
 * and the commit cannot be undone onto a tip that would drop greeting.txt.
 */
function ignoredOutputs(f: Fixture, outputs = writesOutputs) {
  const seen = { started: ignoring(f, "kept/\n"), tip: "", reviews: 0, edits: 0, before: undefined as Candidate | undefined };
  const repository = { setup: [command(outputs, { name: "install" })], checks: [command(), command(greetsLater, { name: "later-gate" })] };
  const agents = {
    implementer: (request: Request) => {
      if (++seen.edits > 1) return ok();
      // Run evidence nested in the worktree is no setup output either.
      mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/nested.json"), "{}"); return implement(request);
    },
    reviewer: (request: Request) => {
      // A resumed run does not set up again: what setup wrote under the base's own rules must still be there for it.
      assert.equal(readFileSync(join(request.cwd, "kept/out.txt"), "utf8"), "built\n");
      if (++seen.reviews === 1) { seen.before = candidate(request.cwd); ignoring(f, "kept/\ngreeting.txt\ncache/\n"); seen.tip = advance(f); }
      return review();
    },
  };
  /** The candidate is the approved one and nothing else: of what setup wrote, only the file the original base ignores is left. */
  const restored = (run: { delivery: any }) => {
    assert.equal(existsSync(join(f.worktree, "cache/out.txt")), false, "a setup output only the tip's rules ignore was left beside the restored candidate");
    uncommitted(f, run, seen.started, seen.before!);
    assert.equal(candidate(f.worktree, true).status, "?? greeting.test.txt\n?? greeting.txt\n!! kept/out.txt");
    assert.equal(readFileSync(join(f.worktree, "kept/out.txt"), "utf8"), "built\n"); assert.ok(existsSync(join(f.worktree, ".machine-runs/nested.json")));
    assert.equal(readFileSync(join(f.worktree, ".gitignore"), "utf8"), "kept/\n"); assert.equal(existsSync(join(f.worktree, "later.txt")), false);
  };
  return { seen, agents, restored, data: (at: Fixture, extra = {}) => input(at, repository, { stuck: "park", ...extra }) };
}

test("an ignore stop leaves no setup output that only the tip's rules ignore beside the restored candidate: a directory setup wrote into on the tip is gone, and what the original base ignores stays", async context => {
  const f = fixture(context); const human = person("hand off");
  const { seen, agents, restored, data } = ignoredOutputs(f);
  const result = await execute(data(f), agents, human);
  assert.deepEqual(result.states.slice(result.states.indexOf("rebase")), ["rebase", "stuck", "decide", "handOff", "handedOff"]);
  const run = questionedIn("rebase", f, result, /greeting\.txt/u, human); untouched(f); assert.equal(human.requests.length, 1);
  assert.match(run.delivery.reason, /\.gitignore/u); assert.ok(names(run.delivery.reason, seen.tip), "the reason names the new tip");
  // Setup did write into cache/ on the tip, where the rule kept the tree clean; the gate then failed there.
  assert.deepEqual(run.result.checks.map((check: any) => [check.phase, check.name, check.passed]), [["setup", "install", true], ["red", "tests", true],
    ["verify", "tests", true], ["verify", "later-gate", true], ["setup", "install", true], ["reverify", "tests", true], ["reverify", "later-gate", false], ["reverify", "later-gate", false]]);
  assert.match(readFileSync(run.result.checks[0].log, "utf8"), /wrote kept only/u); assert.match(readFileSync(run.result.checks[4].log, "utf8"), /wrote cache on the tip/u);
  restored(run); assert.deepEqual([seen.edits, seen.reviews], [1, 1]);
});

test("a run resumed after an ignore stop asks in prepare before setup, checks, or review, keeping its saved candidate", async context => {
  const f = fixture(context); const human = person("hand off", "hand off");
  const { seen, agents, restored, data } = ignoredOutputs(f);
  questionedIn("rebase", f, await execute(data(f), agents, human), /greeting\.txt/u, human);
  const again = next(f, 2);
  const second = await execute(data(again, { resume: true }), { ...agents, investigator: () => assert.fail() }, human);
  const run = questionedIn("prepare", again, second, /greeting\.txt/u, human); untouched(f);
  assert.match(run.delivery.reason, /\.gitignore/u); assert.equal(existsSync(join(run.directory, "scope-1.json")), false);
  assert.deepEqual([seen.edits, seen.reviews, run.result.repairs, run.result.reviewRounds], [1, 1, 0, 0]);
  assert.deepEqual(phases(run), []); assert.equal(savedRefs(f).length, 1);
  assert.ok(run.prompt.includes(savedRefs(f)[0]!)); restored(run);
});

test("an ignore rule on the new tip does not stop a replay that is never undone: an equal patch with passing gates delivers the file the rule matches", async context => {
  const f = fixture(context); const started = f.head; let tip = "";
  const result = await execute(input(f, {}, { stuck: "park" }), { reviewer: () => { ignoring(f); tip = advance(f); return review(); } });
  assert.equal(result.state, "delivered"); assert.deepEqual(result.states.slice(-5), ["commit", "rebase", "deliver", "success", "delivered"]); untouched(f);
  const commit = onTip(f, tip); const run = evidence(f);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt"); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello");
  assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", branch), ".gitignore\ncode.txt\ngreeting.test.txt\ngreeting.txt\nlater.txt");
  assert.deepEqual([phases(run), run.delivery.baseCommit, run.delivery.commit, run.result.checksPassed], [["red", "verify", "reverify"], tip, commit, true]);
  rebasedFrom(f, run, started);
});

test("rules on the new tip that would drop nothing do not stop the undo there: added files a later rule re-includes and a tracked file the commit only modifies are reviewed again and delivered", async context => {
  const f = fixture(context); const started = advance(f, "lines.txt", numbered()); const human = person(); let tip = ""; let reviews = 0; let edits = 0;
  const result = await execute(scoped(input(f, {}, { stuck: "park" }), "lines.txt"), {
    implementer: request => { edits++; writeFileSync(join(request.cwd, "lines.txt"), numbered({ 5: "five" })); return implement(request); },
    reviewer: request => {
      if (++reviews === 1) { ignoring(f, "greeting.*\n!greeting.txt\n!greeting.test.txt\nlines.txt\n"); tip = advance(f, "lines.txt", numbered({ 7: "seven" })); return review(); }
      // Undone on the tip, the candidate still shows every path of the approved commit: none is ignored there.
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip);
      assert.equal(candidate(request.cwd).status, "M lines.txt\n?? greeting.test.txt\n?? greeting.txt"); assert.deepEqual(candidate(request.cwd, true), candidate(request.cwd));
      return review();
    },
  }, human);
  assert.equal(result.state, "delivered"); assert.equal(result.states.includes("stuck"), false); untouched(f); assert.deepEqual(human.requests, []);
  assert.deepEqual(result.states.filter(state => ["change", "commit", "rebase", "review", "reviewBudget", "repairBudget"].includes(state)), ["change", "review", "commit", "rebase", "review", "commit", "rebase"]);
  const commit = onTip(f, tip); const run = evidence(f);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt\nlines.txt");
  assert.equal(git(f.repo, "show", `${branch}:lines.txt`), numbered({ 5: "five", 7: "seven" }).trim()); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello");
  assert.deepEqual([reviews, edits, run.delivery.baseCommit, run.delivery.commit, run.result.checksPassed], [2, 1, tip, commit, true]);
  rebasedFrom(f, run, started);
});

test("a pr run whose base moved to a tip that is not published puts the candidate back on its original base and asks, saying the base must be pushed first, asking the remote that prepare recorded", async context => {
  const path = process.env.PATH; const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const calls = recordGit(context, f);
  context.after(() => { process.env.PATH = path; });
  // A second repository that does hold the later commit: a check that read the remote's configuration again would ask it and go on.
  const other = join(f.root, "other.git"); git(f.root, "init", "-q", "--bare", "-b", "main", other); git(f.repo, "push", "-q", other, "main");
  const elsewhere = "https://example.invalid/acme/elsewhere.git"; git(f.repo, "config", `url.${other}.insteadOf`, elsewhere);
  const started = f.head; const human = person("hand off"); let before: Candidate | undefined; let tip = ""; let refs = "";
  const first = await execute(input(f, { output: "pr" }, { stuck: "park" }), {
    implementer: request => { git(request.cwd, "remote", "set-url", "origin", elsewhere); return implement(request); },
    reviewer: request => { before = candidate(request.cwd); tip = advance(f); git(f.repo, "push", "-q", other, "main"); refs = others(f); return review(); },
  }, human);
  const run = questionedIn("rebase", f, first, /pushed first/iu, human); untouched(f);
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
  merged(again, second); accepted(second.states); const commit = onTip(f, tip, evidence(again).delivery.commit);
  assert.deepEqual([phases(evidence(again)), evidence(again).delivery.baseCommit], [["verify"], tip]); assert.equal(evidence(again).delivery.rebasedFrom, undefined);
  assert.equal(pushed.atCheck(), `refs/heads/main ${tip}\nrefs/heads/${branch} ${commit}`); assert.equal(pushed(), `refs/heads/main ${tip}`);
  assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "main", "--head", branch]);
  assert.equal(human.requests.length, 1);
});

test("the tip is looked for on the pull request base prepare recorded, the remote's default branch, whatever the local branch is called", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const bare = join(f.root, "remote.git");
  git(f.repo, "push", "-q", "origin", "main:trunk"); git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk"); const started = f.head; let tip = "";
  const result = await execute(input(f, { output: "pr" }, { stuck: "park" }), {
    // The later commit is published on trunk, the pull request base, and not on the remote branch that shares the local one's name.
    reviewer: () => { tip = advance(f); git(f.repo, "push", "-q", "origin", "main:trunk"); return review(); },
  });
  merged(f, result); untouched(f); const commit = onTip(f, tip, evidence(f).delivery.commit); rebasedFrom(f, evidence(f), started);
  assert.equal(pushed.atCheck(), `refs/heads/${branch} ${commit}\nrefs/heads/trunk ${tip}`); assert.equal(pushed(), `refs/heads/trunk ${tip}`); assert.equal(git(bare, "rev-parse", "main"), started);
  assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "trunk", "--head", branch]);
});

for (const output of ["branch", "pr"] as const) {
  test(`a resumed run whose branch is behind a base that moved forward moves onto the later commit before checks and approval, then delivers a ${output === "pr" ? "pull request" : "branch"}`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const again = await handOff(f);
    // Someone commits to the base branch while the ticket is stuck. A pull request needs that commit on the remote, so it is published first.
    advance(f); if (output === "pr") git(f.repo, "push", "-q", "origin", "main");
    const result = await execute(input(again, { output }, { resume: true }), {
      investigator: () => assert.fail(), implementer: () => assert.fail(),
      reviewer: request => { assert.deepEqual(readdirSync(request.cwd).sort(), [".git", "code.txt", "greeting.test.txt", "greeting.txt", "later.txt"]); return review("approved", "Greeting matches the ticket"); },
    });
    assert.deepEqual(result.states, ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success",
      ...(output === "pr" ? ["checkMerge", "cleanUp", "merged"] : ["delivered"])]);
    const ref = deliveredRef(again, output); const commit = onTip(f, f.head, ref);
    const run = ended(again, result, output, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", ref), "greeting.test.txt\ngreeting.txt");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", ref), "code.txt\ngreeting.test.txt\ngreeting.txt\nlater.txt");
    assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.delivery.resumed, run.delivery.worktreeRemoved], [f.head, commit, true, true]);
    // The move happened before approval, so delivery did not replay.
    assert.equal(run.delivery.rebasedFrom, undefined);
    assert.deepEqual([run.result.outcome, run.result.checksPassed, phases(run)], ["completed", true, ["verify"]]);
    if (output !== "pr") { assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.deepEqual(gh.views(), []); return; }
    assert.equal(pushed.atCheck(), `refs/heads/main ${f.head}\nrefs/heads/${branch} ${commit}`); assert.equal(pushed(), `refs/heads/main ${f.head}`);
    assert.deepEqual(gh()!.slice(4, 9), ["--draft", "--base", "main", "--head", branch]);
  });
}

test("a resumed pr run whose branch is behind a later base commit that is not published asks with the candidate uncommitted on the older commit, and pushes nothing", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const again = await handOff(f); const human = person("hand off");
  // The commit the candidate was made from is on the remote, so prepare goes on; the later one is local only.
  const older = f.head; const tip = advance(f); const before = candidate(f.worktree);
  const result = await execute(input(again, { output: "pr" }, { resume: true, stuck: "park" }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questionedIn("prepare", again, result, /pushed first/iu, human); untouched(f);
  uncommitted(f, run, older, before!); assert.deepEqual([run.delivery.resumed, phases(run)], [true, []]);
  assert.deepEqual(savedRefs(f), []); assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(git(f.repo, "rev-parse", "main"), tip); assert.equal(human.requests.length, 1);
});

/** The copies a resumed run keeps of a candidate before it moves it: refs outside refs/heads/ticket/ and archive/. */
const savedRefs = (f: Fixture) => git(f.repo, "for-each-ref", "--format=%(refname)", "refs/machine-shop/").split("\n").filter(Boolean);
/** The handed-off candidate as it stood on the base it was made on: its files and their contents. */
const stood = (f: Fixture) => Object.fromEntries(["greeting.txt", "greeting.test.txt"].map(name => [name, readFileSync(join(f.worktree, name), "utf8")]));
/** The saved copy holds the candidate as it stood, as one commit on the old base and as a patch in the run's evidence; returns the ref. */
function savedAsItStood(f: Fixture, directory: string, started: string, files: Record<string, string>) {
  const refs = savedRefs(f); assert.equal(refs.length, 1, `one saved candidate: ${refs.join(", ")}`);
  const [ref] = refs as [string];
  for (const prefix of ["refs/heads/ticket/", "refs/heads/archive/"]) assert.equal(ref.startsWith(prefix), false, ref);
  assert.equal(git(f.repo, "rev-parse", `${ref}^`), started, "the saved candidate stands on the base it was made on");
  assert.equal(git(f.repo, "diff", "--name-only", started, ref), Object.keys(files).sort().join("\n"));
  for (const [name, content] of Object.entries(files)) assert.equal(git(f.repo, "show", `${ref}:${name}`), content.trim(), name);
  const patch = join(directory, "saved-candidate.patch");
  assert.ok(existsSync(patch), "the candidate is saved as a patch in the evidence");
  const text = readFileSync(patch, "utf8");
  for (const name of Object.keys(files)) assert.ok(text.includes(name), name);
  assert.match(text, /^\+hello$/mu);
  return ref;
}

test("a resumed candidate whose base moved with no overlap is moved onto the current tip, set up there, reviewed there, and delivered without asking its owner", async context => {
  const f = fixture(context); const again = await handOff(f); const started = f.head; const files = stood(f);
  // Someone commits to the base branch while the ticket waits, touching nothing the candidate touches.
  const tip = advance(again); const calls = recordGit(context, f);
  const where = 'const fs = require("fs"); console.log(`later.txt ${fs.existsSync("later.txt")}, greeting.txt ${fs.existsSync("greeting.txt")}`)';
  let prompt = "";
  const result = await execute(input(again, { setup: [command(where, { name: "install" })] }, { resume: true }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => {
      prompt = request.prompt;
      // The candidate is reviewed on the current tip, applied and still uncommitted.
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(git(f.repo, "rev-parse", branch), tip);
      assert.equal(readFileSync(join(request.cwd, "later.txt"), "utf8"), "later\n");
      assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), files["greeting.txt"]);
      assert.equal(candidate(request.cwd).status, "?? greeting.test.txt\n?? greeting.txt");
      return review();
    },
  }, person());
  assert.equal(result.state, "delivered");
  assert.deepEqual(result.states, ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  const commit = onTip(f, tip); const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(again);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt"); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello");
  // The move happened before the checks: setup ran again on the tip, and delivery found nothing left to replay.
  assert.deepEqual(phases(run), ["setup", "verify"]); assert.match(readFileSync(run.result.checks[0].log, "utf8"), /later\.txt true/u);
  assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.delivery.rebasedFrom, run.delivery.resumed], [tip, commit, undefined, true]);
  assert.equal(calls().some(call => /(?:^|\s)rebase\s(?:.*\s)?--onto(?:\s|$)/u.test(call)), false, "delivery did not replay");
  // The reviewer is told the candidate was moved onto a new base.
  assert.ok(names(prompt, tip), "the review prompt names the new base"); assert.ok(names(prompt, started), "the review prompt names the old base");
  savedAsItStood(f, run.directory, started, files);
  // The candidate was saved before anything moved.
  const save = calls().findIndex(call => /^update-ref\s+refs\/machine-shop\//u.test(call));
  const move = calls().findIndex(call => /^reset\s(?:.*\s)?--hard\s/u.test(call) && call.includes(tip));
  assert.ok(save >= 0 && move > save, "the candidate is saved before the worktree is moved");
});

test("a resumed candidate that conflicts with the new tip goes to the implementer with the conflicted files named, and after it settles them the scope check, checks, and review run before delivery", async context => {
  const f = fixture(context); const again = await handOff(f); const started = f.head; const files = stood(f);
  // The base gains a greeting of its own while the ticket waits.
  const tip = advance(again, "greeting.txt", "hi\n"); const prompts: string[] = []; let reviewed = "";
  const settled = "hello\nhi\n";
  const result = await execute(input(again, {}, { resume: true }), {
    investigator: () => assert.fail(),
    implementer: request => {
      prompts.push(request.prompt);
      // The conflict is in the worktree, on the current tip, with nothing committed.
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(git(f.repo, "rev-parse", branch), tip);
      assert.match(git(request.cwd, "ls-files", "-u"), /\tgreeting\.txt$/mu);
      assert.match(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), /^<<<<<<< /mu);
      writeFileSync(join(request.cwd, "greeting.txt"), settled); git(request.cwd, "add", "greeting.txt");
      return ok("completed", "Kept both greetings");
    },
    reviewer: request => {
      reviewed = request.prompt;
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(git(f.repo, "rev-parse", branch), tip);
      assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), settled); assert.equal(git(request.cwd, "ls-files", "-u"), "");
      return review();
    },
  }, person());
  assert.equal(result.state, "delivered");
  assert.deepEqual(result.states, ["shape", "prepare", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  // The implementer was asked once, with the conflicted file, the new base, and the saved candidate named.
  assert.equal(prompts.length, 1); const ref = savedAsItStood(f, evidence(again).directory, started, files);
  for (const part of ["greeting.txt", ref]) assert.ok(prompts[0]!.includes(part), part);
  // The run stages what is settled, so the prompt asks only for what the Agent can do.
  assert.doesNotMatch(prompts[0]!, /git add/u);
  assert.ok(names(prompts[0]!, tip), "the implementer's prompt names the new base");
  assert.ok(names(reviewed, tip), "the review prompt says the candidate was moved onto the new base");
  const commit = onTip(f, tip); const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(again);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), settled.trim());
  assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.delivery.rebasedFrom, phases(run)], [tip, commit, undefined, ["verify"]]);
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-1.json"), "utf8")), { stage: "change", changed: ["greeting.test.txt", "greeting.txt"], outside: [] });
});

test("a resumed conflict the implementer settles without staging, as a sandbox that cannot write the Git index must, is staged by the run and passes in one round", async context => {
  const f = fixture(context); const again = await handOff(f);
  const tip = advance(again, "greeting.txt", "hi\n"); const prompts: string[] = []; const settled = "hello\nhi\n";
  const result = await execute(input(again, {}, { resume: true }), {
    investigator: () => assert.fail(),
    implementer: request => {
      prompts.push(request.prompt);
      // The settled file is written, but never staged: the sandbox cannot write the index.
      writeFileSync(join(request.cwd, "greeting.txt"), settled);
      return ok("completed", "Kept both greetings; git add failed because the Git index is read-only");
    },
    reviewer: request => {
      assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), settled); assert.equal(git(request.cwd, "ls-files", "-u"), "");
      return review();
    },
  }, person());
  assert.equal(result.state, "delivered");
  assert.deepEqual(result.states, ["shape", "prepare", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  assert.equal(result.states.includes("repairBudget"), false);
  assert.equal(prompts.length, 1); assert.match(prompts[0]!, /greeting\.txt/u); assert.doesNotMatch(prompts[0]!, /git add/u);
  onTip(f, tip); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), settled.trim());
  assert.equal(evidence(again).result.repairs, 0);
});

test("a resumed conflict that still has a marker stays unsettled and is the only file the question names, while the settled one beside it is staged by the run", async context => {
  const f = fixture(context); const again = await handOff(f);
  // The candidate also edits code.txt, and the base edits both files while the ticket waits.
  writeFileSync(join(f.worktree, "code.txt"), "candidate\n");
  advance(again, "greeting.txt", "hi\n"); const tip = advance(again, "code.txt", "base\n"); const human = person("hand off"); const prompts: string[] = [];
  const result = await execute(scoped(input(again, {}, { resume: true, maxRepairs: 0 }), "code.txt"), {
    investigator: () => assert.fail(), reviewer: () => assert.fail(),
    implementer: request => {
      assert.match(git(request.cwd, "ls-files", "-u"), /\tcode\.txt$/mu); assert.match(git(request.cwd, "ls-files", "-u"), /\tgreeting\.txt$/mu);
      prompts.push(request.prompt);
      // code.txt is settled; greeting.txt keeps its markers. Neither is staged.
      writeFileSync(join(request.cwd, "code.txt"), "candidate\nbase\n");
      return ok("completed", "Settled code.txt only");
    },
  }, human);
  assert.equal(prompts.length, 1); assert.doesNotMatch(prompts[0]!, /git add/u);
  const run = questionedIn("repairBudget", again, result, /Unsettled conflicts: "greeting\.txt"\./u, human);
  assert.doesNotMatch(run.delivery.reason, /Unsettled conflicts:[^.]*code\.txt/u);
  assert.doesNotMatch(run.delivery.reason, /git add/u);
  // Only the settled conflict was staged, and nothing was committed.
  const left = git(f.worktree, "ls-files", "-u");
  assert.doesNotMatch(left, /\tcode\.txt$/mu); assert.match(left, /\tgreeting\.txt$/mu);
  assert.equal(git(f.worktree, "show", ":code.txt"), "candidate\nbase");
  assert.match(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), /^<<<<<<< /mu);
  assert.equal(git(f.repo, "rev-parse", branch), tip);
});

test("staging a settled conflict with a glob-like filename does not stage a matching non-conflict file", async context => {
  const f = fixture(context); advance(f, "notes-other.txt", "original\n"); const again = await handOff(f);
  writeFileSync(join(f.worktree, "notes*.txt"), "candidate\n");
  advance(again, "notes*.txt", "base\n"); const tip = advance(again, "greeting.txt", "hi\n"); const human = person("hand off");
  const result = await execute(scoped(input(again, {}, { resume: true, maxRepairs: 0 }), "notes*.txt"), {
    investigator: () => assert.fail(), reviewer: () => assert.fail(),
    implementer: request => {
      writeFileSync(join(request.cwd, "notes*.txt"), "candidate\nbase\n");
      writeFileSync(join(request.cwd, "notes-other.txt"), "unrelated edit\n");
      return ok();
    },
  }, human);
  questionedIn("repairBudget", again, result, /Unsettled conflicts: "greeting\.txt"\./u, human);
  assert.equal(git(f.worktree, "show", ":notes*.txt"), "candidate\nbase");
  assert.equal(git(f.worktree, "show", ":notes-other.txt"), "original");
  assert.equal(readFileSync(join(f.worktree, "notes-other.txt"), "utf8"), "unrelated edit\n");
  assert.match(git(f.worktree, "ls-files", "-u"), /\tgreeting\.txt$/mu);
  assert.equal(git(f.repo, "rev-parse", branch), tip);
});

for (const action of ["leaves", "deletes"] as const) {
  test(`a resumed modify/delete conflict on a file the candidate deleted and the base changed is settled in one round when the implementer ${action} it`, async context => {
    const f = fixture(context); const again = await handOff(f);
    // The candidate deletes code.txt; the base changes it. Git leaves the base's version, with no markers.
    rmSync(join(f.worktree, "code.txt")); const tip = advance(again, "code.txt", "newer\n"); const prompts: string[] = [];
    const result = await execute(scoped(input(again, {}, { resume: true }), "code.txt"), {
      investigator: () => assert.fail(),
      implementer: request => {
        // A second round would itself be the failure; the count is checked below.
        if (prompts.push(request.prompt) > 1) return ok();
        assert.match(git(request.cwd, "ls-files", "-u"), /\tcode\.txt$/mu);
        assert.equal(readFileSync(join(request.cwd, "code.txt"), "utf8"), "newer\n");
        if (action === "deletes") rmSync(join(request.cwd, "code.txt"));
        return ok();
      },
      reviewer: request => { assert.equal(git(request.cwd, "ls-files", "-u"), ""); return review(); },
    }, person());
    assert.equal(result.state, "delivered");
    assert.deepEqual(result.states.slice(0, 5), ["shape", "prepare", "change", "scopeAfterChange", "verify"]);
    assert.equal(result.states.includes("repairBudget"), false);
    // The prompt says what Git left for a conflict with no markers, so leaving it alone is a choice.
    assert.equal(prompts.length, 1); assert.doesNotMatch(prompts[0]!, /git add/u);
    assert.match(prompts[0]!, /"code\.txt"[^\n]*the current base's version/u);
    onTip(f, tip);
    if (action === "leaves") {
      assert.equal(git(f.repo, "show", `${branch}:code.txt`), "newer");
      assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
    } else {
      assert.match(git(f.repo, "show", "--name-status", "--format=", branch), /^D\tcode\.txt$/mu);
      assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", branch).split("\n").includes("code.txt"), false);
    }
  });
}

test("a resumed candidate whose conflicts the implementer cannot settle within the repair budget asks the owner, naming the files and the saved candidate, which holds the work as it stood", async context => {
  const f = fixture(context); const again = await handOff(f); const started = f.head; const files = stood(f);
  const tip = advance(again, "greeting.txt", "hi\n"); const human = person("hand off"); const prompts: string[] = [];
  const result = await execute(input(again, {}, { resume: true, maxRepairs: 1 }), {
    investigator: () => assert.fail(), reviewer: () => assert.fail(),
    // Each round leaves the conflict markers in place.
    implementer: request => { prompts.push(request.prompt); return ok("completed", "Could not settle the greeting"); },
  }, human);
  assert.deepEqual(result.states.filter(state => ["change", "scopeAfterChange", "repairBudget", "verify", "review", "stuck"].includes(state)),
    ["change", "scopeAfterChange", "repairBudget", "change", "scopeAfterChange", "repairBudget", "stuck"]);
  assert.equal(prompts.length, 2); for (const prompt of prompts) assert.match(prompt, /greeting\.txt/u);
  const run = questionedIn("repairBudget", again, result, /greeting\.txt/u, human); untouched(again); assert.equal(human.requests.length, 1);
  const ref = savedAsItStood(f, run.directory, started, files);
  // What the owner is asked names the conflicted file and where the saved candidate is.
  assert.match(run.needs, /greeting\.txt/u); assert.ok(run.prompt.includes(ref), "the question names the saved candidate");
  // The spent budget and the conflict it left are the first sentence.
  assert.match(run.prompt.split("\n")[0]!, /^Repair budget used up \(1 of 1\) with 1 unsettled conflict in "?greeting\.txt"?\.$/u);
  assert.equal(git(f.repo, "show", `${ref}:greeting.txt`), "hello");
  // Nothing was committed: the branch is on the tip with the unsettled candidate in the worktree.
  assert.equal(git(f.repo, "rev-parse", branch), tip); assert.equal(git(f.repo, "rev-list", "--count", `${tip}..${branch}`), "0");
});

test("a resumed candidate whose base did not move is checked where it stands, as before: nothing is saved, set up, or moved", async context => {
  const f = fixture(context); const again = await handOff(f); const started = f.head; const files = stood(f); const calls = recordGit(context, f);
  const result = await execute(input(again, { setup: [command("process.exit(1)", { name: "install" })] }, { resume: true }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => {
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), started); assert.deepEqual(stood({ ...f, worktree: request.cwd }), files);
      assert.equal(candidate(request.cwd).status, "?? greeting.test.txt\n?? greeting.txt");
      return review();
    },
  }, person());
  assert.equal(result.state, "delivered");
  assert.deepEqual(result.states, ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  const run = evidence(again); onTip(f, started);
  assert.deepEqual([phases(run), run.delivery.baseCommit, run.delivery.rebasedFrom], [["verify"], started, undefined]);
  assert.deepEqual(savedRefs(f), []);
  for (const name of ["saved-candidate.patch", "resume-conflicts.diff"]) assert.equal(existsSync(join(run.directory, name)), false, name);
  for (const call of calls()) assert.doesNotMatch(call, /^(?:commit-tree|cherry-pick|update-ref|stash)\b|^reset\s(?:.*\s)?--hard\b/u, call);
});

/** The worktree and recorded branch an earlier run of the ticket left, without a candidate. */
const linked = (f: Fixture) => { git(f.repo, "worktree", "add", "-q", "-b", branch, f.worktree); git(f.repo, "config", `branch.${branch}.ticket`, "proj-12"); };
test("a clean resume move preserves binary additions and deletions in both the candidate and its saved patch", async context => {
  const f = fixture(context); const again = await handOff(f); const original = f.head;
  const bytes = Buffer.from([0, 1, 255, 10, 0, 128]);
  writeFileSync(join(f.worktree, "asset.bin"), bytes); rmSync(join(f.worktree, "code.txt"));
  const tip = advance(again); let saved = "";
  const result = await execute(scoped(input(again, {}, { resume: true }), "asset.bin", "code.txt"), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => {
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip);
      assert.equal(git(f.repo, "rev-parse", branch), tip);
      assert.equal(readFileSync(join(request.cwd, "later.txt"), "utf8"), "later\n");
      assert.deepEqual(readFileSync(join(request.cwd, "asset.bin")), bytes); assert.equal(existsSync(join(request.cwd, "code.txt")), false);
      [saved] = savedRefs(f) as [string]; assert.equal(git(f.repo, "rev-parse", `${saved}^`), original);
      assert.deepEqual(execFileSync("git", ["show", `${saved}:asset.bin`], { cwd: f.repo, stdio: ["ignore", "pipe", "pipe"] }), bytes);
      assert.ok(request.prompt.includes(original)); assert.ok(request.prompt.includes(tip));
      return review();
    },
  });
  assert.equal(result.state, "delivered"); onTip(f, tip);
  const run = evidence(again); assert.deepEqual(phases(run), ["verify"]); assert.equal(run.delivery.rebasedFrom, undefined);
  const patch = readFileSync(join(run.directory, "saved-candidate.patch"), "utf8");
  assert.equal(patch, execFileSync("git", ["diff", "--binary", original, saved], { cwd: f.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.match(patch, /GIT binary patch/u); assert.match(patch, /deleted file mode/u);
});

test("a clean resumed worktree moves onto the current tip and runs setup before falsify", async context => {
  const f = fixture(context); linked(f); const tip = advance(f); const seen: string[] = [];
  const setup = [command('if (!require("fs").existsSync("later.txt")) process.exit(2)', { name: "install" })];
  const result = await execute(input(f, { setup }, { resume: true }), {
    falsify: request => {
      seen.push("falsify"); assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip);
      assert.equal(git(request.cwd, "status", "--porcelain"), ""); return ok("sound");
    },
  });
  assert.equal(result.state, "delivered"); assert.deepEqual(seen, ["falsify"]);
  assert.deepEqual(phases(evidence(f)), ["setup", "red", "verify"]); assert.deepEqual(savedRefs(f), []); onTip(f, tip);
});

for (const [label, script, reason] of [
  ["fails", 'require("fs").writeFileSync("setup-output.txt", "leftover"); process.exit(3)', /setup: install failed/u],
  ["leaves unignored output", 'require("fs").writeFileSync("setup-output.txt", "leftover")', /changed tracked or unignored files/u],
  ["moves HEAD", 'require("child_process").execFileSync("git", ["checkout", "--detach", "HEAD^"])', /moved HEAD or the ticket branch/u],
] as const) {
  test(`resume restores the saved candidate on its old base when setup ${label} on the new tip`, async context => {
    const f = fixture(context); const again = await handOff(f); const started = f.head; const files = stood(f); const before = candidate(f.worktree);
    advance(again); const human = person("hand off");
    const result = await execute(input(again, { setup: [command(script, { name: "install" })] }, { resume: true }), {
      investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    const run = questionedIn("prepare", again, result, reason, human);
    uncommitted(f, run, started, before); untouched(again);
    const ref = savedAsItStood(f, run.directory, started, files); assert.ok(run.prompt.includes(ref));
    assert.equal(existsSync(join(f.worktree, "setup-output.txt")), false); assert.equal(existsSync(join(f.worktree, "later.txt")), false);
    assert.deepEqual(phases(run), ["setup"]); assert.equal(run.result.checksPassed, false);
  });
}

for (const marker of ["<<<<<<< ours", "||||||| base", ">>>>>>> theirs"]) {
  test(`a staged resolution with leftover ${marker} counts as a failed repair`, async context => {
    const f = fixture(context); const again = await handOff(f); advance(again, "greeting.txt", "hi\n"); const human = person("hand off");
    const result = await execute(input(again, {}, { resume: true, maxRepairs: 0 }), {
      implementer: request => { writeFileSync(join(request.cwd, "greeting.txt"), `hello\n${marker}\n`); git(request.cwd, "add", "greeting.txt"); return ok(); },
      reviewer: () => assert.fail(),
    }, human);
    const run = questionedIn("repairBudget", again, result, /Unsettled conflicts.*greeting\.txt/u, human);
    assert.deepEqual(phases(run), []); assert.equal(git(f.worktree, "ls-files", "-u"), "");
    assert.ok(run.prompt.includes(savedRefs(f)[0]!));
  });
}

test("resume keeps a handed-off unmerged index and its original saved candidate for the implementer", async context => {
  const f = fixture(context); const again = await handOff(f); const tip = advance(again, "greeting.txt", "hi\n");
  await execute(input(again, {}, { resume: true, maxRepairs: 0 }), { implementer: () => ok(), reviewer: () => assert.fail() }, person("hand off"));
  const refs = savedRefs(f); const later = next(again, 3);
  const result = await execute(input(later, {}, { resume: true }), {
    investigator: () => assert.fail(),
    implementer: request => {
      assert.ok(request.prompt.includes(refs[0]!)); assert.match(git(request.cwd, "ls-files", "-u"), /greeting\.txt/u);
      // A Markdown underline is not a conflict marker.
      writeFileSync(join(request.cwd, "greeting.txt"), "hello\n=======\nhi\n"); git(request.cwd, "add", "greeting.txt"); return ok();
    },
    reviewer: request => { assert.match(request.prompt, /Settled conflicts: "greeting\.txt"/u); return review(); },
  });
  assert.equal(result.state, "delivered"); onTip(f, tip); assert.deepEqual(savedRefs(f), refs);
  assert.deepEqual(result.states.slice(0, 5), ["shape", "prepare", "change", "scopeAfterChange", "verify"]);
});

const noRecord = (name: string, ticket = "proj-12") => new RegExp(`^Refused: Cannot resume: HEAD in .+ is on ${name}, which has ${literal(unsettled(name, ticket))} Evidence: `, "u");
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
  test(`resume with ${label} is refused without changing anything`, async context => {
    const f = fixture(context); arrange(f);
    const snapshot = () => [git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), git(f.repo, "worktree", "list", "--porcelain"),
      existsSync(f.worktree) ? readdirSync(f.worktree) : null, existsSync(join(f.worktree, "greeting.txt")) ? readFileSync(join(f.worktree, "greeting.txt"), "utf8") : null];
    const before = snapshot();
    const result = await execute(input(f, { setup: [command("process.exit(1)")] }, { resume: true }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
    const run = held(f, result, reason); refused(f, result, /^Cannot resume: /u);
    assert.match(result.output.summary, /^Refused: Cannot resume: /u); assert.doesNotMatch(result.output.summary, /Worktree kept/u);
    assert.deepEqual([run.delivery.outcome, run.delivery.resumed, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.result.checks.length], ["refused", undefined, false, false, null, 0]);
    assert.deepEqual(snapshot(), before);
  });
}

test("an Agent that commits by itself is not delivered: commit asks only hand off or discard, since a retry would meet the same commit", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const human = person("hand off");
  const result = await execute(input(f, { output: "pr" }), {
    implementer: request => { implement(request); git(request.cwd, "add", "."); git(request.cwd, "commit", "-qm", "agent commit"); return ok(); },
  }, human);
  const run = steppedOff(f, result, "commit", "keepDecide", /only this workflow commits/u, human, 1); untouched(f);
  assert.equal(git(f.repo, "log", "-1", "--format=%s", branch), "agent commit");
  assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(run.delivery.commit, null);
});

test("an approved candidate with no change is not committed: commit asks only hand off or discard", async context => {
  const f = fixture(context); const human = person("hand off");
  steppedOff(f, await execute(input(f, {}, { redGreen: false }), { implementer: () => ok() }, human), "commit", "keepDecide", /Nothing to commit/u, human, 0); untouched(f);
});

/** A delivered ticket is not a failure: a worktree that cannot be removed afterwards is named in the summary, with the log that says why. */
function keptAfterDelivery(f: Fixture, result: { state: unknown; output: any; states: string[] }) {
  assert.equal(result.state, "delivered"); assert.deepEqual(result.states.slice(-3), ["deliver", "success", "delivered"]);
  const run = held(f, result, new RegExp(`^Delivered ${branch} at ${git(f.repo, "rev-parse", branch)}`, "u")); untouched(f);
  assert.deepEqual([run.result.outcome, run.result.reason], ["completed", ""]);
  assert.deepEqual([run.delivery.outcome, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, Object.hasOwn(run.delivery, "reason")], ["delivered", true, false, false]);
  assert.equal(run.delivery.commit, git(f.repo, "rev-parse", branch)); assert.equal(deliveredAs(f), run.delivery.commit);
  assert.match(result.output.summary, new RegExp(`Worktree kept at ${literal(f.worktree)}.+${literal(join(run.directory, "git-worktree.log"))}`, "u"));
  assert.match(readFileSync(join(run.directory, "git-worktree.log"), "utf8"), /untracked|modified/u);
  assert.ok(existsSync(join(f.worktree, ".machine-runs/nested.json")));
  return run;
}
const nested = (request: { cwd: string }) => { mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/nested.json"), "{}"); return implement(request); };

test("nested run evidence is never committed, and a worktree that cannot be removed after delivery still ends delivered, naming it", async context => {
  const f = fixture(context);
  const result = await execute(input(f, { output: "patch" }), { implementer: nested });
  const run = keptAfterDelivery(f, result);
  assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
  assert.ok(result.output.summary.includes(run.delivery.patches[0]));
});

test("a pull request whose worktree cannot be removed after delivery ends delivered at once, naming the worktree, without waiting for the merge", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  const result = await execute(input(f, { output: "pr" }), { implementer: nested });
  const run = keptAfterDelivery(f, result);
  // With the branch still checked out in the kept worktree, the merge wait could not delete it; it is not entered.
  assert.deepEqual(gh.views(), []); for (const state of ["checkMerge", "awaitMerge", "cleanUp"]) assert.equal(result.states.includes(state), false, state);
  assert.equal(run.delivery.prUrl, url); assert.ok(result.output.summary.includes(url)); assert.equal(existsSync(join(run.directory, "merge.json")), false);
  assert.equal(pushed(), `refs/heads/${branch} ${run.delivery.commit}`); assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
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
  test(`a ${hook} hook that alters the approved candidate stops before delivery and asks only hand off or discard`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const human = person("hand off");
    mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks", hook), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const run = steppedOff(f, await execute(input(f, { output: "pr" }), {}, human), "commit", "keepDecide", /commit hook or Git configuration changed the approved candidate/u, human, 1); untouched(f);
    assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(run.delivery.commit, null);
  });
}

test("a commit hook that leaves the candidate and its message intact does not prevent delivery", async context => {
  const f = fixture(context);
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(join(f.repo, ".git/hooks/commit-msg"), '#!/bin/sh\nprintf "\\nReviewed-by: hook\\n" >> "$1"\n', { mode: 0o755 });
  const result = await execute(input(f));
  assert.equal(result.state, "delivered"); assert.match(git(f.repo, "log", "-1", "--format=%B", branch), /^Add a greeting\n\nTicket: PROJ-12\n\nReviewed-by: hook$/u);
});

test("a hook that moves the ticket branch off the approved commit stops before anything is pushed and asks only hand off or discard", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const human = person("hand off");
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true });
  writeFileSync(join(f.repo, ".git/hooks/post-commit"), `#!/bin/sh\ngit checkout -q --detach && git branch -f ${branch} ${f.head}\n`, { mode: 0o755 });
  const run = steppedOff(f, await execute(input(f, { output: "pr" }), {}, human), "commit", "keepDecide", /moved HEAD or ticket\/proj-12-add-a-greeting away from the approved commit/u, human, 0); untouched(f);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(run.delivery.commit, null);
});

test("a commit hook that refuses the commit asks, asks again when retry meets it again, and retry delivers once the hook lets it through", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  const hook = join(f.repo, ".git/hooks/pre-commit");
  mkdirSync(join(f.repo, ".git/hooks"), { recursive: true }); writeFileSync(hook, "#!/bin/sh\necho 'pre-commit: refused' >&2\nexit 1\n", { mode: 0o755 });
  let logged = "";
  const human = person("retry", () => { logged = readFileSync(join(runDirectory(f), "git-commit.log"), "utf8"); rmSync(hook); return "retry"; });
  const result = await execute(input(f, { output: "pr" }), {}, human);
  const run = merged(f, result); untouched(f);
  assert.equal(human.requests.length, 2);
  for (const request of human.requests) stepAsked(f, request, "commit", /git commit failed; inspect .+git-commit\.log/u, stepChoices);
  asksWritten(run.directory, human.requests);
  // A second refusal is a second question, with the log of that attempt, not a run that fails on the log of the first.
  assert.match(logged, /pre-commit: refused/u);
  assert.deepEqual(result.states.filter(state => ["commit", "stepFailed", "stepDecide", "rebase"].includes(state)),
    ["commit", "stepFailed", "stepDecide", "commit", "stepFailed", "stepDecide", "commit", "rebase"]);
  assert.equal(result.states.filter(state => state === "review").length, 1, "retry commits the approved candidate without another review");
  assert.deepEqual(run.result.decisions, [{ stage: "stepDecide", response: "retry" }, { stage: "stepDecide", response: "retry" }]);
  assert.equal(git(f.repo, "rev-parse", `${run.delivery.commit}^`), f.head); assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", run.delivery.commit), "Add a greeting\nTicket: PROJ-12");
  assert.equal(git(f.repo, "show", "--name-only", "--format=", run.delivery.commit), "greeting.test.txt\ngreeting.txt");
  assert.equal(pushed(), ""); assert.deepEqual(gh()!.slice(0, 2), ["pr", "create"]);
});

test("the pull request is opened in the pushed repository whatever GH_REPO says, with a message-only review in its body", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  // Every gh call, the pull request's and each check of it, records what GH_REPO it was given and then answers as the fake does.
  const bin = join(f.root, "bin"); renameSync(join(bin, "gh"), join(bin, "gh-fake"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s|' "$GH_REPO" >> "${bin}/gh-repo"\nexec "${bin}/gh-fake" "$@"\n`, { mode: 0o755 });
  process.env.GH_REPO = "someone/else"; context.after(() => { delete process.env.GH_REPO; });
  const result = await execute(input(f, { output: "pr" }), { reviewer: () => ({ ...review(), summary: undefined, message: "Prose-only approval" }) });
  merged(f, result);
  assert.deepEqual(gh()!.slice(2, 4), ["--repo", slug]); assert.equal(readFileSync(join(bin, "gh-repo"), "utf8"), "|".repeat(1 + gh.views().length));
  const body = readFileSync(join(evidence(f).directory, "pull-request.md"), "utf8");
  assert.match(body, /Prose-only approval/u); assert.doesNotMatch(body, /undefined/u);
});

test("a remote that names no hosted repository is refused in prepare, before any worktree, Agent, or commit", async context => {
  const f = fixture(context); const gh = fakeGh(context, f);
  const bare = join(f.root, "remote.git"); git(f.root, "init", "-q", "--bare", "-b", "main", bare); git(f.repo, "remote", "add", "origin", bare);
  git(f.repo, "push", "-q", "origin", "main");
  const result = await execute(input(f, { output: "pr" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
  const run = refused(f, result, /does not name a hosted owner\/repository/u);
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.commit, run.result.agentInvocations], [false, null, 0]);
  assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
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
  const run = merged(f, result);
  // Neither the push nor the deletion after the merge went to the pushurl.
  assert.equal(pushed.atCheck(), `refs/heads/${branch} ${run.delivery.commit}`); assert.equal(pushed(), ""); assert.equal(git(other, "for-each-ref"), "");
});

test("a remote reconfigured after the base was checked gets neither the push nor the pull request", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
  // A second repository that would take the push just as well, and holds the same published base.
  const other = join(f.root, "other.git"); git(f.root, "init", "-q", "--bare", "-b", "main", other); git(f.repo, "push", "-q", other, "main");
  const elsewhere = "https://example.invalid/acme/elsewhere.git"; git(f.repo, "config", `url.${other}.insteadOf`, elsewhere);
  const result = await execute(input(f, { output: "pr" }), {
    implementer: request => { git(request.cwd, "remote", "set-url", "origin", elsewhere); git(request.cwd, "remote", "add", "upstream", elsewhere); return implement(request); },
  });
  const commit = merged(f, result).delivery.commit; assert.equal(git(f.repo, "config", "--get", "remote.origin.url"), elsewhere);
  // The merged branch is deleted where it was pushed, not at the remote the configuration names now.
  assert.equal(pushed.atCheck(), `refs/heads/${branch} ${commit}`); assert.equal(pushed(), ""); assert.equal(git(other, "for-each-ref", "--format=%(refname)"), "refs/heads/main");
  assert.deepEqual(gh()!.slice(0, 4), ["pr", "create", "--repo", slug]);
});

for (const [base, forget] of [["release", ["branch", "-D", "release"]], ["origin/release", ["update-ref", "-d", "refs/remotes/origin/release"]]] as const) {
  test(`a pull request base given as ${base} stays the branch that was checked when that ref is gone before delivery`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
    // release is ahead of main on the remote, so a pull request against the default branch would carry its commit.
    git(f.repo, "checkout", "-q", "-b", "release"); git(f.repo, "commit", "-q", "--allow-empty", "-m", "released"); git(f.repo, "push", "-q", "origin", "release");
    const release = git(f.repo, "rev-parse", "release"); git(f.repo, "checkout", "-q", "main");
    const result = await execute(input(f, { output: "pr", base }), { implementer: request => { git(request.cwd, ...forget); return implement(request); } });
    const commit = merged(f, result).delivery.commit; untouched(f);
    assert.throws(() => git(f.repo, "rev-parse", "--verify", "--quiet", `${base}^{commit}`));
    // rebase has no tip to compare the base commit with, so it goes on to delivery as the candidate was approved, with nothing verified again.
    assert.deepEqual(result.states.slice(-7), ["commit", "rebase", "deliver", "success", "checkMerge", "cleanUp", "merged"]);
    assert.deepEqual([phases(evidence(f)), evidence(f).delivery.baseCommit, evidence(f).delivery.rebasedFrom], [["red", "verify"], release, undefined]);
    assert.equal(git(f.repo, "rev-parse", `${commit}^`), release);
    assert.deepEqual(pushed.atCheck().split("\n"), [`refs/heads/release ${release}`, `refs/heads/${branch} ${commit}`]); assert.equal(pushed(), `refs/heads/release ${release}`);
    assert.deepEqual(gh()!.slice(0, 9), ["pr", "create", "--repo", slug, "--draft", "--base", "release", "--head", branch]);
  });
}

test("pr delivery pushes no tag even when Git is configured to follow tags", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f);
  git(f.repo, "config", "push.followTags", "true"); git(f.repo, "tag", "-am", "release", "v1");
  const result = await execute(input(f, { output: "pr" }));
  assert.equal(pushed.atCheck(), `refs/heads/${branch} ${merged(f, result).delivery.commit}`); assert.equal(pushed(), "");
});

/**
 * A remote that refuses the first `times` pushes of the ticket branch, saying which attempt it refused, and takes every later one.
 * A deletion is not counted, so the merged branch is still deleted afterwards.
 */
function failingPushes(f: Fixture, times: number) {
  const count = join(f.root, "pushes");
  mkdirSync(join(f.root, "remote.git/hooks"), { recursive: true });
  writeFileSync(join(f.root, "remote.git/hooks/pre-receive"), [
    "#!/bin/sh",
    "while read old new ref; do",
    '  case "$new" in *[!0]*) ;; *) continue ;; esac',
    `  n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${count}"`,
    `  if [ "$n" -le ${times} ]; then echo "push $n of the ticket branch refused" >&2; exit 1; fi`,
    "done",
  ].join("\n") + "\n", { mode: 0o755 });
  return () => existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
}
/** The sleeps a run took between the attempts of an Operation that retries: each is a minute, and they count the attempts in order. */
function retried(result: { sleeps: { enteredAt: string; due: string; retry?: { attempt: number; of: number } }[] }, times: number) {
  const between = result.sleeps.filter(sleep => sleep.retry);
  assert.equal(between.length, times, JSON.stringify(result.sleeps));
  between.forEach((sleep, index) => {
    assert.equal(Date.parse(sleep.due) - Date.parse(sleep.enteredAt), 60_000, "a minute between attempts");
    assert.deepEqual(sleep.retry, { attempt: index + 2, of: 4 });
  });
}

test("a push that fails twice and then succeeds delivers without a question, a new commit, or a new review", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const pushes = failingPushes(f, 2); const calls = recordGit(context, f);
  let reviews = 0; let edits = 0;
  const result = await untilEnd(input(f, { output: "pr" }), { implementer: request => { edits++; return implement(request); }, reviewer: () => { reviews++; return review(); } }, person());
  const run = merged(f, result); untouched(f);
  // The retries ran inside deliver: two sleeps of a minute, three pushes, and nothing before deliver ran again.
  retried(result, 2); assert.equal(result.sleeps.length, 2); assert.equal(pushes(), 3);
  assert.deepEqual([edits, reviews], [1, 1]);
  for (const state of ["commit", "rebase", "review", "change"]) assert.equal(result.states.filter(one => one === state).length, 1, state);
  for (const state of ["stepFailed", "deliverDecide", "stuck", "decide", "failure"]) assert.equal(result.states.includes(state), false, state);
  assert.equal(readdirSync(run.directory).some(name => /^question-\d+\.txt$/u.test(name)), false);
  const commit = run.delivery.commit; assert.equal(git(f.repo, "rev-parse", `${commit}^`), f.head);
  assert.equal(pushed.atCheck(), `refs/heads/${branch} ${commit}`); assert.equal(pushed(), "");
  assert.equal(calls().filter(call => /^commit\s/u.test(call)).length, 1, "the ticket was committed once");
  assert.deepEqual(gh()!.slice(0, 2), ["pr", "create"]); assert.deepEqual(result.unsaveable, [], "every state's working data is plain JSON");
});

test("a push that fails four times asks with only retry and hand off, and retry with the push now succeeding delivers", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const pushes = failingPushes(f, 4);
  let asked = 0; const human = person(() => { asked = pushes(); return "retry"; });
  const result = await untilEnd(input(f, { output: "pr" }), {}, human);
  untouched(f);
  // One push and three more a minute apart; then the question; then the one push retry made.
  retried(result, 3); assert.equal(asked, 4); assert.equal(pushes(), 5);
  assert.equal(result.state, "merged"); assert.deepEqual(result.states.slice(-3), ["checkMerge", "cleanUp", "merged"]);
  const asking = result.states.indexOf("deliverDecide");
  assert.deepEqual(result.states.slice(asking - 2, asking + 1), ["deliver", "stepFailed", "deliverDecide"]);
  assert.deepEqual(result.states.slice(asking + 1).filter(state => ["deliver", "success"].includes(state)), ["deliver", "success"]);
  for (const state of ["commit", "rebase", "review"]) assert.equal(result.states.filter(one => one === state).length, 1, state);
  const run = complete(f, result, /^Merged /u);
  assert.equal(human.requests.length, 1); stepAsked(f, human.requests[0], "deliver", /git push failed; inspect .+git-push\.log/u, deliverChoices);
  assert.ok(human.requests[0]!.prompt.includes(`Evidence: ${run.directory}`)); asksWritten(run.directory, human.requests);
  assert.deepEqual(run.result.decisions, [{ stage: "deliverDecide", response: "retry" }]);
  assert.deepEqual([run.delivery.outcome, run.delivery.prUrl, run.result.outcome], ["delivered", url, "completed"]);
  assert.match(readFileSync(join(run.directory, "git-push.log"), "utf8"), /push 4 of the ticket branch refused/u);
  assert.equal(pushed.atCheck(), `refs/heads/${branch} ${run.delivery.commit}`); assert.equal(pushed(), ""); assert.equal(gh.views().length, 1);
  assert.equal(git(f.repo, "branch", "--list", branch), ""); assert.equal(existsSync(f.worktree), false);
});

test("a push that keeps failing is retried three times a minute apart, then asks; hand off keeps the committed local branch, and gh never starts", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const human = person("hand off");
  // The remote answers the question prepare asks about the base and then refuses the push.
  mkdirSync(join(f.root, "remote.git/hooks"), { recursive: true }); writeFileSync(join(f.root, "remote.git/hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = await untilEnd(input(f, { output: "pr" }), {}, human);
  retried(result, 3); assert.equal(result.sleeps.length, 3);
  const run = steppedOff(f, result, "deliver", "deliverDecide", /git push failed; inspect .+git-push\.log/u, human, 1); untouched(f);
  assert.equal(run.delivery.commit, git(f.repo, "rev-parse", branch)); assert.equal(run.delivery.prUrl, undefined); assert.equal(deliveredAs(f), "");
  assert.match(readFileSync(join(run.directory, "git-push.log"), "utf8"), /pre-receive hook declined/u); assert.equal(pushed(), ""); assert.equal(gh(), undefined);
});

test("a gh that keeps failing is retried three times a minute apart, then asks; hand off keeps the pushed branch and the local one", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 1); const human = person("hand off");
  const result = await untilEnd(input(f, { output: "pr" }), {}, human);
  retried(result, 3);
  const run = steppedOff(f, result, "deliver", "deliverDecide", /gh pr failed; inspect .+gh-pr\.log/u, human, 1); untouched(f);
  assert.equal(pushed(), `refs/heads/${branch} ${run.delivery.commit}`); assert.equal(run.delivery.prUrl, undefined);
  assert.ok(gh()!.includes("--draft")); assert.doesNotMatch(result.output.summary, /example\.invalid/u); assert.deepEqual(gh.views(), []);
});

/** Each `gh pr view` a run made asked about the pull request it opened. */
const viewed = (gh: ReturnType<typeof fakeGh>, times: number) => {
  const views = gh.views(); assert.equal(views.length, times, views.join("; "));
  for (const view of views) assert.ok(view.startsWith("pr view ") && view.includes(url), view);
};
const checks = (states: string[]) => states.filter(state => state === "checkMerge").length;

test("a delivered pull request is checked until gh reports it merged, sleeping ten minutes between checks; then the ticket branch is deleted here and on the remote, and the run completes", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 0, ["OPEN", "MERGED"]);
  const result = await untilEnd(input(f, { output: "pr" }, { stuck: "park" }));
  const run = merged(f, result); untouched(f);
  // Two checks, and one sleep between them that is due ten minutes after the wait began.
  viewed(gh, 2); assert.equal(checks(result.states), 2);
  assert.equal(result.sleeps.length, 1); assert.equal(Date.parse(result.sleeps[0]!.due) - Date.parse(result.sleeps[0]!.enteredAt), 10 * 60_000);
  assert.deepEqual(result.unsaveable, [], "every state's working data is plain JSON");
  // The branch was on the remote when gh reported the merge, and is deleted there and here only after that.
  const commit = run.delivery.commit;
  assert.equal(pushed.atCheck(), `refs/heads/${branch} ${commit}`); assert.equal(pushed(), "");
  assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", commit), "Add a greeting\nTicket: PROJ-12"); assert.equal(git(f.repo, "rev-parse", `${commit}^`), f.head);
  assert.deepEqual(gh()!.slice(0, 2), ["pr", "create"]);
});

test("a merged pull request whose remote branch is already gone, as when the host deletes it on merge, still ends merged", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 0, ["OPEN", "MERGED"]);
  const result = await untilEnd(input(f, { output: "pr" }), {}, person(), entry => {
    if (entry.kind === "wait") git(join(f.root, "remote.git"), "update-ref", "-d", `refs/heads/${branch}`);
  });
  merged(f, result); untouched(f); viewed(gh, 2);
  assert.equal(pushed.atCheck(), ""); assert.equal(pushed(), "");
});

/** A remote that takes the delivery's push and refuses the first `times` deletions of a branch, every one when `times` is omitted. */
function refusingDeletes(f: Fixture, times = Infinity) {
  const count = join(f.root, "deletes");
  mkdirSync(join(f.root, "remote.git/hooks"), { recursive: true });
  writeFileSync(join(f.root, "remote.git/hooks/pre-receive"), [
    "#!/bin/sh",
    "while read old new ref; do",
    '  case "$new" in *[!0]*) continue ;; esac',
    `  n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${count}"`,
    `  if ${Number.isFinite(times) ? `[ "$n" -le ${times} ]` : "true"}; then echo "deletion $n of $ref refused" >&2; exit 1; fi`,
    "done",
  ].join("\n") + "\n", { mode: 0o755 });
  return () => existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
}
/** The question cleanUp asks once its retries are spent: the merge decision with retry added, naming the pull request, the branch, and the error. */
function mergeRetryAsked(request: Ask | undefined, reason: RegExp) {
  assert.ok(request, "cleanUp asked its question");
  assert.deepEqual(request.choices, mergeRetryChoices); assert.equal(request.suggestions, undefined);
  assert.match(request.prompt, reason); for (const part of [url, branch, "Evidence: "]) assert.ok(request.prompt.includes(part), part);
  for (const choice of mergeRetryChoices) assert.ok(request.prompt.split("\n").some(line => line.startsWith(`${choice}: `)), `the question says what ${choice} does`);
}

test("a remote that keeps refusing to delete the merged ticket branch is retried three times a minute apart, then asks; hand off keeps the branch there", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const deletes = refusingDeletes(f); const human = person("hand off");
  const result = await untilEnd(input(f, { output: "pr" }), {}, human);
  retried(result, 3); assert.equal(result.sleeps.length, 3); assert.equal(deletes(), 4); viewed(gh, 1); untouched(f);
  assert.equal(result.state, "handedOff"); assert.deepEqual(result.states.slice(-5), ["cleanUp", "mergeFailed", "mergeRetryDecide", "mergeHandOff", "handedOff"]);
  for (const state of ["blocked", "mergeFailure", "merged"]) assert.equal(result.states.includes(state), false, state);
  assert.equal(human.requests.length, 1); mergeRetryAsked(human.requests[0], /git push failed deleting ticket\/proj-12-add-a-greeting/u);
  const run = held(f, result, /^Handed off: /u); asksWritten(run.directory, human.requests);
  assert.ok(holding(run.directory, ["refused"]).some(name => name.endsWith(".log")), "the refusal is kept in a log");
  assert.deepEqual(run.result.decisions, [], "the delivery receipt predates merge-wait decisions");
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "human-1.json"), "utf8")), { stage: "mergeRetryDecide", response: "hand off" });
  const receipt = JSON.parse(readFileSync(join(run.directory, "merge.json"), "utf8"));
  assert.deepEqual([receipt.outcome, receipt.decision, receipt.remoteDeleted, receipt.localDeleted], ["handedOff", "hand off", false, false]);
  assert.match(receipt.reason, /git push failed deleting/u);
  assert.equal(pushed(), `refs/heads/${branch} ${run.delivery.commit}`); assert.equal(git(f.repo, "rev-parse", branch), run.delivery.commit);
});

test("a cleanUp that fails four times asks with retry added to the merge decision, and retry completes the merge wait", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const deletes = refusingDeletes(f, 4);
  let asked = 0; const human = person(() => { asked = deletes(); return "retry"; });
  const result = await untilEnd(input(f, { output: "pr" }), {}, human);
  retried(result, 3); assert.deepEqual([asked, deletes()], [4, 5]); viewed(gh, 1); untouched(f);
  assert.equal(result.state, "merged"); assert.deepEqual(result.states.slice(-2), ["cleanUp", "merged"]);
  const asking = result.states.indexOf("mergeRetryDecide");
  assert.deepEqual(result.states.slice(asking - 2, asking + 1), ["cleanUp", "mergeFailed", "mergeRetryDecide"]);
  // retry runs cleanUp again and nothing before it: the pull request is not asked about again.
  assert.equal(checks(result.states), 1); assert.equal(result.states.filter(state => state === "cleanUp").length, 2);
  mergeRetryAsked(human.requests[0], /git push failed deleting/u); assert.equal(human.requests.length, 1);
  const run = complete(f, result, /^Merged /u); asksWritten(run.directory, human.requests);
  for (const part of [url, branch]) assert.ok(result.output.summary.includes(part), part);
  assert.deepEqual(run.result.decisions, [], "the delivery receipt predates merge-wait decisions");
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "human-1.json"), "utf8")), { stage: "mergeRetryDecide", response: "retry" });
  const receipt = JSON.parse(readFileSync(join(run.directory, "merge.json"), "utf8"));
  assert.deepEqual([receipt.outcome, receipt.localDeleted, receipt.remoteDeleted], ["merged", true, true]);
  assert.equal(pushed(), ""); assert.equal(git(f.repo, "branch", "--list", branch), ""); assert.equal(existsSync(f.worktree), false);
});

test("a merge question with a presenter bound is explained with the merge step's facts, its choices unchanged, and hand off matched as before", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f); refusingDeletes(f); const human = person("hand off"); const explain = presenter(() => "retry");
  const result = await untilEnd(input(f, { output: "pr" }), { presenter: explain }, human);
  assert.equal(result.state, "handedOff"); assert.deepEqual(result.states.slice(-3), ["mergeRetryDecide", "mergeHandOff", "handedOff"]);
  assert.equal(human.requests.length, 1); const [request] = human.requests; mergeRetryAsked(request, /git push failed deleting/u);
  assert.deepEqual(explain.asked, [request]);
  evidencePage(f, request, "cleanUp", /git push failed deleting/u, [url, "greeting.txt"], mergeRetryChoices);
  assert.deepEqual([request!.recommended, request!.discards], ["hand off", ["discard"]]);
  assert.ok(stuckNote(f).includes(request!.page!), "merge recovery persists its page after the worktree is gone");
  const run = held(f, result, /^Handed off: /u); asksWritten(run.directory, human.requests);
  const facts = factsOf(explain.prompts[0]!);
  assert.match(facts, /\bcleanUp\b/u); assert.match(facts, /git push failed deleting/u); assert.ok(facts.includes(url), url);
  assert.ok(facts.includes(run.directory), run.directory);
  assert.equal(existsSync(f.worktree), false);
  assert.deepEqual(JSON.parse(facts).files, [
    { path: "greeting.test.txt", added: 1, removed: 0 },
    { path: "greeting.txt", added: 1, removed: 0 },
  ], "the delivered diff remains available after the worktree and local branch are removed");
  assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "human-1.json"), "utf8")), { stage: "mergeRetryDecide", response: "hand off" });
});

test("a local branch that cannot be deleted after a merge is retried, then asks; retry once it can be deleted completes the merge wait", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f);
  // Checked out in a worktree of its own, the local branch cannot be deleted; the person frees it before answering.
  const holder = join(f.root, "holder"); let placed = false;
  const human = person(() => { git(f.repo, "worktree", "remove", "--force", holder); return "retry"; });
  const result = await untilEnd(input(f, { output: "pr" }), {}, human, entry => {
    if (String(entry.value) === "cleanUp" && !placed) { placed = true; git(f.repo, "worktree", "add", "-q", holder, branch); }
  });
  retried(result, 3); untouched(f);
  assert.equal(result.state, "merged"); assert.deepEqual(result.states.slice(-2), ["cleanUp", "merged"]);
  mergeRetryAsked(human.requests[0], /git branch failed; inspect .+git-branch\.log/u); assert.equal(human.requests.length, 1);
  const run = complete(f, result, /^Merged /u);
  const receipt = JSON.parse(readFileSync(join(run.directory, "merge.json"), "utf8"));
  assert.deepEqual([receipt.outcome, receipt.localDeleted, receipt.remoteDeleted], ["merged", true, true]);
  assert.equal(pushed(), ""); assert.equal(git(f.repo, "branch", "--list", branch), "");
});

for (const choice of ["hand off", "discard"] as const) {
  test(`after remote cleanup succeeds but local deletion fails, ${choice} names the deleted remote branch in its summary`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f);
    const holder = join(f.root, "holder"); let placed = false;
    const human = choice === "hand off" ? person("hand off") : person("discard", () => {
      git(f.repo, "worktree", "remove", "--force", holder); return "confirm discard";
    });
    const result = await untilEnd(input(f, { output: "pr" }), {}, human, entry => {
      if (String(entry.value) === "cleanUp" && !placed) { placed = true; git(f.repo, "worktree", "add", "-q", holder, branch); }
    });
    retried(result, 3); viewed(gh, 1); untouched(f);
    const ending = choice === "hand off" ? "handedOff" : "abandoned";
    assert.equal(result.state, ending);
    mergeRetryAsked(human.requests[0], /git branch failed; inspect .+git-branch\.log/u);
    assert.ok(human.requests[0]!.prompt.includes("The pushed branch has already been deleted."));
    const run = held(f, result, choice === "hand off" ? /^Handed off: /u : /^Abandoned: /u);
    assert.ok(result.output.summary.includes(`Pull request: ${url}. Branch: ${branch}, ${choice === "hand off" ? "kept" : "deleted"} locally. The pushed branch was already deleted on origin. Evidence: `), result.output.summary);
    assert.doesNotMatch(result.output.summary, /kept locally and on|pushed branch is kept/u);
    const receipt = JSON.parse(readFileSync(join(run.directory, "merge.json"), "utf8"));
    assert.deepEqual([receipt.outcome, receipt.localDeleted, receipt.remoteDeleted], [ending, choice === "discard", true]);
    assert.equal(pushed(), "");
    assert.equal(git(f.repo, "branch", "--list", branch).includes(branch), choice === "hand off");
  });
}

/** A delivered pull request's later ending says what happened first, without the branch, then the pull request and where the branch is. */
function settled(summary: string, after: string) {
  const first = summary.split(/(?<=[.!?…])\s/u)[0]!;
  assert.ok(first.length < 120, first); assert.equal(first.includes(branch), false, first);
  assert.match(first, /closed without merging\.$/u); assert.ok(summary.includes(` ${after}`), summary);
}
for (const choice of ["hand off", "discard"] as const) {
  test(`a pull request closed without merging goes to the decision whatever the stuck setting, offering only hand off and discard; ${choice === "hand off" ? "hand off ends handedOff with the branch kept" : "a confirmed discard deletes the local branch only"}`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 0, ["CLOSED"]);
    const human = choice === "hand off" ? person("hand off") : person("discard", "confirm discard");
    // A stuck run would park without asking; a closed pull request asks all the same.
    const result = await untilEnd(input(f, { output: "pr" }, { stuck: "park" }), {}, human);
    viewed(gh, 1); assert.deepEqual(result.sleeps, []); assert.equal(result.states.includes("parked"), false);
    const [asked, confirmation, ...others] = human.requests; assert.deepEqual(others, []);
    assert.deepEqual(asked!.choices, ["hand off", "discard"]);
    evidencePage(f, asked, "checkMerge", /closed without merging/iu, [url], ["hand off", "discard"]);
    assert.match(asked!.prompt, /closed without merging/iu); for (const part of [url, branch]) assert.ok(asked!.prompt.includes(part), part);
    const commit = evidence(f).delivery.commit; untouched(f); assert.equal(existsSync(f.worktree), false);
    // Only a merge deletes the pushed branch.
    assert.equal(pushed(), `refs/heads/${branch} ${commit}`);
    if (choice === "hand off") {
      assert.equal(result.state, "handedOff"); held(f, result, /^Handed off: /u);
      settled(result.output.summary, `Pull request: ${url}. Branch: ${branch}, kept locally and on origin. Evidence: `);
      assert.equal(confirmation, undefined); assert.equal(git(f.repo, "rev-parse", branch), commit);
      return;
    }
    assert.deepEqual(confirmation!.choices, ["confirm discard", "go back"]);
    evidencePage(f, confirmation, "checkMerge", /closed without merging/iu, [url], ["confirm discard", "go back"], "go back");
    assert.equal(result.state, "abandoned"); held(f, result, /^Abandoned: /u);
    settled(result.output.summary, `Pull request: ${url}. Branch: ${branch}, deleted locally; the pushed branch is kept on origin. Evidence: `);
    assert.equal(git(f.repo, "branch", "--list", branch), ""); assert.equal(git(f.repo, "cat-file", "-t", commit), "commit");
  });
}

test("gh failing three times in a row while the run waits for the merge goes to the decision with gh's message", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 0, ["fail"]); const human = person("hand off");
  const result = await untilEnd(input(f, { output: "pr" }, { stuck: "park" }), {}, human);
  viewed(gh, 3); assert.equal(checks(result.states), 3); assert.equal(result.sleeps.length, 2);
  const [asked, ...others] = human.requests; assert.deepEqual(others, []);
  assert.deepEqual(asked!.choices, ["hand off", "discard"]); assert.match(asked!.prompt, /gh: boom/u);
  assert.equal(result.state, "handedOff"); held(f, result, /^Handed off/u); untouched(f);
  const commit = evidence(f).delivery.commit;
  assert.equal(git(f.repo, "rev-parse", branch), commit); assert.equal(pushed(), `refs/heads/${branch} ${commit}`);
});

test("gh failures that an answer interrupts are not in a row: the run keeps waiting and ends merged", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 0, ["fail", "OPEN", "fail", "fail", "MERGED"]); const human = person();
  const result = await untilEnd(input(f, { output: "pr" }), {}, human);
  merged(f, result); viewed(gh, 5); assert.equal(checks(result.states), 5); assert.equal(result.sleeps.length, 4);
  assert.deepEqual(human.requests, []); assert.equal(pushed(), "");
});

test("unexpected gh states count as failures and a cancelled discard keeps both branches", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 0, ["UNKNOWN"]);
  const human = person("discard", "go back", "hand off");
  const result = await untilEnd(input(f, { output: "pr" }, { stuck: "park" }), {}, human);
  viewed(gh, 3); assert.equal(result.sleeps.length, 2); assert.equal(result.state, "handedOff");
  const run = held(f, result, /^Handed off/u);
  assert.match(human.requests[0]!.prompt, /Unexpected gh state: "UNKNOWN"/u);
  assert.deepEqual(human.requests[2]!.choices, ["hand off", "discard"]);
  assert.equal(git(f.repo, "rev-parse", branch), run.delivery.commit);
  assert.equal(pushed(), `refs/heads/${branch} ${run.delivery.commit}`);
  const receipt = JSON.parse(readFileSync(join(run.directory, "merge.json"), "utf8"));
  assert.deepEqual([receipt.outcome, receipt.checks, receipt.ghFailures, receipt.localDeleted, receipt.remoteDeleted, receipt.decision],
    ["handedOff", 3, 3, false, false, "hand off"]);
  assert.equal(holding(run.directory, ["UNKNOWN"]).filter(name => name.endsWith(".log")).length, 3);
  assert.equal(readdirSync(run.directory).filter(name => /^human-\d+\.json$/u.test(name)).length, 3);
  untouched(f);
});

test("a failed remote deletion counts as deleted only when its recheck confirms the branch disappeared", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f);
  // Simulate a host deleting the branch after ls-remote but before the deletion push.
  writeFileSync(join(f.repo, ".git/hooks/pre-push"), [
    "#!/bin/sh",
    'while read local_ref local_sha remote_ref remote_sha; do',
    '  case "$local_sha" in *[!0]*) ;; *)',
    `    git --git-dir="${join(f.root, "remote.git")}" update-ref -d "$remote_ref"`,
    '    echo "host deleted the branch concurrently" >&2; exit 1 ;; esac',
    'done',
  ].join("\n") + "\n", { mode: 0o755 });
  const result = await execute(input(f, { output: "pr" }));
  const run = merged(f, result); assert.equal(pushed(), ""); untouched(f);
  const receipt = JSON.parse(readFileSync(join(run.directory, "merge.json"), "utf8"));
  assert.deepEqual([receipt.outcome, receipt.localDeleted, receipt.remoteDeleted, receipt.reason], ["merged", true, true, undefined]);
  assert.match(readFileSync(join(run.directory, "git-push.log"), "utf8"), /host deleted the branch concurrently/u);
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
    assert.equal(again.state, "refused");
    held(next(f, run), again, new RegExp(`^Refused: Branch ${found} already exists in .+ for this ticket; nothing was changed`, "u"));
  }
  assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), `main\n${branch}\nticket/proj-12-tidy`); untouched(f);
});

test("a ticket whose id and title spell the name of another ticket's branch is refused, and that branch is left alone", async context => {
  const f = fixture(context);
  assert.equal((await execute(input(f))).state, "delivered"); const commit = git(f.repo, "rev-parse", branch);
  const result = await execute({ ...input(next(f, 2)), ticket: { ...input(f).ticket, id: "PROJ", title: "12: add a greeting" } }, { investigator: () => assert.fail() });
  assert.equal(result.state, "refused"); untouched(f);
  held(next(f, 2), result, /^Refused: Branch ticket\/proj-12-add-a-greeting already exists in .+ for ticket proj-12, whose id and title spell the name this ticket would take; nothing was changed/u);
  assert.equal(git(f.repo, "branch", "--format=%(refname:short) %(objectname)"), `main ${f.head}\n${branch} ${commit}`);
  assert.equal(existsSync(join(f.root, "worktrees", "widgets--proj")), false);
});

test("a branch without a record that may be this ticket's under an earlier title refuses it, and a ticket with a shorter id, until its record says whose it is", async context => {
  const f = fixture(context); const agents = { investigator: () => assert.fail() };
  // Made by hand: PROJ-12 under an earlier title, or PROJ titled "12 an earlier title".
  const earlier = "ticket/proj-12-an-earlier-title"; git(f.repo, "branch", earlier);
  const refs = () => git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"); const before = refs();
  for (const [run, id, ticket] of [[1, "PROJ-12", "proj-12"], [2, "PROJ", "proj"]] as const) {
    const result = await execute({ ...input(next(f, run)), ticket: { ...input(f).ticket, id, title: "Add a greeting" } }, agents);
    assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
    assert.ok(result.output.summary.startsWith(`Refused: Branch ${earlier} already exists in ${f.repo} with ${unsettled(earlier, ticket)} Evidence: `), result.output.summary);
    assert.equal(refs(), before); assert.equal(existsSync(join(f.root, "worktrees")), false); assert.throws(() => record(f, earlier));
  }
  // Recorded for PROJ-12, it blocks that ticket as its own branch and no longer concerns PROJ.
  git(f.repo, "config", `branch.${earlier}.ticket`, "proj-12");
  const own = await execute(input(next(f, 3)), agents);
  held(next(f, 3), own, /^Refused: Branch ticket\/proj-12-an-earlier-title already exists in .+ for this ticket; nothing was changed\. Deliver or delete it/u);
  const shorter = await execute({ ...input(next(f, 4)), ticket: { ...input(f).ticket, id: "PROJ", title: "Add a greeting" } });
  assert.equal(shorter.state, "delivered"); untouched(f);
  assert.equal(evidence(next(f, 4)).delivery.branch, "ticket/proj-add-a-greeting"); assert.equal(record(f, "ticket/proj-add-a-greeting"), "proj");
  assert.equal(git(f.repo, "rev-parse", earlier), f.head);
});

test("branches without a record that may be those of tickets with longer ids refuse a ticket one by one, until each record says whose it is", async context => {
  const f = fixture(context); const ticket = { ...input(f).ticket, id: "PROJ", title: "Add a greeting" };
  // None holds a ticket commit. For PROJ each may be its own: titled "12", "12 1", or "12 add a greeting".
  const others = [["ticket/proj-12", "proj-12"], ["ticket/proj-12-1", "proj-12-1"], ["ticket/proj-12-add-a-greeting", "proj-12"]] as const;
  for (const [name] of others) git(f.repo, "branch", name);
  for (const [index, [name, whose]] of others.entries()) {
    const result = await execute({ ...input(next(f, index)), ticket: { ...input(f).ticket, ...ticket } }, { investigator: () => assert.fail() });
    assert.equal(result.state, "refused"); untouched(f);
    assert.ok(result.output.summary.startsWith(`Refused: Branch ${name} already exists in ${f.repo} with ${unsettled(name, "proj")} Evidence: `), result.output.summary);
    assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), ["main", ...others.map(([other]) => other)].join("\n"));
    git(f.repo, "config", `branch.${name}.ticket`, whose);
  }
  const result = await execute({ ...input(next(f, 3)), ticket });
  assert.equal(result.state, "delivered"); untouched(f);
  assert.equal(evidence(next(f, 3)).delivery.branch, "ticket/proj-add-a-greeting");
  for (const [name] of others) assert.equal(git(f.repo, "rev-parse", name), f.head);
});

for (const [name, made] of [["ticket/proj-12", "before branches carried a title or a record"], [branch, "by a run whose record did not come along"]] as const) {
  test(`a delivered ${name} without a record, made ${made}, is told by the ticket commit it holds and refuses that ticket alone`, async context => {
    const f = fixture(context);
    assert.equal((await execute(input(f))).state, "delivered");
    if (name !== branch) git(f.repo, "branch", "-m", branch, name);
    git(f.repo, "config", "--unset", `branch.${name}.ticket`); assert.throws(() => record(f, name));
    const commit = git(f.repo, "rev-parse", name); assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", name), "Add a greeting\nTicket: PROJ-12");
    const own = await execute({ ...input(next(f, 2)), ticket: { ...input(f).ticket, id: "PROJ-12", title: "A later title" } }, { investigator: () => assert.fail() });
    held(next(f, 2), own, new RegExp(`^Refused: Branch ${name} already exists in .+ for this ticket; nothing was changed`, "u"));
    // By its name the branch could be PROJ's under a title starting with 12; the commit says it is PROJ-12's, so only the name itself is taken.
    const same = await execute({ ...input(next(f, 3)), ticket: { ...input(f).ticket, id: "PROJ", title: name === branch ? "12: add a greeting" : "12" } }, { investigator: () => assert.fail() });
    held(next(f, 3), same, new RegExp(`^Refused: Branch ${name} already exists in .+ for ticket proj-12, whose id and title spell the name this ticket would take; nothing was changed`, "u"));
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
  assert.equal(result.state, "refused"); untouched(f);
  assert.ok(result.output.summary.startsWith(`Refused: Branch ${cut} already exists in ${f.repo} with ${unsettled(cut)} Evidence: `), result.output.summary);
});

test("a ticket retitled after its run is refused by the branch that run made, and resumes on it", async context => {
  const f = fixture(context); const earlier = "ticket/proj-12-an-earlier-title";
  const ticket = { ...input(f).ticket, id: "PROJ-12", title: "An earlier title" };
  const first = await execute({ ...input(f, {}, { maxRepairs: 0, maxReviewRounds: 0 }), ticket }, { reviewer: () => ownerReview("Handle the empty case") }, person("hand off"));
  assert.equal(first.state, "handedOff"); assert.equal(record(f, earlier), "proj-12"); assert.equal(git(f.worktree, "symbolic-ref", "--short", "HEAD"), earlier);
  const second = await execute(input(next(f, 2)), { investigator: () => assert.fail() });
  held(next(f, 2), second, /^Refused: Branch ticket\/proj-12-an-earlier-title already exists in .+ for this ticket; nothing was changed/u);
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
    assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
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
    untouched(f);
    // The branch the run adopted is the one it pushed, and the one it deletes once the pull request is merged.
    const run = merged(f, result, name); const commit = run.delivery.commit;
    assert.deepEqual([run.delivery.branch, run.delivery.resumed], [name, true]);
    assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
    assert.equal(git(f.repo, "log", "-1", "--format=%s%n%b", commit), "Add a greeting\nTicket: PROJ-12");
    assert.equal(pushed.atCheck(), `refs/heads/${name} ${commit}`); assert.equal(pushed(), ""); assert.deepEqual(gh()!.slice(5, 9), ["--base", "main", "--head", name]);
  });
}

for (const [label, body, summary] of [
  ["no body", undefined, undefined],
  ["a body that is only its heading", "# Add a greeting\n\n", undefined],
  ["a heading and several paragraphs", "\n# Add a greeting\n\n## Why\n\nWrite hello to greeting.txt,\nand nothing else.\n\nA second paragraph.\n\n## Acceptance criteria\n\n- A file.\n", "Write hello to greeting.txt,\nand nothing else."],
  ["a heading straight after its first paragraph", "# Add a greeting\nWrite hello to greeting.txt,\nand nothing else.\n## Acceptance criteria\n- A file.\n\n### Notes\nNone.\n", "Write hello to greeting.txt,\nand nothing else."],
] as const) {
  test(`a ticket with ${label} ${summary ? "summarizes its first paragraph in the pull request" : "is refused before delivery"}`, async context => {
    const f = fixture(context); remote(f); fakeGh(context, f);
    const result = await execute({ ...input(f, { output: "pr" }), ticket: { ...input(f).ticket, id: "PROJ-12", title: "Add a greeting", body: body === undefined || summary === undefined ? body : `${body}\n${input(f).ticket.body}` } });
    if (summary === undefined) {
      assert.equal(result.state, "refused");
      const run = held(f, result, /^Refused: Ticket body is missing required sections or non-empty lists: Goal, Scope, Acceptance, Forbidden\. Expected shape:/u);
      assert.equal(run.delivery.reason.split(" Expected shape:")[0], "Ticket body is missing required sections or non-empty lists: Goal, Scope, Acceptance, Forbidden.");
      for (const heading of ["Goal", "Scope", "Acceptance", "Forbidden"]) assert.ok(run.delivery.reason.includes(`## ${heading}`));
      assert.equal(existsSync(f.worktree), false); assert.equal(evidence(f).result.agentInvocations, 0);
      assert.equal(existsSync(join(evidence(f).directory, "pull-request.md")), false); return;
    }
    merged(f, result);
    assert.equal(readFileSync(join(evidence(f).directory, "pull-request.md"), "utf8"),
      `Add a greeting\n\n${summary ? `## Summary\n\n${summary}\n\n` : ""}## Checks\n\n- tests: passed\n\n## Review\n\nGreeting matches the ticket\n\nTicket: PROJ-12\n`);
  });
}

const report = (outcome: string, summary: string) => ({ ...review(outcome, summary), summary: undefined, message: JSON.stringify({ outcome, summary }, null, 2) });

test("a review returned as a JSON object is written as prose in the pull request body and the stage report", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f);
  const result = await execute(input(f, { output: "pr" }), { reviewer: () => report("approved", "Greeting matches the ticket.\n\nNo findings.") });
  merged(f, result);
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
  merged(f, result);
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
  assert.ok(result.output.summary.startsWith(`Handed off: Review budget used up (1 of 1). Handle the empty case Blocker: Handle the empty case (greeting.txt:1). Decision: hand off. Branch: ${branch}.`), result.output.summary);
  assert.deepEqual(run.result.agents.filter((agent: any) => agent.stage === "review").map((agent: any) => agent.summary), Array(4).fill("Handle the empty case"));
});

/** Local commits on the base that the remote has never been sent. */
function ahead(f: Fixture, commits: number) {
  for (let made = 0; made < commits; made++) git(f.repo, "commit", "-q", "--allow-empty", "-m", `unpublished ${made}`);
  f.head = git(f.repo, "rev-parse", "HEAD");
}

for (const [commits, count] of [[1, /Base HEAD has 1 unpublished local commit that is not in the default branch main on origin, /u], [2, /Base HEAD has 2 unpublished local commits that are not in the default branch main on origin, /u]] as const) {
  test(`a pr run whose base is ${commits} ahead of the remote is refused before any Agent and publishes nothing`, async context => {
    const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); ahead(f, commits);
    // The remote-tracking ref claims the base is published; only the remote itself knows.
    git(f.repo, "update-ref", "refs/remotes/origin/main", f.head);
    // A resumed run would push as well, so it is asked the same question about the commit its branch is on, and its worktree is left as it was.
    if (commits === 2) linked(f);
    const refs = git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const result = await execute(input(f, { output: "pr" }, { resume: commits === 2 }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
    assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
    const run = held(f, result, count);
    assert.ok(result.output.summary.includes(`and the pull request would carry them. The base must be pushed first; nothing was changed. Checked commit: ${f.head}. Evidence: `));
    assert.deepEqual([run.delivery.outcome, run.delivery.worktreeCreated, run.delivery.commit, run.result.agentInvocations], ["refused", false, null, 0]);
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
  held(f, behind, /^Refused: Base release has 3 unpublished local commits that are not in release on origin, .+ must be pushed first/u);
  git(f.repo, "branch", "local-only");
  const missing = await execute(input({ ...f, evidence: join(f.root, "evidence-missing") }, { output: "pr", base: "local-only" }), agents);
  assert.match(missing.output.summary, /^Refused: The pull request base local-only on origin does not exist, so the base cannot be shown to be published\. Push it first/u);
  assert.deepEqual([behind.states, missing.states], [["shape", "prepare", "refuse", "refused"], ["shape", "prepare", "refuse", "refused"]]);
  assert.equal(pushed(), published); assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "local-only\nmain\nrelease"); untouched(f);
});

test("a pr run whose remote cannot be reached is refused before any Agent with the saved log", async context => {
  const f = fixture(context); const gh = fakeGh(context, f);
  git(f.repo, "remote", "add", "origin", join(f.root, "no-such-remote.git"));
  const result = await execute(input(f, { output: "pr" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
  const run = held(f, result, /^Refused: Remote origin could not be reached to check that the base is published; nothing was changed; inspect .+git-ls-remote\.log/u);
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
  const commit = merged(f, result).delivery.commit; untouched(f);
  assert.equal(git(f.repo, "rev-parse", `${commit}^`), tip);
  assert.deepEqual(pushed.atCheck().split("\n"), [`refs/heads/main ${tip}`, `refs/heads/${branch} ${commit}`]); assert.equal(pushed(), `refs/heads/main ${tip}`);
  // Reading the remote's tip moved no local ref and left no FETCH_HEAD behind; the ticket branch it made is gone with the merge.
  assert.equal(git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.equal(existsSync(join(f.repo, ".git/FETCH_HEAD")), false);
});

/** Someone else publishes a commit that adds `<name>.txt` on the remote's main from a clone of their own, which the source checkout never fetches; returns the remote's new tip. */
function publishElsewhere(f: Fixture, name = "remote") {
  const other = join(f.root, "other");
  if (!existsSync(other)) git(f.root, "clone", "-q", join(f.root, "remote.git"), other);
  writeFileSync(join(other, `${name}.txt`), `${name}\n`); git(other, "add", ".");
  git(other, "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-q", "-m", `published by someone else: ${name}.txt`);
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}
/** What prepare recorded when a pr run took the remote's tip in place of a local base that was behind it. */
const baseRecord = (run: { directory: string }) => JSON.parse(readFileSync(join(run.directory, "base.json"), "utf8"));
const fetchHead = (f: Fixture) => existsSync(join(f.repo, ".git/FETCH_HEAD"));
const allRefs = (f: Fixture) => git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)");
const runStates = (output: string) => ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success",
  ...(output === "pr" ? ["checkMerge", "cleanUp", "merged"] : ["delivered"])];

for (const base of [undefined, "main"] as const) {
  test(`a fresh pr run whose ${base ? "named" : "omitted"} base is one commit behind the remote makes its worktree from the remote tip and names both commits in base.json`, async context => {
    const f = fixture(context); const pushed = remote(f); fakeGh(context, f); const tip = publishElsewhere(f); const refs = allRefs(f); const seen: string[] = [];
    const result = await execute(input(f, { output: "pr", ...(base ? { base } : {}) }), {
      tester: request => { seen.push(git(request.cwd, "rev-parse", "HEAD")); return tester(request); },
      implementer: request => { seen.push(git(request.cwd, "rev-parse", "HEAD")); assert.equal(readFileSync(join(request.cwd, "remote.txt"), "utf8"), "remote\n"); return implement(request); },
    });
    const tail = runStates("pr").slice(runStates("pr").indexOf("reviewResult"));
    assert.deepEqual(result.states.slice(-tail.length), tail);
    const run = merged(f, result); untouched(f);
    // The worktree was made from the remote's tip, so the Agents worked on it and delivery did not need to replay.
    assert.deepEqual(seen, [tip, tip]);
    const commit = onTip(f, tip, run.delivery.commit);
    assert.deepEqual([run.delivery.baseCommit, run.delivery.rebasedFrom, phases(run)], [tip, undefined, ["red", "verify"]]);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", commit), "greeting.test.txt\ngreeting.txt");
    // The prepare evidence names the local base that was behind and the tip used in its place.
    assert.deepEqual(baseRecord(run), { ref: base ?? "HEAD", local: f.head, remote: "origin", branch: "main", tip });
    // The local base branch did not move, no other ref did, and no FETCH_HEAD was left behind.
    assert.equal(git(f.repo, "rev-parse", "main"), f.head); assert.equal(allRefs(f), refs); assert.equal(fetchHead(f), false);
    assert.equal(pushed(), `refs/heads/main ${tip}`);
  });
}

test("a resumed pr run whose saved base is behind the remote tip moves onto the tip, not onto the local base, and names both commits in base.json", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f); const again = await handOff(f);
  // The run was handed off on the local base, which is also the remote's; then someone else publishes a commit the source checkout never fetches.
  const tip = publishElsewhere(f); const refs = others(f);
  const result = await execute(input(again, { output: "pr" }, { resume: true }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => {
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(readFileSync(join(request.cwd, "remote.txt"), "utf8"), "remote\n");
      assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), "hello\n"); return review();
    },
  });
  assert.deepEqual(result.states, runStates("pr"));
  const run = merged(again, result); untouched(f);
  const commit = onTip(f, tip, run.delivery.commit);
  assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", commit), "code.txt\ngreeting.test.txt\ngreeting.txt\nremote.txt");
  // The move happened in prepare, before checks and approval, so delivery did not replay.
  assert.deepEqual([run.delivery.baseCommit, run.delivery.resumed, run.delivery.rebasedFrom, phases(run)], [tip, true, undefined, ["verify"]]);
  assert.deepEqual(baseRecord(run), { ref: "HEAD", local: f.head, remote: "origin", branch: "main", tip });
  assert.equal(git(f.repo, "rev-parse", "main"), f.head); assert.equal(others(f), refs); assert.equal(fetchHead(f), false);
  assert.equal(pushed(), `refs/heads/main ${tip}`);
});

test("a resumed pr run whose branch was started from the remote tip is adopted while the local base stays behind, and is not moved", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f); const tip = publishElsewhere(f);
  const first = await execute(input(f, { output: "pr" }, { maxRepairs: 0, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, person("hand off"));
  assert.equal(first.state, "handedOff"); assert.equal(git(f.repo, "rev-parse", branch), tip); assert.equal(git(f.repo, "rev-parse", "main"), f.head);
  const again = next(f, 2); const refs = others(f); const calls = recordGit(context, f);
  const result = await execute(input(again, { output: "pr" }, { resume: true }), {
    investigator: () => assert.fail(), implementer: () => assert.fail(),
    reviewer: request => { assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); return review(); },
  });
  assert.deepEqual(result.states, runStates("pr"));
  const run = merged(again, result); untouched(f);
  onTip(f, tip, run.delivery.commit);
  assert.deepEqual([run.delivery.baseCommit, run.delivery.resumed, run.delivery.rebasedFrom, phases(run)], [tip, true, undefined, ["verify"]]);
  // Nothing was moved: no candidate was set aside for a move, and nothing was replayed.
  assert.deepEqual(savedRefs(f), []); assert.equal(calls().some(call => /(?:^|\s)rebase\s/u.test(call)), false);
  assert.equal(git(f.repo, "rev-parse", "main"), f.head); assert.equal(others(f), refs); assert.equal(fetchHead(f), false);
  assert.equal(pushed(), `refs/heads/main ${tip}`);
});

test("a pr run started from the remote tip replays onto a later remote tip at delivery while the local base stays behind", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f); const started = publishElsewhere(f); let tip = "";
  const result = await execute(input(f, { output: "pr" }), {
    reviewer: request => { assert.equal(git(request.cwd, "rev-parse", "HEAD"), started); tip = publishElsewhere(f, "later"); return review(); },
  });
  const tail = runStates("pr").slice(runStates("pr").indexOf("reviewResult"));
  assert.deepEqual(result.states.slice(-tail.length), tail);
  const run = merged(f, result); untouched(f);
  const commit = onTip(f, tip, run.delivery.commit); rebasedFrom(f, run, started);
  assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", commit), "code.txt\ngreeting.test.txt\ngreeting.txt\nlater.txt\nremote.txt");
  assert.deepEqual([run.delivery.baseCommit, phases(run)], [tip, ["red", "verify", "reverify"]]);
  assert.equal(git(f.repo, "rev-parse", "main"), f.head); assert.equal(fetchHead(f), false);
  assert.equal(pushed(), `refs/heads/main ${tip}`);
});

test("a pr run started from the remote tip is not delivered when the remote moves back below it: the commit is undone and the run asks only hand off or discard", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const started = publishElsewhere(f); let before: Candidate | undefined; const human = person("hand off");
  const result = await execute(input(f, { output: "pr" }), {
    reviewer: request => { before = candidate(request.cwd); git(join(f.root, "other"), "push", "-q", "-f", "origin", `${f.head}:main`); return review(); },
  }, human);
  const run = steppedOff(f, result, "rebase", "keepDecide", /Base \S+ was rewritten or moved back to \S+; the ticket must be delivered by hand\./u, human); untouched(f);
  assert.deepEqual(result.states.slice(-7, -5), ["reviewResult", "commit"]); assert.match(run.delivery.reason, /^Base /u);
  assert.ok(names(run.delivery.reason, started), "the reason names the remote tip the run started from");
  assert.ok(names(run.delivery.reason, f.head), "the reason names the remote's tip now");
  uncommitted(f, run, started, before!);
  assert.equal(git(f.repo, "rev-parse", "main"), f.head); assert.equal(pushed(), ""); assert.equal(gh(), undefined);
});

test("a pr run started from the remote tip keeps its candidate uncommitted when the remote cannot be read again at delivery", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f); const started = publishElsewhere(f);
  const calls = recordGit(context, f); const human = person("hand off"); let before: Candidate | undefined;
  const unavailable = join(f.root, "unavailable.git");
  const result = await execute(input(f, { output: "pr" }), {
    reviewer: request => { before = candidate(request.cwd); renameSync(join(f.root, "remote.git"), unavailable); return review(); },
  }, human);
  const run = questionedIn("rebase", f, result, /cannot be shown to be published on main at origin; the base must be pushed first/u, human);
  assert.ok(run.delivery.reason.includes(started)); uncommitted(f, run, started, before!); untouched(f);
  assert.match(readFileSync(join(run.directory, "rebase-1-ls-remote.log"), "utf8"), /does not appear to be a git repository/u);
  assert.equal(calls().filter(call => call.startsWith("ls-remote ")).length, 2);
  assert.equal(git(f.repo, "rev-parse", "main"), f.head); assert.equal(fetchHead(f), false); assert.equal(gh(), undefined);
  assert.equal(git(unavailable, "for-each-ref", "--format=%(refname) %(objectname)"), `refs/heads/main ${started}`);
});

test("a resumed pr run whose branch holds a commit in neither the local base nor the remote tip is refused with today's message", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const tip = publishElsewhere(f);
  linked(f); implement({ cwd: f.worktree }); git(f.worktree, "add", "."); git(f.worktree, "commit", "-qm", "earlier commit");
  const own = git(f.repo, "rev-parse", branch); const refs = allRefs(f);
  const result = await execute(input(f, { output: "pr" }, { resume: true }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
  held(f, result, /^Refused: Cannot resume: ticket\/proj-12-add-a-greeting holds 1 commit that is not in the base commit .+ or the base moved back; only an uncommitted candidate is resumed, and nothing was changed\. Evidence: /u);
  assert.equal(git(f.repo, "rev-parse", branch), own); assert.equal(allRefs(f), refs); assert.equal(pushed(), `refs/heads/main ${tip}`); assert.equal(gh(), undefined);
});

test("a pr run whose local base has a commit the remote lacks is refused with today's message, also when the remote has moved on", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const tip = publishElsewhere(f); ahead(f, 1); const refs = allRefs(f);
  const result = await execute(input(f, { output: "pr" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
  const run = held(f, result, /^Refused: Base HEAD has 1 unpublished local commit that is not in the default branch main on origin, /u);
  assert.ok(result.output.summary.includes(`and the pull request would carry them. The base must be pushed first; nothing was changed. Checked commit: ${f.head}. Evidence: `));
  assert.equal(existsSync(f.worktree), false); assert.equal(existsSync(join(run.directory, "base.json")), false);
  assert.equal(allRefs(f), refs); assert.equal(pushed(), `refs/heads/main ${tip}`); assert.equal(gh(), undefined);
});

test("a pr run whose local base is the remote tip starts from it and writes no base.json", async context => {
  const f = fixture(context); const pushed = remote(f); fakeGh(context, f); const seen: string[] = [];
  const result = await execute(input(f, { output: "pr" }), { implementer: request => { seen.push(git(request.cwd, "rev-parse", "HEAD")); return implement(request); } });
  const run = merged(f, result); untouched(f);
  assert.deepEqual(seen, [f.head]); onTip(f, f.head, run.delivery.commit);
  assert.deepEqual([run.delivery.baseCommit, run.delivery.rebasedFrom], [f.head, undefined]);
  assert.equal(existsSync(join(run.directory, "base.json")), false); assert.equal(pushed(), "");
});

for (const output of ["branch", "patch"] as const) {
  test(`a ${output} run whose local base is behind the remote starts from the local base, never asks the remote, and writes no base.json`, async context => {
    const f = fixture(context); const pushed = remote(f); const tip = publishElsewhere(f); const calls = recordGit(context, f); const seen: string[] = [];
    const result = await execute(input(f, { output }), { implementer: request => { seen.push(git(request.cwd, "rev-parse", "HEAD")); return implement(request); } });
    assert.equal(result.state, "delivered"); assert.deepEqual(result.states.slice(-5), runStates(output).slice(-5));
    const run = held(f, result, /^Delivered/u); untouched(f);
    assert.deepEqual(seen, [f.head]); onTip(f, f.head);
    assert.deepEqual([run.delivery.baseCommit, run.delivery.rebasedFrom], [f.head, undefined]);
    assert.deepEqual(calls().filter(call => /^(?:ls-remote|fetch|push|pull|clone|remote)\b/u.test(call)), []);
    assert.equal(existsSync(join(run.directory, "base.json")), false);
    assert.throws(() => git(f.repo, "cat-file", "-e", tip)); assert.equal(pushed(), `refs/heads/main ${tip}`);
  });
}

for (const output of ["branch", "patch", "pr"]) {
  test(`${output} delivery ${output === "pr" ? "asks the remote about the base before anything else" : "never queries the remote, whatever the base holds"}`, async context => {
    const f = fixture(context); const pushed = remote(f); ahead(f, 2); const calls = recordGit(context, f);
    const result = await execute(input(f, { output }));
    const network = calls().filter(call => /^(?:ls-remote|fetch|push|pull|clone|remote)\b/u.test(call));
    assert.ok(calls().some(call => call.startsWith("rev-parse --verify --quiet HEAD^{commit}")));
    assert.equal(pushed(), "");
    if (output === "pr") {
      assert.equal(result.state, "refused");
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
    test(`${policy ?? "default"} stuck policy asks its one question on ${cause} and preserves the candidate`, async context => {
      const f = fixture(context); const human = person("hand off"); let before: unknown; let reviews = 0;
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
          return cause === "review budget" ? ownerReview("Specify the greeting language") : ok("blocked", "Specify the greeting language");
        },
      }, human);
      const run = questioned(f, result, reason, human); assert.deepEqual(candidate(f.worktree), before);
      assert.equal(candidate(f.worktree).status.includes("greeting.txt"), !early);
      if (early) {
        assert.deepEqual(result.states.filter(isPlanning), upTo(cause.split(" ")[0]!));
        // The read-only state that edited still reported, and its report is counted with the others.
        assert.deepEqual(run.result.agents.map((agent: any) => agent.stage), upTo(cause.split(" ")[0]!));
        assert.equal(run.result.agentInvocations, upTo(cause.split(" ")[0]!).length);
        assert.ok(existsSync(join(run.directory, `agent-${run.result.agentInvocations}.json`)));
      }
      if (cause === "discussion" || cause === "criterion") assert.equal(reviews, 2);
      if (cause === "discussion") assert.deepEqual(numberedLines(run.needs.split("\n")), ["1. Which locale? (greeting.txt:1)"]);
      // The question gives the budgets as the note did.
      assert.ok(run.prompt.includes("Repair rounds used: 0 of 0."));
      assert.ok(run.prompt.includes(`Review rounds used: ${cause === "discussion" || cause === "criterion" ? 1 : 0} of ${cause === "review budget" ? 0 : 2}.`));
    });
  }
}

test("a long blocker is capped in what the question says is needed and kept whole in the receipt", async context => {
  const f = fixture(context); const human = person("hand off"); let before: unknown;
  const reason = `Specify the greeting language.\n${"More context.\n".repeat(230)}`.trim();
  const result = await execute(input(f, {}, { stuck: "park" }), {
    reviewer: request => { before = candidate(request.cwd); return ok("blocked", reason); },
  }, human);
  const run = questioned(f, result, /Specify the greeting language/u, human);
  const needs = `${oneLine(reason.slice("Specify the greeting language.".length))}`.slice(0, 600) + "…";
  assert.equal(run.needs, `Specify the greeting language.\n${needs}`);
  assert.equal(run.delivery.reason, reason);
  assert.equal(Object.keys(run.delivery)[0], "schemaVersion");
  assert.equal(run.prompt.split("\n").find(line => line.startsWith("Needs: ")), `Needs: ${needs}`);
  assert.deepEqual(candidate(f.worktree), before);
});

for (const exhausted of ["review", "gates"]) {
  test(`${exhausted} budget exhausts independently after two retries of the other kind`, async context => {
    const f = fixture(context); const human = person("hand off"); let edits = 0; let reviews = 0; let before: unknown;
    const result = await execute(input(f, { checks: [command('process.exit(require("fs").readFileSync("greeting.txt", "utf8") === "fail" ? 1 : 0)')] }, {
      stuck: "park", maxRepairs: exhausted === "gates" ? 2 : 3, maxReviewRounds: exhausted === "review" ? 2 : 3,
    }), {
      implementer: request => {
        edits++;
        writeFileSync(join(request.cwd, "greeting.txt"), (exhausted === "review" ? edits <= 2 : edits >= 3) ? "fail" : "hello\n");
        before = candidate(request.cwd); return ok();
      },
      reviewer: () => ownerReview(`Finding ${++reviews}`),
    }, human);
    const run = questioned(f, result, exhausted === "review" ? /Review budget exhausted \(2\)/u : /Repair budget exhausted \(2\)/u, human);
    assert.match(run.needs, exhausted === "review" ? /^Review budget used up \(2 of 2\)\.\n/u : /^Repair budget used up \(2 of 2\)\.\n/u);
    assert.deepEqual([edits, reviews], [5, exhausted === "review" ? 3 : 2]);
    assert.deepEqual([run.result.repairs, run.result.reviewRounds], [2, 2]);
    assert.ok(run.prompt.includes(`Repair rounds used: 2 of ${exhausted === "gates" ? 2 : 3}.`));
    assert.ok(run.prompt.includes(`Review rounds used: 2 of ${exhausted === "review" ? 2 : 3}.`));
    assert.deepEqual(run.result.checks.map(check => check.passed), exhausted === "review" ? [true, false, false, false, false, true, true, true] : [true, true, true, false, false, false, false, false, false]);
    assert.deepEqual(candidate(f.worktree), before);
  });
}

test("a candidate handed off at the question resumes with fresh budgets and an approving reviewer delivers it", async context => {
  const f = fixture(context); const human = person("hand off");
  const first = await execute(input(f, {}, { stuck: "park", maxReviewRounds: 0 }), { reviewer: () => ownerReview("Which language?") }, human);
  questioned(f, first, /Review budget exhausted \(0\)/u, human);
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
  assert.equal(existsSync(f.worktree), false); assert.equal(human.requests.length, 1);
});

for (const [label, stop] of [
  ["falsify questions", { falsify: () => ({ type: "questions", summary: "The ticket leaves the language open", questions: [language] }) }],
  ["a second plan revision", { planReview: () => ok("revise", "The plan names no test") }],
] as const) {
  test(`a run handed off at the question on ${label} leaves no change, and resume starts again at falsify with the amended ticket instead of going to scopeAfterChange`, async context => {
    const f = fixture(context); const human = person("hand off");
    const first = await execute(input(f, { setup: [command('console.log("installed")', { name: "install" })] }, { stuck: "park" }), {
      ...stop, tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    questioned(f, first, /\S/u, human);
    // Nothing to resume from: the branch is at its base and the worktree holds what the base holds.
    assert.deepEqual(candidate(f.worktree), { status: "", files: [["code.txt", 0, Buffer.from("old").toString("base64")]] });
    assert.equal(git(f.worktree, "rev-parse", "HEAD"), f.head);
    const again = { ...f, evidence: join(f.root, "evidence-resumed") };
    // The worktree was set up when it was made; a resumed run does not set it up again.
    const data = input(again, { setup: [command("process.exit(1)", { name: "install" })] }, { resume: true, stuck: "park" });
    data.ticket.body += "\n\nThe greeting language is English.";
    const prompts: Record<string, string> = {};
    const result = await execute(data, {
      falsify: request => { prompts.falsify = request.prompt; return planning.falsify!.answer(request); },
      plan: request => { prompts.plan = request.prompt; return planning.plan!.answer(request); },
      tester: request => { prompts.tester = request.prompt; return tester(request); },
      implementer: request => { prompts.implementer = request.prompt; return implement(request); },
    }, human);
    assert.equal(result.state, "delivered", evidence(again).delivery.reason);
    assert.deepEqual(result.states.slice(0, 2), ["shape", "prepare"]); assert.notEqual(result.states[2], "scopeAfterChange");
    assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "test", "change", "review"]);
    // The ticket may have changed while it was handed off, so it is falsified and planned as it reads now.
    for (const state of ["falsify", "plan"]) assert.match(prompts[state]!, /The greeting language is English/u, state);
    for (const role of ["tester", "implementer"]) assert.ok(planIn(prompts[role]!).startsWith(`${plan}\n`), role);
    const run = held(again, result, /^Delivered/u); untouched(f);
    assert.deepEqual([run.delivery.outcome, run.delivery.resumed, run.delivery.worktreeCreated, run.delivery.worktreeRemoved], ["delivered", true, false, true]);
    assert.equal(run.result.checks.some((check: any) => check.phase === "setup"), false);
    assert.deepEqual(run.result.agents.map((agent: any) => agent.stage), ["falsify", "plan", "planReview", "test", "change", "review"]);
    assert.equal(git(f.repo, "rev-parse", `${branch}^`), f.head); assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
    assert.equal(existsSync(f.worktree), false); assert.equal(human.requests.length, 1);
  });
}

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
  test(`already passing tests return to the tester and ${fixes ? "deliver after repair" : "ask when repairs exhaust"}`, async context => {
    const f = fixture(context); let tests = 0; let edits = 0; const human = person(...(fixes ? [] : ["hand off"]));
    const result = await execute(input(f, {}, { maxRepairs: 1, stuck: "park" }), {
      tester: request => {
        if (++tests > 1) assert.match(request.prompt, /red: tests passed; the tests do not yet test anything new/u);
        if (fixes && tests > 1) return tester(request);
        writeFileSync(join(request.cwd, "greeting.test.txt"), "// no assertion yet\n"); return ok();
      },
      implementer: request => { edits++; assert.equal(tests, 2); return implement(request); },
    }, human);
    assert.deepEqual([tests, edits], [2, fixes ? 1 : 0]);
    assert.deepEqual(result.states.slice(result.states.indexOf("test")).slice(0, 8), ["test", "scopeAfterTest", "red", "repairBudget", "repairTarget", "test", "scopeAfterTest", "red"]);
    const run = fixes ? held(f, result, /^Delivered/u) : questioned(f, result, /Repair budget exhausted \(1\).*tests passed/u, human);
    assert.equal(result.state, fixes ? "delivered" : "handedOff");
    assert.deepEqual(run.result.checks.filter(check => check.phase === "red").map(check => [check.expected, check.passed]), [["nonzero exit", false], ["nonzero exit", fixes]]);
    assert.equal(run.result.repairs, 1);
  });
}

for (const evidenceOnly of [false, true]) {
  test(`a tester changing ${evidenceOnly ? "only .machine-runs" : "nothing"} cannot prove red`, async context => {
    const f = fixture(context); const human = person("hand off");
    const result = await execute(input(f, { checks: [command("process.exit(1)")] }, { maxRepairs: 0, stuck: "park" }), {
      tester: request => {
        if (evidenceOnly) { mkdirSync(join(request.cwd, ".machine-runs")); writeFileSync(join(request.cwd, ".machine-runs/test.json"), "{}"); }
        return ok();
      }, implementer: () => assert.fail(),
    }, human);
    questioned(f, result, /the tester changed nothing/u, human);
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
    const human = person("hand off");
    const result = await execute(data, { implementer: request => { git(request.cwd, "mv", "code.txt", "renamed file.txt"); return implement(request); } }, human);
    const outside = allowed === "code.txt" ? "renamed file.txt" : "code.txt";
    const run = questioned(f, result, /Paths outside the ticket Scope/u, human);
    assert.deepEqual(JSON.parse(readFileSync(join(run.directory, "scope-1.json"), "utf8")), { stage: "change", changed: ["code.txt", "greeting.txt", "renamed file.txt"], outside: [outside] });
  });
}

test("scope status preserves spaces, newlines, and literal quotes in paths", async context => {
  const f = fixture(context); const name = ' a\n"b".txt '; const human = person("hand off");
  const result = await execute(input(f, {}, { redGreen: false, maxRepairs: 0, stuck: "park" }), {
    implementer: request => { writeFileSync(join(request.cwd, name), "outside"); return implement(request); },
  }, human);
  const run = questioned(f, result, /Paths outside the ticket Scope/u, human);
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

/** A gate that fails its first run and passes after it, printing and counting each run in a file outside every checkout. */
function flakyGate(f: Fixture, name = "lint") {
  const file = join(f.root, `${name}-runs`);
  const code = `const fs = require("fs"); const runs = (fs.existsSync(process.argv[1]) ? Number(fs.readFileSync(process.argv[1], "utf8")) : 0) + 1;
fs.writeFileSync(process.argv[1], String(runs)); console.log(${JSON.stringify(name)} + " run " + runs); process.exit(runs === 1 ? 1 : 0);`;
  return { gate: { name, command: [process.execPath, "-e", code, file] }, runs: () => existsSync(file) ? Number(readFileSync(file, "utf8")) : 0 };
}

test("a gate that fails once and passes when run again alone is delivered as passed, marked flaky in the receipt and the pull request body, without a repair round", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f); const lint = flakyGate(f); let edits = 0;
  const result = await execute(input(f, { output: "pr", checks: [command(), lint.gate] }), { implementer: request => { edits++; return implement(request); } });
  const run = merged(f, result);
  assert.deepEqual([edits, lint.runs(), run.result.repairs, run.result.checksPassed], [1, 2, 0, true]);
  assert.deepEqual(run.result.checks.map((check: any) => [check.phase, check.name, check.passed, check.flaky === true]),
    [["red", "tests", true, false], ["verify", "tests", true, false], ["verify", "lint", false, true], ["verify", "lint", true, true]]);
  // Both outputs are kept.
  assert.match(readFileSync(run.result.checks[2].log, "utf8"), /lint run 1/u); assert.match(readFileSync(run.result.checks[3].log, "utf8"), /lint run 2/u);
  assert.equal(readFileSync(join(run.directory, "pull-request.md"), "utf8"),
    "Add a greeting\n\n## Summary\n\nWrite hello to greeting.txt.\n\n## Checks\n\n- tests: passed\n- lint: passed (flaky: failed once, passed when run again alone)\n\n## Review\n\nGreeting matches the ticket\n\nTicket: PROJ-12\n");
});

test("repository.rerunFailedChecks: false runs each gate once, so a gate that would pass the second time takes a repair round, as today", async context => {
  const f = fixture(context); const lint = flakyGate(f); let edits = 0;
  const result = await execute(input(f, { checks: [command(), lint.gate], rerunFailedChecks: false }), { implementer: request => { edits++; return implement(request); } });
  assert.equal(result.state, "delivered");
  const run = evidence(f);
  assert.deepEqual([edits, lint.runs(), run.result.repairs, run.result.checksPassed], [2, 2, 1, true]);
  assert.deepEqual(run.result.checks.map((check: any) => [check.phase, check.name, check.passed, check.flaky === true]),
    [["red", "tests", true, false], ["verify", "tests", true, false], ["verify", "lint", false, false], ["verify", "tests", true, false], ["verify", "lint", true, false]]);
});

test("a non-boolean repository.rerunFailedChecks is refused before execution, by its full name", context => {
  const f = fixture(context);
  for (const value of ["no", 1, null]) {
    const data: any = input(f); data.repository.rerunFailedChecks = value;
    assert.throws(() => mod.default(runtime, data), /repository\.rerunFailedChecks must be a boolean/u);
  }
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
    const f = fixture(context); const human = person("hand off");
    const result = await execute(input(f, { checks: [check] }, { maxRepairs: 0, stuck: "park" }), { implementer: () => assert.fail() }, human);
    const run = questioned(f, result, /red: tests did not meet its expected result/u, human);
    assert.deepEqual(run.result.checks.map(check => [check.phase, check.expected, check.passed]), [["red", "nonzero exit", false]]);
  });
}

test("red rejects a check that changes the candidate", async context => {
  const f = fixture(context); const human = person("hand off");
  const result = await execute(input(f, { checks: [command('require("fs").writeFileSync("greeting.test.txt", "weakened"); process.exit(1)')] }, { maxRepairs: 0, stuck: "park" }), { implementer: () => assert.fail() }, human);
  questioned(f, result, /red check changed the checkout/u, human);
});

test("ticketSections takes a backticked span as the Scope pattern, so an annotated bullet still matches", () => {
  const body = "## Goal\nG\n## Scope\n- `src/**` (the runtime)\n- tests/\n## Acceptance\n- a\n## Forbidden\n- f\n";
  assert.deepEqual(mod.ticketSections(body).scope, ["src/**", "tests/"]);
});

test("a resumed candidate is held to the Scope before it is verified", async context => {
  const f = fixture(context); const again = await handOff(f);
  writeFileSync(join(f.worktree, "other.txt"), "outside\n");
  const result = await execute(input(again, {}, { resume: true, maxRepairs: 0, stuck: "park" }), { investigator: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail() }, person("hand off"));
  assert.equal(result.state, "handedOff");
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

/** What the decision prompt says `more rounds` does: the text of that option's own line. */
const moreRounds = (request: Ask) => request.prompt.split("\n").find(line => line.startsWith("more rounds: ")) ?? "";

test("more rounds after the implementer returned blocked returns to the implementer, as the decision says, not to the tester whose red was the last gate", async context => {
  const f = fixture(context); const human = person("more rounds"); let tests = 0; let edits = 0;
  const result = await execute(input(f, {}, { stuck: "ask" }), {
    tester: request => { tests++; return tester(request); },
    implementer: request => { assert.equal(tests, 1, "the tester is not asked again when the implementer is the one that stopped"); return ++edits === 1 ? ok("blocked", "Required API specification unavailable") : implement(request); },
  }, human);
  // Red passed before the implementer stopped; the stage that stopped is the one more rounds repairs.
  assert.deepEqual(result.states.slice(result.states.indexOf("red")).slice(0, 6), ["red", "change", "stuck", "decide", "repairTarget", "change"]);
  assert.equal(result.state, "delivered");
  assert.deepEqual([tests, edits, human.requests.length], [1, 2, 1]);
  assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "test", "change", "decide", "change", "review"]);
  assert.match(human.requests[0]!.prompt, /Stopped in change\./u); assert.match(human.requests[0]!.prompt, /specification unavailable/u);
  assert.match(moreRounds(human.requests[0]!), /send the standing findings back to the implementer/u);
  const run = held(f, result, /^Delivered/u); untouched(f);
  assert.deepEqual([run.delivery.decision, phases(run), run.result.agents.map((agent: any) => agent.stage).filter((stage: string) => !isPlanning(stage))],
    ["more rounds", ["red", "verify"], ["test", "change", "change", "review"]]);
});

test("more rounds after the tester returned blocked returns to the tester, and the decision names the tester, not the implementer", async context => {
  const f = fixture(context); const human = person("more rounds"); let tests = 0; let edits = 0;
  const result = await execute(input(f, {}, { stuck: "ask" }), {
    tester: request => ++tests === 1 ? ok("blocked", "Acceptance criteria are missing") : tester(request),
    implementer: request => { edits++; assert.equal(tests, 2, "the implementer works only from tests the tester wrote"); return implement(request); },
  }, human);
  assert.deepEqual(result.states.slice(result.states.indexOf("test")).slice(0, 7), ["test", "stuck", "decide", "repairTarget", "test", "scopeAfterTest", "red"]);
  assert.equal(result.state, "delivered");
  assert.deepEqual([tests, edits, human.requests.length], [2, 1, 1]);
  assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "test", "decide", "test", "change", "review"]);
  assert.match(human.requests[0]!.prompt, /Stopped in test\./u); assert.match(human.requests[0]!.prompt, /Acceptance criteria are missing/u);
  // The option says where the work goes, so it cannot name the implementer when the tester is the one sent back.
  assert.match(moreRounds(human.requests[0]!), /\btester\b/u); assert.doesNotMatch(moreRounds(human.requests[0]!), /\bimplementer\b/u);
  const run = held(f, result, /^Delivered/u); untouched(f);
  assert.deepEqual([run.delivery.decision, phases(run)], ["more rounds", ["red", "verify"]]);
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

// The catalog is the ticket-task reference; the README summarizes it and links there.
for (const path of ["docs/catalog.md"]) {
  test(`${path} describes one round for discussions followed by all open owner questions, numbered in the stuck question`, () => {
    const prose = readFileSync(resolve(path), "utf8").replace(/\s+/gu, " ");
    assert.doesNotMatch(prose, /repeated (?:discussion|owner questions|questions)|repeating the question/iu, `${path} still describes escalation by repeated text`);
    assert.match(prose, /\bone (?:implementation |implementer |repair )?round\b/iu, `${path} must describe the implementer's first round with discussions`);
    assert.match(prose, /(?:next|following|previous|consecutive) review/iu, `${path} must describe escalation by review position`);
    assert.match(prose, /\b(?:all|every)\b[^.]{0,160}\b(?:discussion|question)|\b(?:discussion|question)[^.]{0,160}\btogether\b/iu, `${path} must describe taking all current questions to the owner`);
    assert.match(prose, /numbered/iu, `${path} must describe the numbered questions`);
    assert.match(prose, /600/iu, `${path} must describe the cap for each question`);
  });
}

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

test("the catalog describes rebase, reverify, rebasedFrom, and the invariant that no stop leaves a commit", () => {
  const catalog = readFileSync(resolve("docs/catalog.md"), "utf8");
  const named = catalog.split("\n").filter(line => line.startsWith("| `")).flatMap(line => line.split("|")[1]!.split(",").map(name => name.trim()));
  assert.ok(named.includes("`rebase`"), "rebase has no row in the state table");
  // Prose wraps where it will; the words are looked for across line breaks.
  const prose = catalog.replace(/\s+/gu, " ");
  for (const described of [/`rebase`/u, /`reverify`/u, /`rebasedFrom`/u]) assert.match(prose, described);
  assert.match(prose, /never stops with (?:\S+ ){1,4}commit on the ticket branch/iu, "the catalog does not state the invariant");
  // A base that moved is rebased onto now, so the catalog may not still say the candidate is delivered on the older commit as it is.
  assert.doesNotMatch(prose, /without rebasing|nothing is rebased|or rebase a candidate onto a base that moved/iu);
  // A rewritten or moved-back base asks to be handed off for delivery by hand, and adopt goes on refusing such a branch.
  assert.match(prose, /moved back|rewritten/iu); assert.match(prose, /by hand/iu);
});

/** The sentences and table rows of a document, each on one line, so that a claim is looked for where it is made and not across the file. */
const statements = (text: string) => text.split(/\n(?=\|)|\n{2,}/u).flatMap(block => block.replace(/\s+/gu, " ").split(/(?<=\.)\s/u));
test("the catalog, the ticket-task page, and the README describe waiting for the merge: the merged final state, its complete output, and the sleep between checks", () => {
  for (const path of ["docs/catalog.md", "docs/workflows/ticket-task.md", "README.md"]) {
    const text = readFileSync(resolve(path), "utf8"); const prose = text.replace(/\s+/gu, " ");
    assert.doesNotMatch(prose, /output is always `\{ ?"action": ?"hold"/u, `${path} still says the output is always hold`);
    assert.match(prose, /"action": ?"complete"/u, `${path} must give the output a merged pull request completes with`);
    assert.ok(statements(text).some(said => /`merged`/u.test(said) && /\bcomplete\b/u.test(said)), `${path} must say in one sentence or table row that merged ends with complete`);
    assert.ok(statements(text).some(said => /\bsleeps?\b/iu.test(said) && /\bmerge/iu.test(said)), `${path} must say that the run sleeps while it waits for the merge`);
  }
  for (const path of ["docs/catalog.md", "docs/workflows/ticket-task.md"]) {
    const text = readFileSync(resolve(path), "utf8");
    assert.ok(statements(text).some(said => /\b(?:10|ten) minutes\b|`10m`/iu.test(said) && /\bgh\b|pull request/iu.test(said)), `${path} must say the pull request is checked every 10 minutes`);
  }
  const catalog = readFileSync(resolve("docs/catalog.md"), "utf8");
  assert.ok(statements(catalog).some(said => /\bfinal states?\b/iu.test(said) && /`merged`/u.test(said)), "the catalog must list merged among the final states");
});
for (const path of ["docs/catalog.md"]) {
  test(`${path} no longer says planning needs are kept in full, and gives falsify questions the limits of any open question`, () => {
    const text = readFileSync(resolve(path), "utf8");
    assert.doesNotMatch(text.replace(/\s+/gu, " "), /questions are kept in full|reviewer's summary in full|exact questions as `needs`|exact `needs`/iu, `${path} still says planning needs are kept in full`);
    assert.ok(statements(text).some(said => /falsif|planning questions?/iu.test(said) && /\b600\b|\bnumbered\b|\bcapped\b|\bsame (?:limits?|caps?)\b/iu.test(said)),
      `${path} must say in one sentence or table row that falsify questions are numbered and capped at 600 characters like any open question`);
  });
  test(`${path} says a resumed worktree that holds no change starts again at falsify`, () => {
    const text = readFileSync(resolve(path), "utf8");
    assert.ok(statements(text).some(said => /resum/iu.test(said) && /falsif/iu.test(said)
      && /\bclean\b|\bno (?:uncommitted )?changes?\b|\bholds? no(?:thing)?\b|\bno candidate\b|\bwithout a candidate\b|\bat its base\b/iu.test(said)),
      `${path} must say in one sentence or table row that resume starts again at falsify when the worktree is clean at its base, with no candidate`);
    assert.doesNotMatch(text.replace(/\s+/gu, " "), /a resumed run goes straight to|it skips `falsify`/iu, `${path} still says every resumed run skips falsify`);
  });
  test(`${path} describes what a falsify question carries, the assume input and its default, and where assumptions are recorded`, () => {
    const text = readFileSync(resolve(path), "utf8"); const prose = text.replace(/\s+/gu, " ");
    for (const field of ["recommended", "assumable"]) assert.match(prose, new RegExp(`\\b${field}\\b`, "u"), `${path} must name the ${field} field of a falsify question`);
    assert.match(prose, /`assume`/u, `${path} must name the assume input`);
    assert.ok(statements(text).some(said => /`assume`/u.test(said) && /\bfalse\b|\boff\b|\bdefault/iu.test(said)),
      `${path} must say in one sentence or table row that assume is false unless it is given`);
    assert.ok(statements(text).some(said => /\bassumable\b/iu.test(said) && /\basks?\b|\bsleeps?\b/iu.test(said) && !/\bparks?\b|\bparked\b/iu.test(said)),
      `${path} must say in one sentence or table row that a report with a question that is not assumable asks it and sleeps on it, not that it parks`);
    for (const [place, named] of [["the evidence file", /assumptions\.json/u], ["the prompt heading", /Assumptions:/u], ["the pull request heading", /## Assumptions/u]] as const) {
      assert.match(prose, named, `${path} must name ${place}`);
    }
    assert.ok(statements(text).some(said => /\bassumptions\b/iu.test(said) && /delivery\.json/u.test(said)), `${path} must say in one sentence or table row that delivery.json records the assumptions`);
  });
  test(`${path} says a failed delete or write of the saved assumptions stops, naming the file, and not that it stops naming it`, () => {
    const text = readFileSync(resolve(path), "utf8");
    assert.ok(statements(text).some(said => /\bfailed delete or write\b.*\bstops, naming the file\b/iu.test(said)),
      `${path} must say in one sentence that a failed delete or write of the saved assumptions "stops, naming the file"`);
    // Without the comma the sentence reads as the run ceasing to name the file.
    assert.doesNotMatch(text.replace(/\s+/gu, " "), /\bstops naming the file\b/iu, `${path} still says a failed delete or write stops naming the file`);
  });
}

for (const path of ["docs/catalog.md", "docs/workflows/ticket-task.md", "README.md"]) {
  test(`${path} says a stuck run sleeps on one question, that any reply but a decision is an answer, and that \`stuck\` no longer changes anything`, () => {
    const text = readFileSync(resolve(path), "utf8"); const said = statements(text);
    assert.ok(said.some(one => /\bstuck\b/iu.test(one) && /\bsleeps?\b/iu.test(one) && /\bquestion\b/iu.test(one)),
      `${path} must say in one sentence or table row that a stuck run sleeps on one question`);
    assert.ok(said.some(one => /\banswer\b/iu.test(one) && /\bmore rounds\b|\bdecisions?\b/iu.test(one) && /\bany other\b|\banything else\b|\bother repl|\bnot one of\b/iu.test(one)),
      `${path} must say in one sentence or table row that a reply other than one of the decisions is an answer`);
    assert.ok(said.some(one => /`stuck`/u.test(one) && /\bno longer\b/iu.test(one) && /\bchanges? (?:anything|nothing)\b|\bhas no effect\b/iu.test(one)),
      `${path} must say in one sentence or table row that \`stuck\` no longer changes anything`);
    // Nothing tells a reader that a stuck run still parks, or to rerun a parked ticket with resume to answer it.
    assert.doesNotMatch(text.replace(/\s+/gu, " "), /stuck run parks|parks by default|`"park"` stops at once|ends unattended runs immediately/iu, `${path} still says a stuck run parks`);
  });
  test(`${path} names question-<n>.txt, no longer describes the parked ending or park.txt, and says a decision matches ignoring case and trailing punctuation`, () => {
    const text = readFileSync(resolve(path), "utf8"); const said = statements(text);
    assert.ok(said.some(one => /`question-<n>\.txt`/u.test(one) && /\bquestion\b/iu.test(one)), `${path} must say in one sentence or table row that each question is written to \`question-<n>.txt\``);
    assert.doesNotMatch(text, /`parked`/u, `${path} still describes the parked final state`);
    assert.doesNotMatch(text, /park\.txt/u, `${path} still describes park.txt`);
    assert.ok(said.some(one => /\bdecisions?\b/iu.test(one) && /\bcase\b/iu.test(one) && /\bwhitespace\b/iu.test(one) && /\bpunctuation\b/iu.test(one)),
      `${path} must say in one sentence or table row that a decision matches ignoring case, surrounding whitespace and trailing punctuation`);
  });
}

for (const path of ["docs/catalog.md", "docs/workflows/ticket-task.md", "README.md"]) {
  test(`${path} describes no plan length limit, and says plan review can find a ticket too broad and stop with a suggested split`, () => {
    const text = readFileSync(resolve(path), "utf8"); const prose = text.replace(/\s+/gu, " ");
    assert.doesNotMatch(prose, /\b6000\b|\b4000 characters\b|plan-length|plan length|over-long plan|too long\?|`?shorten`?\b/iu, `${path} still describes a plan length limit`);
    assert.ok(statements(text).some(said => /\btoo broad\b|`tooBroad`/iu.test(said) && /\bsplit\b/iu.test(said)),
      `${path} must say in one sentence or table row that plan review can find a ticket too broad and suggest a split`);
  });
}
test("the catalog names the tooBroad verdict, and its decide row no longer refers to the removed park note", () => {
  const catalog = readFileSync(resolve("docs/catalog.md"), "utf8");
  assert.match(catalog, /`tooBroad`/u);
  const row = catalog.split("\n").find(line => line.startsWith("| `decide` |")) ?? "";
  assert.ok(row, "the catalog has a decide row"); assert.doesNotMatch(row, /\bnote's\b|\bnote\b/iu);
});

/** A rule file, or what it does to a file; `unignored` outputs of a setup command are another matter. */
const ignores = /\.gitignore|\bignore rules?\b|\bignored\b/iu;
test("the catalog says where it describes rebase that a tip whose ignore rules match a file the approved commit added is not undone onto, and what the stop names", () => {
  const said = statements(readFileSync(resolve("docs/catalog.md"), "utf8"));
  assert.ok(said.some(one => ignores.test(one) && /\btip\b/iu.test(one) && /\boriginal base\b|\brestor/iu.test(one) && /`stuck`/u.test(one)),
    "docs/catalog.md must say in one sentence or table row that a tip whose ignore rules match a file the approved commit added restores the candidate on its original base and stops through `stuck`");
  assert.ok(said.some(one => ignores.test(one) && /\bnam(?:es?|ing)\b/iu.test(one) && /\bfiles?\b/iu.test(one)),
    "docs/catalog.md must say in one sentence or table row that the stop names the files and the file that holds the ignore rule");
});

test("the catalog says the review after a changed patch is a first review of the new patch, not compared with reports from before the rebase", () => {
  const said = statements(readFileSync(resolve("docs/catalog.md"), "utf8"));
  assert.ok(said.some(one => /re-review|fresh `?review`?|(?:changed|new|differing|different) patch|patch ids? differ/iu.test(one)
    && /\bfirst review\b|\bnot compared\b|\bearlier (?:report|review)|\b(?:report|review)s? (?:from )?before\b|\bbefore the (?:rebase|replay)\b/iu.test(one)),
    "docs/catalog.md must say in one sentence or table row that the review after a changed patch is a first review, not compared with reports from before the rebase");
});

test("the catalog's more rounds row says the work returns to the editing stage that stopped, the tester or the implementer", () => {
  // The decision table's own row, taken a sentence at a time: after a failed red or a tester that stopped it is the tester, not always the implementer.
  const row = readFileSync(resolve("docs/catalog.md"), "utf8").split("\n").find(line => line.startsWith("| `more rounds` |")) ?? "";
  assert.ok(statements(row).some(one => /\btester\b/u.test(one) && /\bimplementer\b/u.test(one) && /\bstopped\b|\bblocked\b/iu.test(one)),
    "the `more rounds` row must say in one sentence that it returns to the editing stage that stopped, naming the tester and the implementer");
});

/** The Git directory of the ticket worktree itself: outside the working tree, never staged or committed, and gone with the worktree. */
const gitDirectory = (f: Fixture) => git(f.worktree, "rev-parse", "--path-format=absolute", "--git-dir");
/** The JSON files a run left there. Git keeps none of its own in that directory, so any is the run's saved assumptions. */
const savedIn = (f: Fixture) => (readdirSync(gitDirectory(f), { recursive: true }) as string[]).filter(name => name.endsWith(".json")).map(name => join(gitDirectory(f), name));
/** The one file that holds what a run assumed for these gaps, kept where no status, commit, or cleanup of the working tree reaches it. */
function saved(f: Fixture, questions: Gap[]) {
  const files = savedIn(f);
  assert.equal(files.length, 1, `the worktree's Git directory ${gitDirectory(f)} holds ${files.length} saved-assumptions files`);
  const file = files[0]!;
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), assumed(questions));
  assert.ok(relative(f.worktree, file).startsWith(".."), `${file} is inside the working tree`);
  return file;
}
/** The lines a pull request body lists under `## Assumptions`; none when it has no such section. */
const assumptionsListed = (body: string) => (body.split(/^## Assumptions\n+/mu)[1] ?? "").split(/^## /mu)[0]!.split("\n").filter(line => line.startsWith("- "));
/** One line for each gap, in order: the question, then the answer the run took. */
function listsAnswers(body: string, questions: Gap[]) {
  const listed = assumptionsListed(body); assert.equal(listed.length, questions.length, body);
  for (const [index, question] of questions.entries()) {
    const at = listed[index]!.indexOf(oneLine(question.text));
    assert.ok(at >= 0 && listed[index]!.indexOf(oneLine(question.recommended), at + oneLine(question.text).length) > at, listed[index]);
  }
}
const bodyOf = (gh: () => string[] | undefined) => { const args = gh()!; return readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8"); };
/** A resumed run with a candidate that delivers a pull request, which is then merged. */
const delivers = ["shape", "prepare", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "checkMerge", "cleanUp", "merged"];

/** A first run with assume on takes the recommended answer to every gap, and then stops with its candidate uncommitted: asked under either stuck policy, and handed off by a person. */
async function assumedThenStopped(f: Fixture, stop: "park" | "ask", questions: Gap[], repository = {}) {
  const human = person("hand off");
  const first = await execute(input(f, repository, { assume: true, maxReviewRounds: 0, stuck: stop }), {
    falsify: () => gaps(questions, "Gaps with a conservative answer each"), reviewer: () => ownerReview("Handle the empty case"),
  }, human);
  const run = questioned(f, first, /Review budget exhausted \(0\)/u, human);
  assert.deepEqual(run.delivery.assumptions, assumed(questions));
  return run;
}

for (const [stop, extra] of [["park", { assume: true }], ["ask", {}]] as const) {
  test(`the answers a run assumed are saved in its worktree's Git directory when it stops with stuck ${stop} and a candidate, out of the working tree and of every commit, and a resumed run with assume ${"assume" in extra ? "on" : "left out"} gives them to its reviewer, lists them in the pull request, and records them`, async context => {
    const f = fixture(context); remote(f); const gh = fakeGh(context, f); const questions = [beside, newline];
    const first = await assumedThenStopped(f, stop, questions, { output: "pr" });
    const file = saved(f, questions);
    // Neither tracked, untracked, nor ignored: the candidate is all the working tree holds beyond its base.
    assert.equal(candidate(f.worktree, true).status, "?? greeting.test.txt\n?? greeting.txt");
    assert.equal(git(f.repo, "rev-parse", branch), f.head); untouched(f);
    const written = readFileSync(join(first.directory, "assumptions.json"), "utf8");
    const again = next(f, 2); let prompt = "";
    const result = await execute(input(again, { output: "pr" }, { resume: true, ...extra }), {
      investigator: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(),
      reviewer: request => { prompt = request.prompt; return review(); },
    });
    assert.equal(result.state, "merged", evidence(again).delivery.reason); assert.deepEqual(result.states, delivers);
    const run = merged(again, result); untouched(f);
    // The reviewer is given the answers under their heading as the run that assumed handed them on, and is told what a disagreement is.
    assert.ok(assumptionsIn(prompt).startsWith(`${written.trimEnd()}\n`), prompt);
    assert.ok(prompt.split("\n").some(line => /\bassum/iu.test(line) && /\bdiscussion\b/iu.test(line)), "the reviewer is told that an assumption it disagrees with is a discussion finding");
    listsAnswers(bodyOf(gh), questions);
    assert.deepEqual([run.delivery.assumptions, run.delivery.resumed], [assumed(questions), true]);
    // The file was never part of the candidate: the ticket commit holds the two greeting files and nothing else.
    assert.equal(git(f.repo, "show", "--name-only", "--format=", run.delivery.commit), "greeting.test.txt\ngreeting.txt");
    assert.equal(existsSync(f.worktree), false); assert.equal(existsSync(file), false, "the saved assumptions outlived the worktree they belonged to");
  });
}

for (const assuming of [false, true]) {
  test(`a resumed run with a candidate and no saved assumptions, ${assuming ? "after a person removed the file of a run that assumed" : "after a run that assumed nothing"}, gives its reviewer none, lists none in the pull request, and records none`, async context => {
    const f = fixture(context); remote(f); const gh = fakeGh(context, f);
    if (assuming) { await assumedThenStopped(f, "ask", [beside], { output: "pr" }); rmSync(saved(f, [beside])); }
    else assert.equal((await execute(input(f, { output: "pr" }, { assume: true, maxReviewRounds: 0 }), { reviewer: () => ownerReview("Handle the empty case") }, person("hand off"))).state, "handedOff");
    assert.deepEqual(savedIn(f), []);
    const again = next(f, 2); let prompt = "";
    const result = await execute(input(again, { output: "pr" }, { resume: true, assume: true }), {
      investigator: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(),
      reviewer: request => { prompt = request.prompt; return review(); },
    });
    assert.equal(result.state, "merged", evidence(again).delivery.reason); assert.deepEqual(result.states, delivers);
    const run = merged(again, result);
    assert.ok(prompt); assert.doesNotMatch(prompt, /^Assumptions:/mu); assert.doesNotMatch(bodyOf(gh), /## Assumptions/u);
    assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", run.delivery.commit), "greeting.test.txt\ngreeting.txt");
  });
}

/** A first run with assume on that is handed off at its question before anything is edited, its plan sent back twice: the worktree is clean, so a resumed run falsifies again. */
async function assumedThenHandedOffClean(f: Fixture, repository = {}) {
  const human = person("hand off");
  const first = await execute(input(f, repository, { assume: true, stuck: "park" }), {
    falsify: () => gaps([beside], "One gap with a conservative answer"), planReview: () => ok("revise", "The plan names no test"),
    tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, first, /The plan names no test/u, human);
  assert.deepEqual(run.delivery.assumptions, assumed([beside])); assert.equal(candidate(f.worktree, true).status, "");
  // The file is written when falsify assumes, not when a candidate is left behind.
  return saved(f, [beside]);
}
/** What the answer an earlier run took to `beside` would show as, in prose or inside JSON. */
const besideAnswered = [beside.text, beside.recommended, beside.why, oneLine(beside.why)].flatMap(text => [text, JSON.stringify(text).slice(1, -1)]);

for (const damaged of [false, true]) {
  test(`a resumed run with a clean worktree does not read the saved assumptions${damaged ? ", even a file that is not JSON" : ""}: once its own falsify finds the ticket sound the file is gone, and no prompt, pull request, or receipt carries the earlier answers`, async context => {
    const f = fixture(context); remote(f); const gh = fakeGh(context, f);
    const file = await assumedThenHandedOffClean(f, { output: "pr" });
    if (damaged) writeFileSync(file, '[{ "question": ');
    const again = next(f, 2); const prompts: string[] = []; let left: string[] | undefined;
    const keeping = (work: Runner): Runner => request => { prompts.push(request.prompt); return work(request); };
    const result = await execute(input(again, { output: "pr" }, { resume: true, assume: true }), {
      falsify: keeping(planning.falsify!.answer),
      // The worktree goes with the delivery, so what falsify left in its Git directory is read by the next Agent to run.
      plan: keeping(request => { left = savedIn(f); return planning.plan!.answer(request); }),
      planReview: keeping(planning.planReview!.answer), tester: keeping(tester), implementer: keeping(implement), reviewer: keeping(() => review()),
    });
    assert.equal(result.state, "merged", evidence(again).delivery.reason);
    assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "test", "change", "review"]);
    assert.deepEqual(left, [], "a falsify that assumed nothing left the earlier run's answers in the worktree's Git directory");
    assert.equal(prompts.length, 6);
    for (const prompt of prompts) { assert.doesNotMatch(prompt, /^Assumptions:/mu); for (const stale of besideAnswered) assert.equal(prompt.includes(stale), false, stale); }
    const run = merged(again, result);
    assert.doesNotMatch(bodyOf(gh), /## Assumptions/u);
    assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
  });
}

for (const [label, extra, report, calls] of [
  ["asks its question with assume left out", {}, gaps([newline], "One thing is open"), 1],
  ["asks a question that is not assumable beside one that is", { assume: true }, gaps([language, newline], "Two gaps, one of them the owner's"), 1],
  ["returns a report that is not well formed twice", { assume: true }, gaps("Does the greeting end with a line break?", "One thing is open"), 2],
] as const) {
  test(`a resumed run with a clean worktree whose own falsify ${label} assumed nothing: the saved assumptions are deleted, and its question carries none of the earlier answers`, async context => {
    const f = fixture(context); const file = await assumedThenHandedOffClean(f);
    const again = next(f, 2); const human = person("hand off");
    const result = await execute(input(again, {}, { resume: true, stuck: "park", ...extra }), {
      falsify: () => report, plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    }, human);
    assert.equal(result.state, "handedOff"); assert.deepEqual(route(result.states), [...Array.from({ length: calls }, () => "falsify"), "decide"]);
    assert.equal(human.requests.length, 1); const note = human.requests[0]!.prompt; stuckQuestion(again, human.requests[0], "falsifyResult");
    assert.equal(existsSync(file), false, "the earlier run's answers are still saved though this run's falsify assumed nothing"); assert.deepEqual(savedIn(f), []);
    const run = held(again, result, /^Handed off: /u);
    assert.deepEqual([run.delivery.outcome, run.delivery.resumed], ["handed-off", true]);
    assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
    assert.equal(existsSync(join(run.directory, "park.txt")), false);
    const receipt = readFileSync(join(run.directory, "delivery.json"), "utf8");
    for (const stale of besideAnswered) for (const text of [receipt, note, result.output.summary]) assert.equal(text.includes(stale), false, stale);
    assert.equal(candidate(f.worktree, true).status, "");
  });
}

test("a resumed run with a clean worktree whose own falsify assumes another gap replaces the saved assumptions: the file, every prompt, the pull request, and the receipt hold the new answer alone", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  const file = await assumedThenHandedOffClean(f, { output: "pr" });
  const again = next(f, 2); const prompts: Record<string, string> = {}; let left: [string, unknown][] | undefined;
  const keeping = (name: string, work: Runner): Runner => request => { prompts[name] = request.prompt; return work(request); };
  const result = await execute(input(again, { output: "pr" }, { resume: true, assume: true }), {
    falsify: keeping("falsify", () => gaps([newline], "Another gap with a conservative answer")),
    plan: keeping("plan", request => { left = savedIn(f).map(path => [path, JSON.parse(readFileSync(path, "utf8"))]); return planning.plan!.answer(request); }),
    planReview: keeping("planReview", planning.planReview!.answer), tester: keeping("tester", tester), implementer: keeping("implementer", implement), reviewer: keeping("reviewer", () => review()),
  });
  assert.equal(result.state, "merged", evidence(again).delivery.reason);
  assert.deepEqual(route(result.states), ["falsify", "plan", "planReview", "test", "change", "review"]);
  // One file still, in the same place, now holding what this run's falsify assumed.
  assert.deepEqual(left, [[file, assumed([newline])]]);
  const run = merged(again, result);
  const written = readFileSync(join(run.directory, "assumptions.json"), "utf8"); assert.deepEqual(JSON.parse(written), assumed([newline]));
  assert.doesNotMatch(prompts.falsify!, /^Assumptions:/mu);
  for (const stage of ["plan", "planReview", "tester", "implementer", "reviewer"]) assert.ok(assumptionsIn(prompts[stage]!).startsWith(`${written.trimEnd()}\n`), stage);
  for (const [stage, prompt] of Object.entries(prompts)) for (const stale of besideAnswered) assert.equal(prompt.includes(stale), false, `${stage}: ${stale}`);
  // A pull request never lists an answer its plan did not use.
  const body = bodyOf(gh); listsAnswers(body, [newline]); for (const stale of besideAnswered) assert.equal(body.includes(stale), false, stale);
  assert.deepEqual(run.delivery.assumptions, assumed([newline]));
  assert.equal(git(f.repo, "show", "--name-only", "--format=", run.delivery.commit), "greeting.test.txt\ngreeting.txt");
});

/** What stands where the saved assumptions are kept: a link's target, a directory, or a file's bytes. */
function kept(file: string) {
  const stat = lstatSync(file);
  return stat.isSymbolicLink() ? `link to ${readlinkSync(file)}` : stat.isDirectory() ? `directory of ${readdirSync(file).length}` : readFileSync(file, "base64");
}
const entry = assumed([beside])[0]!;
/** A way a saved-assumptions file can be damaged, and for one that damages a single field, what the refusal names it as. */
const damages: [label: string, damage: (file: string, f: Fixture) => void, names?: RegExp][] = [
  ["a directory, which cannot be read", (file: string) => { rmSync(file); mkdirSync(file); }],
  ["a link to a file that is gone, which cannot be read", (file: string, f: Fixture) => { rmSync(file); symlinkSync(join(f.root, "gone.json"), file); }],
  ["not JSON", (file: string) => writeFileSync(file, '[{ "question": ')],
  ["an object rather than an array", (file: string) => writeFileSync(file, JSON.stringify({ assumptions: [entry] }))],
  ["an empty array, which no run that assumed writes", (file: string) => writeFileSync(file, "[]\n")],
  ["an array of answers alone", (file: string) => writeFileSync(file, JSON.stringify([entry.answer]))],
  ["an array holding an entry without why, after one that is whole", (file: string) => writeFileSync(file, JSON.stringify([entry, { question: newline.text, answer: newline.recommended, options: newline.options }]))],
  ["an array holding an entry whose options are one string", (file: string) => writeFileSync(file, JSON.stringify([{ ...entry, options: entry.options.join(", ") }]))],
  ["an array holding an entry whose answer is not a string", (file: string) => writeFileSync(file, JSON.stringify([{ ...entry, answer: 7 }]))],
  ["an array holding an entry without a question", (file: string) => writeFileSync(file, JSON.stringify([{ answer: entry.answer, options: entry.options, why: entry.why }]))],
  // Only a file edited by hand holds one: falsify saves the recommended answer, which is always one of the options.
  ["an array holding an entry whose answer is not one of its options, after one that is whole",
    (file: string) => writeFileSync(file, JSON.stringify([entry, { ...assumed([newline])[0]!, answer: "An answer outside its options" }])), /\bassumptions\[1\]\.answer\b/u],
];
for (const [label, damage, names] of damages) {
  test(`saved assumptions that are ${label} refuse the resume of a candidate with the file named, and change nothing`, async context => {
    const f = fixture(context); await assumedThenStopped(f, "park", [beside]);
    const file = saved(f, [beside]); damage(file, f);
    const snapshot = () => [git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), git(f.repo, "worktree", "list", "--porcelain"), candidate(f.worktree, true), kept(file)];
    const before = snapshot();
    const again = next(f, 2);
    const result = await execute(input(again, { setup: [command("process.exit(1)")] }, { resume: true, assume: true }), {
      investigator: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
    });
    // The answers the plan was made from cannot be read back, so the candidate is not reviewed or delivered without them.
    assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
    const run = held(again, result, /^Refused: Cannot resume: /u);
    assert.match(run.delivery.reason, /^Cannot resume: /u); assert.ok(run.delivery.reason.includes(file), `${run.delivery.reason} does not name ${file}`);
    if (names) assert.match(run.delivery.reason, names, "the refusal does not name the entry and its field");
    assert.deepEqual([run.delivery.outcome, run.delivery.resumed, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.result.checks.length], ["refused", undefined, false, false, null, 0]);
    assert.equal(Object.hasOwn(run.delivery, "assumptions"), false); assert.equal(run.result.agentInvocations, 0);
    assert.deepEqual(snapshot(), before);
  });
}

test("under stuck ask, a stop for review questions that follows more rounds after falsify questions shows the reviewer's questions alone, in the second decision and on the receipt after hand off", async context => {
  const f = fixture(context); const human = person("more rounds", "hand off"); let falsified = 0; let reviews = 0;
  // Two planning questions, then two review questions: paired by position, each review question would be shown a planning question's options.
  const planned = [language, beside];
  const result = await execute(input(f), {
    falsify: request => ++falsified === 1 ? gaps(planned, "The ticket leaves two things open") : planning.falsify!.answer(request),
    reviewer: () => review("approved", "Owner questions", { findings: discussions(++reviews === 1 ? asked : askedAgain), newSinceLastRound: "none" }),
  }, human);
  assert.deepEqual(route(result.states), ["falsify", "decide", "falsify", "plan", "planReview", "test", "change", "review", "change", "review", "decide"]);
  const lines = questionLines(askedAgain);
  const run = handedOff(f, result, new RegExp(`${counted(2)}:\\s${lines.map(literal).join("\\s")}`, "u"), human);
  assert.deepEqual([falsified, reviews, human.requests.length], [2, 2, 2]);
  const [first, second] = human.requests.map(request => request.prompt) as [string, string];
  // The first decision did show each planning question with its own options and reason.
  for (const [index, question] of planned.entries()) optionsFirst(numberedLines(needsIn(first, f.worktree).split("\n"))[index]!, index + 1, question);
  // The second shows what the reviewer asked, each on its numbered line with where it was raised and nothing after it, and needs the same.
  assert.ok(second.startsWith(`Answer ${counted(2)} the reviewer raised.\n`), second);
  for (const line of lines) assert.equal(occurrences(second, line), 1, line);
  assert.deepEqual(numberedLines(needsIn(second, f.worktree).split("\n")), lines);
  assert.deepEqual(run.delivery.reason.split("\n").slice(1), lines);
  for (const text of [second, run.delivery.reason, result.output.summary]) {
    for (const stale of planned.flatMap(question => [question.text, ...question.options, oneLine(question.why)])) assert.equal(oneLine(text).includes(stale), false, stale);
    assert.doesNotMatch(text, /Options:|Why:|would have assumed/iu);
  }
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }, { stage: "decide", response: "hand off" }]);
});

test("under stuck ask with assume on, a stop for review questions that follows more rounds after a mixed falsify report shows the reviewer's questions alone: what the first report would have assumed is in neither the second decision nor the receipt after hand off", async context => {
  const f = fixture(context); const human = person("more rounds", "hand off"); let falsified = 0; let reviews = 0;
  // One question for the owner beside one gap the run would have assumed, then two review questions.
  const planned = [language, beside];
  const result = await execute(input(f, {}, { assume: true }), {
    falsify: request => ++falsified === 1 ? gaps(planned, "Two gaps, one of them the owner's") : planning.falsify!.answer(request),
    reviewer: () => review("approved", "Owner questions", { findings: discussions(++reviews === 1 ? asked : askedAgain), newSinceLastRound: "none" }),
  }, human);
  assert.deepEqual(route(result.states), ["falsify", "decide", "falsify", "plan", "planReview", "test", "change", "review", "change", "review", "decide"]);
  const lines = questionLines(askedAgain);
  const run = handedOff(f, result, new RegExp(`${counted(2)}:\\s${lines.map(literal).join("\\s")}`, "u"), human);
  assert.deepEqual([falsified, reviews, human.requests.length], [2, 2, 2]);
  const [first, second] = human.requests.map(request => request.prompt) as [string, string];
  // The first decision did show the owner's question with its options, and after it the gap the run would have assumed with its answer.
  assert.equal(first.split("\n")[0], "Answer 1 open question before any code is written."); assert.equal(numberedLines(needsIn(first, f.worktree).split("\n")).length, 1); optionsFirst(numberedLines(needsIn(first, f.worktree).split("\n"))[0]!, 1, language);
  assert.match(first, /would have assumed/iu);
  const others = needsIn(first, f.worktree).slice(needsIn(first, f.worktree).search(/would have assumed/iu));
  assert.ok(others.indexOf(beside.recommended, others.indexOf(beside.text) + beside.text.length) > 0, `${beside.text} is not listed with the answer ${beside.recommended}`);
  // The second shows what the reviewer asked, each on its numbered line with where it was raised and nothing after it, and needs the same.
  assert.ok(second.startsWith(`Answer ${counted(2)} the reviewer raised.\n`), second);
  for (const line of lines) assert.equal(occurrences(second, line), 1, line);
  assert.deepEqual(numberedLines(needsIn(second, f.worktree).split("\n")), lines);
  assert.deepEqual(run.delivery.reason.split("\n").slice(1), lines);
  for (const text of [second, run.delivery.reason, result.output.summary]) {
    for (const stale of planned.flatMap(question => [question.text, ...question.options, oneLine(question.why)])) assert.equal(oneLine(text).includes(stale), false, stale);
    assert.doesNotMatch(text, /Options:|Why:|would have assumed/iu);
  }
  // The second falsify found the ticket sound, so the run assumed nothing.
  assert.equal(existsSync(join(run.directory, "assumptions.json")), false); assert.equal(Object.hasOwn(run.delivery, "assumptions"), false);
  assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }, { stage: "decide", response: "hand off" }]);
});

test("a question for review questions without more rounds, in a run whose two falsify gaps were assumed, lists the reviewer's questions alone: no options, no reason, and nothing it would have assumed", async context => {
  const f = fixture(context); const human = person("hand off"); let reviews = 0; const taken = [beside, newline];
  const result = await execute(input(f, {}, { assume: true, stuck: "park" }), {
    falsify: () => gaps(taken, "Two gaps, each with a conservative answer"),
    reviewer: () => review("approved", "Owner questions", { findings: discussions(++reviews === 1 ? asked : askedAgain), newSinceLastRound: "none" }),
  }, human);
  const run = questioned(f, result, /confirmed again through a live engine/u, human); assert.equal(reviews, 2); assert.equal(result.states.at(-5), "reviewResult");
  const lines = questionLines(askedAgain);
  const [reason, needs]: string[][] = [run.delivery.reason.split("\n"), run.needs.split("\n")];
  assert.match(reason[0]!, /\b2 open questions:$/u); assert.deepEqual(reason.slice(1), lines);
  assert.match(needs[0]!, openQuestions); assert.deepEqual(needs.slice(1), lines);
  const note = run.prompt;
  showsNeed(note, run.needs, f.worktree);
  for (const text of [run.delivery.reason, run.needs, note, result.output.summary]) {
    for (const stale of taken.flatMap(question => [question.text, ...question.options, oneLine(question.why)])) assert.equal(oneLine(text).includes(stale), false, stale);
    assert.doesNotMatch(text, /Options:|Why:|would have assumed/iu);
  }
  // What the run did assume stays on the receipt, apart from what it asks.
  assert.deepEqual(run.delivery.assumptions, assumed(taken));
});

/** A field as a stuck question's needs give it: on one line, and cut at 600 characters with an ellipsis when it runs longer. */
const capped = (value: string) => { const whole = oneLine(value); return whole.length > 600 ? `${whole.slice(0, 600)}…` : whole; };
/** Where a field ends in a line of needs, looked for from a position on. A field that is cut is cut by itself: its 601st character is nowhere in the line. */
function shownAt(line: string, value: string, from = 0) {
  const shown = capped(value); const at = line.indexOf(shown, from);
  assert.ok(at >= 0, `${JSON.stringify(shown)} is not in ${JSON.stringify(line.slice(from))}`);
  if (shown !== oneLine(value)) assert.equal(line.includes(oneLine(value).slice(0, 601)), false, `${JSON.stringify(shown.slice(0, 40))} runs on past 600 characters`);
  return at + shown.length;
}

test("under Needs, each option, the reason, and each question and answer the run would have assumed takes one line cut at 600 characters by itself, while short ones stay whole and the reason for the stop stays whole in the question and the receipt", async context => {
  const f = fixture(context); const human = person("hand off");
  // Each long field runs over several lines and well past the cap, in words of its own.
  const english = `Write it in English only,\n${"since every other file here is in English. ".repeat(18)}`.trim();
  const locale = `Follow the reader's locale,\n${"falling back where no translation exists. ".repeat(18)}`.trim();
  const reason = `The product ships in several languages,\n${"and the ticket names none of them. ".repeat(22)}`.trim();
  const first = gap("Which language is the greeting in?", { options: [locale, "Leave it out", english], recommended: english, why: reason });
  const second = gap("Who is greeted?");
  const replaced = gap(`Does greeting.txt replace code.txt\nor stand beside it? ${"Other files may still read code.txt. ".repeat(20)}`.trim(), {
    options: ["Replace code.txt", `Stand beside code.txt,\n${"keeping every byte of it as it is. ".repeat(22)}`.trim()], assumable: true,
    why: "Keeping code.txt loses nothing.",
  });
  replaced.recommended = replaced.options[1]!;
  const long = [english, locale, reason, replaced.text, replaced.recommended];
  for (const field of long) { assert.ok(oneLine(field).length > 700); assert.ok(field.includes("\n")); }
  const result = await execute(input(f, {}, { assume: true, stuck: "park" }), {
    falsify: () => gaps([first, replaced, second, newline], "Four gaps, two of them the owner's"),
    plan: () => assert.fail(), planReview: () => assert.fail(), tester: () => assert.fail(), implementer: () => assert.fail(), reviewer: () => assert.fail(),
  }, human);
  const run = questioned(f, result, /Which language is the greeting in\?/u, human);
  // A heading, the two questions for the owner, then a heading and the two gaps the run would have assumed: six lines, whatever the fields held.
  const needs: string[] = run.needs.split("\n"); assert.equal(needs.length, 6, run.needs);
  assert.match(needs[0]!, openQuestions); assert.deepEqual(numberedLines(needs), needs.slice(1, 3));
  // The first question's line: its text, the recommended option cut, the other options after it, the long one cut and the short one whole, and the reason cut.
  assert.ok(needs[1]!.startsWith(`1. ${first.text}`), needs[1]);
  const recommended = shownAt(needs[1]!, english, `1. ${first.text}`.length);
  shownAt(needs[1]!, locale, recommended); shownAt(needs[1]!, "Leave it out", recommended); shownAt(needs[1]!, reason, recommended);
  assert.match(needs[1]!.slice(0, recommended + 40), /\brecommended\b/iu);
  // A question whose fields are short keeps every one whole, its reason included.
  optionsFirst(needs[2]!, 2, second);
  assert.match(needs[3]!, /would have assumed/iu);
  // Each gap it would have assumed: the question, then the answer, each cut by itself.
  shownAt(needs[4]!, replaced.recommended, shownAt(needs[4]!, replaced.text));
  shownAt(needs[5]!, newline.recommended, shownAt(needs[5]!, newline.text));
  for (const line of needs) for (const field of long) assert.equal(line.includes(oneLine(field)), false, `${oneLine(field).slice(0, 40)}… is whole under Needs`);
  // The receipt holds the reason for the stop whole; the question gives each question once, cut under Needs, and nowhere whole.
  for (const field of long) {
    assert.ok(oneLine(run.delivery.reason).includes(oneLine(field)), `the reason in delivery.json does not hold ${oneLine(field).slice(0, 40)}… whole`);
    assert.equal(oneLine(run.prompt).includes(oneLine(field)), false, `${oneLine(field).slice(0, 40)}… is whole in the question`);
  }
  assert.doesNotMatch(result.output.summary, /\n/u);
});

test("a rebase stop whose cleanup cannot remove a setup output says that cleaning failed and names the log that holds Git's refusal, in the receipt and the question, with the candidate uncommitted on its original base", {
  // Root removes a file from a directory it may not write to, so there the cleanup does not fail.
  skip: process.getuid?.() === 0 && "runs as root, which a read-only directory does not refuse",
}, async context => {
  const f = fixture(context); const human = person("hand off");
  // On the tip, setup leaves cache/ read-only: git clean cannot remove what it holds once the candidate is back on its original base.
  const { seen, agents, data } = ignoredOutputs(f, `${writesOutputs} if (tip) fs.chmodSync("cache", 0o555);`);
  const cache = join(f.worktree, "cache");
  // The fixture's own removal needs the directory writable again.
  const result = await execute(data(f), agents, human).finally(() => { if (existsSync(cache)) chmodSync(cache, 0o755); });
  assert.deepEqual(result.states.slice(result.states.indexOf("rebase")), ["rebase", "stuck", "decide", "handOff", "handedOff"]);
  const run = questionedIn("rebase", f, result, /greeting\.txt/u, human); untouched(f); assert.equal(human.requests.length, 1);
  assert.match(run.delivery.reason, /\.gitignore/u); assert.ok(names(run.delivery.reason, seen.tip), "the reason names the new tip");
  // Git said which path it could not remove; that output is kept in one log of this rebase.
  const logs = holding(run.directory, ["cache/out.txt"]).filter(name => /^rebase-\d+-clean\.log$/u.test(name));
  assert.equal(logs.length, 1, `logs of a failed git clean: ${logs.join(", ")}`);
  const log = join(run.directory, logs[0]!);
  // The leftover is still there, and a resumed run will meet it: the reason says why and where to look. Needs are cut at 600 characters, the reason is not.
  assert.match(run.delivery.reason, /\bclean/iu, "the reason does not say that cleaning failed");
  assert.ok(run.delivery.reason.includes(log), `${run.delivery.reason} does not name ${log}`);
  const note = run.prompt;
  assert.ok(oneLine(run.needs).includes(log), "what the question says is needed does not name the log"); assert.equal(occurrences(note, log), 1);
  // The candidate is the approved one, uncommitted on the base it was approved on, beside the one output that could not be removed.
  assert.equal(candidate(f.worktree, true).status, "?? cache/out.txt\n?? greeting.test.txt\n?? greeting.txt\n!! kept/out.txt");
  assert.deepEqual(candidate(f.worktree).files.filter(([name]) => name !== "cache/out.txt"), seen.before!.files);
  assert.equal(git(f.worktree, "diff", "--cached", "--name-only"), ""); assert.equal(git(f.worktree, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
  assert.deepEqual([git(f.worktree, "rev-parse", "HEAD"), git(f.repo, "rev-parse", branch)], [seen.started, seen.started]);
  for (const state of ["rebase-merge", "rebase-apply"]) assert.equal(existsSync(git(f.worktree, "rev-parse", "--path-format=absolute", "--git-path", state)), false, state);
  assert.deepEqual([run.delivery.commit, run.delivery.baseCommit, run.delivery.worktreeRemoved], [null, seen.started, false]);
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n"); assert.equal(existsSync(join(f.worktree, "later.txt")), false);
  assert.deepEqual([seen.edits, seen.reviews], [1, 1]);
});

for (const third of ["approves", "repeats its report"] as const) {
  test(`under stuck ask, the review after more rounds that follow a setup failure on the new tip is a first review of a new patch: an unmet criterion with nothing new gets a repair round, and a next review that ${third} ${third === "approves" ? "delivers on the tip" : "stops as not converging"}`, async context => {
    const f = fixture(context); const started = f.head; const human = person("more rounds", ...(third === "approves" ? [] : ["hand off"]));
    let tip = ""; let reviews = 0; const prompts: string[] = [];
    const setup = [command('process.exit(require("fs").existsSync("later.txt") ? 3 : 0)', { name: "install" })];
    const result = await execute(input(f, { setup }), {
      implementer: request => { writeFileSync(join(request.cwd, "greeting.txt"), prompts.push(request.prompt) < 3 ? "hello\n" : "hello again\n"); return ok(); },
      reviewer: () => {
        if (++reviews === 1) { tip = advance(f); return review(); }
        return reviews === 2 || third === "repeats its report" ? stillUnmet() : review();
      },
    }, human);
    untouched(f);
    // The approval before the rebase read the candidate on another base: beside it, the next report would be an unchanged one and stop the run.
    assert.deepEqual(result.states.slice(result.states.indexOf("rebase")).slice(0, 13),
      ["rebase", "stuck", "decide", "repairTarget", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult", "reviewBudget", "change", "scopeAfterChange"],
      "the first review after more rounds sends its unmet criterion to the implementer");
    assert.deepEqual([reviews, prompts.length], [3, 3]);
    assert.match(human.requests[0]!.prompt, /Stopped in rebase\./u); assert.match(human.requests[0]!.prompt, /\binstall\b/u);
    assert.match(prompts[1]!.split("Current failure/feedback: ")[1] ?? "", /\binstall\b/u);
    assert.match(prompts[2]!.split("Current failure/feedback: ")[1] ?? "", new RegExp(`Unmet criterion: ${criterion}`, "u"));
    if (third === "repeats its report") {
      // The second review of the candidate on the tip is compared with the first, as any later review is with the one before it.
      const stop = handedOff(f, result, /Review is not converging: newSinceLastRound is none and criteria remain unmet: /u, human);
      assert.equal(stop.delivery.reason, `Review is not converging: newSinceLastRound is none and criteria remain unmet: ${criterion}`);
      assert.deepEqual([git(f.worktree, "rev-parse", "HEAD"), stop.delivery.baseCommit, human.requests.length], [tip, tip, 2]);
      assert.deepEqual(stop.result.decisions, [{ stage: "decide", response: "more rounds" }, { stage: "decide", response: "hand off" }]);
      return;
    }
    assert.equal(result.state, "delivered"); assert.equal(human.requests.length, 1);
    assert.deepEqual(result.states.filter(state => ["stuck", "decide"].includes(state)), ["stuck", "decide"]);
    const run = evidence(f); const commit = onTip(f, tip); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello again");
    assert.deepEqual([run.delivery.outcome, run.delivery.baseCommit, run.delivery.commit, run.result.checksPassed], ["delivered", tip, commit, true]);
    assert.deepEqual(run.result.decisions, [{ stage: "decide", response: "more rounds" }]);
    rebasedFrom(f, run, started);
  });
}

// A delivered ticket whose base moved under it: its run has ended and its worktree is gone, so `resume: true` takes up the delivered commit itself.
const deliveredKey = `branch.${branch}.ticketDelivered`;
/** The commit a run recorded with the branch when it delivered, or "" for a branch that carries no such record. */
const deliveredAs = (f: Fixture) => git(f.repo, "config", "--local", "--default", "", "--get", deliveredKey);
/** No Agent has work on a run that only delivers again: any call fails the test. */
const nobody: Record<string, Runner> = Object.fromEntries(["investigator", "planReview", "tester", "implementer", "reviewer"]
  .map(name => [name, () => assert.fail(`${name} has no work on a ticket that was already delivered`)]));
/** What a setup command saw: whether the base's later file and the ticket's own are in the tree it ran in. */
const sees = 'const fs = require("fs"); console.log(`later.txt ${fs.existsSync("later.txt")}, greeting.txt ${fs.existsSync("greeting.txt")}`)';
/** A gate that passes as the fixture's own does and says which commit it ran on, so its log shows the tree that was tested. */
const testedOn = command('if (require("fs").existsSync("greeting.test.txt")) eval(require("fs").readFileSync("greeting.test.txt", "utf8")); '
  + 'console.log("tested " + require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }))');
const ran = (run: { result: any }) => run.result.checks.map((check: any) => [check.phase, check.name, check.passed]);
const oneSentence = /^[^.!?]+\.$/u;
/** A first run delivers the ticket and ends: its worktree is gone and its branch holds the delivered commit, which waits for whoever merges it. */
async function deliverFirst(f: Fixture, data: unknown = input(f), agents: Record<string, Runner> = {}) {
  const first = await execute(data, agents);
  assert.equal(first.state, "delivered"); assert.equal(existsSync(f.worktree), false);
  assert.equal(git(f.repo, "rev-list", "--count", `${f.head}..${branch}`), "1");
  return git(f.repo, "rev-parse", branch);
}
/** What a refused resume leaves as it was: every ref, the registered worktrees, the local configuration with its records, and the place worktrees are made in. */
const everything = (f: Fixture) => [git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), git(f.repo, "worktree", "list", "--porcelain"),
  git(f.repo, "config", "--local", "--list"), existsSync(f.worktree), existsSync(join(f.root, "worktrees")) ? readdirSync(join(f.root, "worktrees")) : null];
/** What a delivery's hold says between its usual first sentence and where the evidence is; "" for a hold that is those two alone. */
function between(result: { output: any }, run: { directory: string; delivery: any }) {
  const summary: string = result.output.summary;
  const first = `Delivered ${branch} at ${run.delivery.commit}${run.delivery.prUrl ? `, pull request ${run.delivery.prUrl}` : ""}${run.delivery.patches ? `, patch ${run.delivery.patches.join(", ")}` : ""}.`;
  const last = `Evidence: ${run.directory}`;
  assert.ok(summary.startsWith(first), summary); assert.ok(summary.endsWith(` ${last}`), summary); assert.doesNotMatch(summary, /\n/u);
  return summary.slice(first.length, -last.length).trim();
}
/** The worktree is made again with `git worktree add` on the branch that exists: no new branch, no detached HEAD, and nothing forced. */
function recreated(calls: string[], f: Fixture, times = 1) {
  const added = calls.filter(call => /^worktree add(?:\s|$)/u.test(call));
  assert.equal(added.length, times, `git worktree add: ${added.join("; ")}`);
  for (const call of added) {
    assert.ok(call.endsWith(` ${f.worktree} ${branch}`), call); assert.doesNotMatch(call, /(?:^|\s)(?:-b|-B|-f|--force|--detach|--orphan)(?:\s|$)/u);
  }
}
/** A commit a person made on top of `parent`, changing greeting.txt: nobody reviewed it and no run delivered it. */
function byHand(f: Fixture, parent: string, message: readonly string[] = ["Add a greeting", "Ticket: PROJ-12"]) {
  const scratch = join(f.root, "scratch");
  git(f.repo, "worktree", "add", "-q", "--detach", scratch, parent);
  writeFileSync(join(scratch, "greeting.txt"), "by hand\n"); git(scratch, "add", "."); git(scratch, "commit", "-q", ...message.flatMap(part => ["-m", part]));
  const commit = git(scratch, "rev-parse", "HEAD");
  git(f.repo, "worktree", "remove", "--force", scratch);
  return commit;
}
/** Puts a commit at the ticket branch's tip and records it as the delivered one, so that its shape alone is what a resume can refuse. */
const place = (f: Fixture, commit: string) => { git(f.repo, "update-ref", `refs/heads/${branch}`, commit); git(f.repo, "config", deliveredKey, commit); };

for (const output of ["branch", "patch", "pr"] as const) {
  test(`${output} delivery records the delivered commit with the branch, beside the ticket's id slug, and its hold gains no sentence`, async context => {
    const f = fixture(context); remote(f); fakeGh(context, f);
    const result = await execute(input(f, { output }));
    const commit = onTip(f, f.head, deliveredRef(f, output));
    if (output === "pr") {
      // A merged pull request's branch is deleted, and its records go with it: nothing is left for a resume to take up.
      merged(f, result); assert.equal(deliveredAs(f), "");
      assert.equal(git(f.repo, "config", "--local", "--default", "", "--get", `branch.${branch}.ticket`), "");
      return;
    }
    const run = ended(f, result, output, new RegExp(`^Delivered ${branch} at ${commit}`, "u"));
    assert.equal(deliveredAs(f), commit, `git config ${deliveredKey} <commit>`);
    assert.equal(git(f.repo, "config", "--local", "--get", `branch.${branch}.ticket`), "proj-12");
    // An ordinary delivery replayed nothing a run had delivered and delivered nothing again: its hold and receipt are as they were.
    assert.equal(between(result, run), ""); assert.equal(run.delivery.redelivered, undefined);
  });
}

test("a delivery after a replay records the commit on the new tip, not the one approved first, and its hold gains no sentence either", async context => {
  const f = fixture(context); let tip = "";
  const result = await execute(input(f), { reviewer: () => { tip = advance(f); return review(); } });
  assert.equal(result.state, "delivered"); const commit = onTip(f, tip);
  const run = held(f, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u"));
  assert.equal(deliveredAs(f), commit); assert.notEqual(run.delivery.rebasedFrom.commit, commit);
  assert.equal(between(result, run), ""); assert.equal(run.delivery.redelivered, undefined);
});

test("a run that does not deliver records no delivered commit: a failed pull request leaves its committed branch without one", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f, 1); const human = person("hand off");
  const result = await untilEnd(input(f, { output: "pr" }), {}, human); retried(result, 3);
  const run = steppedOff(f, result, "deliver", "deliverDecide", /gh pr failed; inspect .+gh-pr\.log/u, human, 1); untouched(f);
  assert.equal(run.delivery.commit, git(f.repo, "rev-parse", branch)); assert.equal(deliveredAs(f), "");
});

for (const output of ["branch", "patch"] as const) {
  test(`with resume, a delivered ${output} ticket whose base moved is replayed onto the new tip, set up and verified there, and delivered again without any Agent`, async context => {
    const f = fixture(context); const started = f.head;
    const repository = { output, setup: [command(sees, { name: "install" })], checks: [testedOn] };
    const delivered = await deliverFirst(f, input(f, repository));
    // Another ticket's delivery is merged first, in two commits: this one no longer fast-forwards.
    advance(f); const tip = advance(f, "latest.txt"); const refs = others(f);
    const calls = recordGit(context, f); const again = next(f, 2);
    const result = await execute(input(again, repository, { resume: true }), nobody);
    assert.equal(result.state, "delivered"); assert.deepEqual(result.states, ["shape", "prepare", "rebase", "deliver", "success", "delivered"]);
    // Exactly the ticket commit lies above the new tip, and no other ref moved: nothing was merged into the base.
    const commit = onTip(f, tip); assert.notEqual(commit, delivered);
    const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f); assert.equal(others(f), refs);
    assert.equal(git(f.repo, "show", "--name-only", "--format=", branch), "greeting.test.txt\ngreeting.txt");
    assert.equal(git(f.repo, "ls-tree", "-r", "--name-only", branch), "code.txt\ngreeting.test.txt\ngreeting.txt\nlater.txt\nlatest.txt");
    // The worktree was made again on the branch that exists, and the delivered commit replayed from its own parent, never by force.
    recreated(calls(), f);
    assert.ok(calls().some(call => /(?:^|\s)rebase\s/u.test(call) && call.includes(`--onto ${tip} ${started}`)), "git rebase --onto <tip> <the delivered commit's parent>");
    unforced(calls());
    assert.equal(existsSync(f.worktree), false); assert.equal(git(f.repo, "worktree", "list").split("\n").length, 1);
    // The receipt: delivered on the tip, from the commit the first run delivered on the base that run started from.
    assert.deepEqual([run.delivery.outcome, run.delivery.baseCommit, run.delivery.commit, run.delivery.resumed, run.delivery.worktreeCreated, run.delivery.worktreeRemoved],
      ["delivered", tip, commit, true, true, true]);
    assert.equal(rebasedFrom(f, run, started), delivered); assert.notEqual(run.delivery.redelivered, true);
    // Setup ran where the worktree was recreated and again on the replayed tree; then the gates, as `verify`, on the commit that was delivered.
    assert.deepEqual(ran(run), [["setup", "install", true], ["setup", "install", true], ["verify", "tests", true]]);
    assert.match(readFileSync(run.result.checks[0].log, "utf8"), /later\.txt false, greeting\.txt true/u);
    assert.match(readFileSync(run.result.checks[1].log, "utf8"), /later\.txt true, greeting\.txt true/u);
    assert.ok(readFileSync(run.result.checks[2].log, "utf8").includes(`tested ${commit}`), "the gates ran on the commit that was delivered");
    assert.deepEqual([run.result.outcome, run.result.checksPassed, run.result.repairs, run.result.reviewRounds, run.result.agentInvocations], ["completed", true, 0, 0, 0]);
    // The new commit is the delivered one now, so a base that moves again is answered the same way.
    assert.equal(deliveredAs(f), commit);
    // One sentence between the usual first one and the evidence says what happened to the delivered commit.
    const said = between(result, run); assert.match(said, oneSentence); assert.match(said, /\breplayed\b/iu); assert.match(said, /\bbase\b/iu);
    if (output === "patch") {
      // One patch: the ticket's, on the new tip, not the base's commits with it.
      assert.deepEqual(run.delivery.patches, [join(run.directory, "0001-Add-a-greeting.patch")]); assert.match(readFileSync(run.delivery.patches[0], "utf8"), /\+hello/u);
    }
  });
}

for (const output of ["branch", "patch"] as const) {
  test(`with resume, a delivered ${output} ticket whose base has not moved is set up and verified on the same commit and delivered again unchanged, and a second time changes only the evidence`, async context => {
    const f = fixture(context); const started = f.head;
    const repository = { output, setup: [command(sees, { name: "install" })], checks: [testedOn] };
    const delivered = await deliverFirst(f, input(f, repository));
    assert.equal(deliveredAs(f), delivered); const before = everything(f); const calls = recordGit(context, f);
    for (const number of [2, 3]) {
      const again = next(f, number);
      const result = await execute(input(again, repository, { resume: true }), nobody);
      assert.equal(result.state, "delivered"); assert.deepEqual(result.states, ["shape", "prepare", "rebase", "deliver", "success", "delivered"]);
      const run = held(again, result, new RegExp(`^Delivered ${branch} at ${delivered}`, "u")); untouched(f);
      // The same commit on the same base: no ref, record, or registered worktree differs from before the run.
      assert.deepEqual(everything(f), before); assert.equal(git(f.repo, "rev-parse", branch), delivered);
      assert.deepEqual([run.delivery.outcome, run.delivery.redelivered, run.delivery.baseCommit, run.delivery.commit, run.delivery.rebasedFrom, run.delivery.resumed, run.delivery.worktreeRemoved],
        ["delivered", true, started, delivered, undefined, true, true]);
      // Nothing vouches for the commit but this run's own setup and gates on it.
      assert.deepEqual(ran(run), [["setup", "install", true], ["verify", "tests", true]]);
      assert.match(readFileSync(run.result.checks[0].log, "utf8"), /later\.txt false, greeting\.txt true/u);
      assert.ok(readFileSync(run.result.checks[1].log, "utf8").includes(`tested ${delivered}`), "the gates ran on the commit that was delivered");
      assert.deepEqual([run.result.outcome, run.result.checksPassed, run.result.repairs, run.result.reviewRounds, run.result.agentInvocations], ["completed", true, 0, 0, 0]);
      const said = between(result, run); assert.match(said, oneSentence); assert.match(said, /\bunchanged\b|\bagain\b/iu); assert.doesNotMatch(said, /\breplayed\b/iu);
      if (output === "patch") assert.deepEqual(run.delivery.patches, [join(run.directory, "0001-Add-a-greeting.patch")]);
    }
    recreated(calls(), f, 2);
    assert.equal(calls().some(call => /(?:^|\s)rebase\s/u.test(call)), false, "nothing is replayed onto a base that has not moved");
  });
}

test("with resume, a delivered ticket whose replay conflicts moves onto the tip, is settled and reviewed in the same run without asking, and the next resume is accepted", async context => {
  const f = fixture(context); const started = f.head; const human = person();
  const delivered = await deliverFirst(f);
  const files = Object.fromEntries(["greeting.test.txt", "greeting.txt"].map(name => [name, git(f.repo, "show", `${delivered}:${name}`)]));
  // The base gains a greeting of its own before this one is merged.
  const tip = advance(f, "greeting.txt", "hi\n"); const refs = others(f);
  const again = next(f, 2); const prompts: string[] = []; const reviews: string[] = [];
  const result = await execute(input(again, {}, { resume: true, stuck: "park" }), {
    ...nobody,
    implementer: request => {
      prompts.push(request.prompt);
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip);
      assert.match(git(request.cwd, "ls-files", "-u"), /\tgreeting\.txt$/mu);
      assert.match(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), /^<<<<<<< /mu);
      assert.equal(readFileSync(join(request.cwd, "greeting.test.txt"), "utf8").trim(), files["greeting.test.txt"]);
      writeFileSync(join(request.cwd, "greeting.txt"), "hello\nhi\n");
      return ok("completed", "Kept both greetings");
    },
    reviewer: request => {
      reviews.push(request.prompt);
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip);
      assert.equal(git(request.cwd, "ls-files", "-u"), "");
      assert.equal(readFileSync(join(request.cwd, "greeting.txt"), "utf8"), "hello\nhi\n");
      return review();
    },
  }, human);
  assert.deepEqual(result.states, ["shape", "prepare", "rebase", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult",
    "commit", "rebase", "deliver", "success", "delivered"]);
  assert.deepEqual([prompts.length, reviews.length, human.requests.length], [1, 1, 0]);
  const feedback = prompts[0]!.split("Current failure/feedback: ")[1] ?? "";
  const said = movedAtDelivery.exec(feedback); assert.ok(said, feedback);
  assert.ok(names(said[1]!, tip) && names(said[2]!, tip));
  assert.match(reviews[0]!, /The delivery move/u); assert.ok(names(reviews[0]!, tip));
  const commit = onTip(f, tip); assert.notEqual(commit, delivered);
  const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u")); untouched(f);
  assert.equal(others(f), refs); assert.equal(existsSync(f.worktree), false);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello\nhi");
  assert.deepEqual([run.delivery.resumed, run.delivery.baseCommit, run.delivery.commit, deliveredAs(f)], [true, tip, commit, commit]);
  assert.equal(rebasedFrom(f, run, started), delivered);
  assert.deepEqual([phases(run), run.result.checksPassed, run.result.repairs, run.result.agents.map((agent: any) => agent.stage)],
    [["verify"], true, 0, ["change", "review"]]);
  savedAsItStood(f, run.directory, started, files);
  // The new delivery record remains resumable without another move or any Agent work.
  const later = next(f, 3);
  const resumed = await execute(input(later, {}, { resume: true }), nobody, human);
  assert.deepEqual(resumed.states, ["shape", "prepare", "rebase", "deliver", "success", "delivered"]);
  assert.deepEqual([phases(evidence(later)), evidence(later).delivery.commit, deliveredAs(f)], [["verify"], commit, commit]);
  assert.equal(human.requests.length, 0); assert.equal(savedRefs(f).length, 1);
});

test("with resume, a delivered ticket whose replayed patch is not the one that was reviewed is undone on the new tip, verified, and reviewed again before it is delivered there", async context => {
  const f = fixture(context); const started = advance(f, "lines.txt", numbered()); const human = person(); let reviews = 0;
  const data = (at: Fixture, extra = {}) => scoped(input(at, {}, { stuck: "park", ...extra }), "lines.txt");
  const delivered = await deliverFirst(f, data(f), {
    implementer: request => { writeFileSync(join(request.cwd, "lines.txt"), numbered({ 5: "five" })); return implement(request); },
  });
  // The base changes a line two below the ticket's: the replay applies cleanly, but its patch is no longer the one the first run's review read.
  const tip = advance(f, "lines.txt", numbered({ 7: "seven" })); const refs = others(f); const again = next(f, 2);
  const result = await execute(data(again, { resume: true }), {
    ...nobody,
    reviewer: request => {
      reviews++;
      // The candidate is uncommitted on the new tip, with the base's change beside its own.
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(git(request.cwd, "symbolic-ref", "HEAD"), `refs/heads/${branch}`);
      assert.equal(candidate(request.cwd).status, "M lines.txt\n?? greeting.test.txt\n?? greeting.txt");
      assert.equal(readFileSync(join(request.cwd, "lines.txt"), "utf8"), numbered({ 5: "five", 7: "seven" }));
      return review();
    },
  }, human);
  // The only Agent is the reviewer, and it runs after `rebase`.
  assert.equal(result.state, "delivered"); untouched(f); assert.deepEqual(human.requests, []); assert.equal(reviews, 1);
  assert.deepEqual(result.states, ["shape", "prepare", "rebase", "verify", "sealReview", "review", "reviewResult", "commit", "rebase", "deliver", "success", "delivered"]);
  const commit = onTip(f, tip); assert.notEqual(commit, delivered); assert.equal(others(f), refs);
  assert.equal(git(f.repo, "show", `${branch}:lines.txt`), numbered({ 5: "five", 7: "seven" }).trim()); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello");
  const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u"));
  assert.deepEqual([run.delivery.outcome, run.delivery.baseCommit, run.delivery.commit, run.delivery.resumed], ["delivered", tip, commit, true]);
  assert.equal(rebasedFrom(f, run, started), delivered);
  // The gates ran once, in `verify` ahead of the review; nothing is verified as `reverify`.
  assert.deepEqual([phases(run), run.result.checksPassed, run.result.agents.map((agent: any) => agent.stage)], [["verify"], true, ["review"]]);
  assert.equal(deliveredAs(f), commit);
  const said = between(result, run); assert.match(said, oneSentence); assert.match(said, /\breplayed\b/iu);
});

test("with resume, gates that fail on a delivered ticket's replayed tree are a gate failure on the new base: the commit is undone there, repaired, reviewed, and delivered", async context => {
  const f = fixture(context); const started = f.head; const checks = [command(), command(greetsLater, { name: "later-gate" })]; let reviews = 0; let edits = 0;
  const delivered = await deliverFirst(f, input(f, { checks }));
  const tip = advance(f); const again = next(f, 2);
  const result = await execute(input(again, { checks }, { resume: true }), {
    ...nobody,
    implementer: request => {
      edits++;
      // With the implementer: the candidate is uncommitted on the new tip, and the failed gate is named.
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), tip); assert.equal(candidate(request.cwd).status, "?? greeting.test.txt\n?? greeting.txt");
      assert.match(request.prompt.split("Current failure/feedback: ")[1] ?? "", /later-gate/u);
      writeFileSync(join(request.cwd, "greeting.txt"), "hello later\n"); return ok();
    },
    reviewer: () => { reviews++; return review(); },
  });
  assert.equal(result.state, "delivered"); untouched(f); assert.deepEqual([edits, reviews], [1, 1]);
  assert.deepEqual(result.states, ["shape", "prepare", "rebase", "repairBudget", "repairTarget", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult",
    "commit", "rebase", "deliver", "success", "delivered"]);
  const commit = onTip(f, tip); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello later");
  const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u"));
  // On this road the gates are the helper's `verify` from the start, so the receipt never says a tree passed that did not.
  assert.deepEqual(ran(run), [["verify", "tests", true], ["verify", "later-gate", false], ["verify", "later-gate", false], ["verify", "tests", true], ["verify", "later-gate", true]]);
  assert.deepEqual([run.delivery.baseCommit, run.delivery.commit, run.result.checksPassed, run.result.repairs], [tip, commit, true, 1]);
  assert.equal(rebasedFrom(f, run, started), delivered); assert.equal(deliveredAs(f), commit);
});

test("with resume, setup that fails on the new tip stops a delivered ticket there with its question: the replayed commit is undone and the candidate is uncommitted on the tip", async context => {
  const f = fixture(context); const human = person("hand off");
  const setup = [command('process.exit(require("fs").existsSync("later.txt") ? 3 : 0)', { name: "install" })];
  const delivered = await deliverFirst(f, input(f, { setup }));
  const tip = advance(f); const refs = others(f); const again = next(f, 2);
  const result = await execute(input(again, { setup }, { resume: true, stuck: "park" }), nobody, human);
  assert.deepEqual(result.states, ["shape", "prepare", "rebase", "stuck", "decide", "handOff", "handedOff"]);
  const run = questionedIn("rebase", again, result, /setup: install failed/u, human); untouched(f); assert.equal(human.requests.length, 1);
  // As after any failed setup on a new tip: no commit on the branch, and the candidate beside the base's later file.
  const now = candidate(f.worktree); assert.equal(now.status, "?? greeting.test.txt\n?? greeting.txt"); assert.ok(existsSync(join(f.worktree, "later.txt")));
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8").trim(), git(f.repo, "show", `${delivered}:greeting.txt`));
  uncommitted(f, run, tip, now); assert.equal(others(f), refs);
  assert.deepEqual([ran(run), run.result.agentInvocations], [[["setup", "install", true], ["setup", "install", false]], 0]); assert.notEqual(run.result.checksPassed, true);
});

for (const [label, repository, reason, states, checked] of [
  ["a setup command that fails where the worktree was recreated", { setup: [command("process.exit(3)", { name: "install" })] }, /\bsetup\b|\binstall\b/iu,
    ["shape", "prepare", "refuse", "refused"], [["setup", "install", false]]],
  ["a setup command that leaves an unignored file where the worktree was recreated", { setup: [command('require("fs").writeFileSync("setup-output.txt", "leftover")', { name: "install" })] }, /\bsetup\b|\binstall\b/iu,
    ["shape", "prepare", "refuse", "refused"], [["setup", "install", true]]],
] as const) {
  test(`with resume, ${label} refuses the delivered ticket: the recreated worktree is removed, and the branch, its record, and every other ref are as they were`, async context => {
    const f = fixture(context); const delivered = await deliverFirst(f); const before = everything(f); const again = next(f, 2);
    const result = await execute(input(again, repository, { resume: true }), nobody);
    // It ends by itself, as other refusals do: setup that fails on a commit already delivered leaves nothing to repair, and nobody to ask.
    assert.equal(result.state, "refused"); assert.deepEqual(result.states, states); untouched(f);
    const run = refused(again, result, reason); assert.match(run.delivery.reason, /^Cannot resume: /u);
    assert.doesNotMatch(result.output.summary, /Worktree kept/u); assert.equal(existsSync(f.worktree), false);
    assert.deepEqual(everything(f), before); assert.deepEqual([git(f.repo, "rev-parse", branch), deliveredAs(f)], [delivered, delivered]);
    assert.deepEqual([run.delivery.outcome, run.delivery.commit, run.delivery.worktreeRemoved, run.result.outcome, run.result.agentInvocations], ["refused", null, true, "blocked", 0]);
    // The receipt does not say the delivered commit passed: this run's own checks are all it has.
    assert.notEqual(run.result.checksPassed, true); assert.deepEqual(ran(run), checked);
  });
}

test("with resume, gates that fail on a redelivered commit when the base has not moved go to the repair loop, as any red check does, and are never offered as retry", async context => {
  const f = fixture(context); const delivered = await deliverFirst(f); const again = next(f, 2); let edits = 0; let reviews = 0;
  // A gate the delivered greeting does not meet; the repaired one does.
  const checks = [command(), command('if (!require("fs").readFileSync("greeting.txt", "utf8").includes("again")) { console.log("greeting.txt does not say again"); process.exit(1); }', { name: "again-gate" })];
  const human = person();
  const result = await execute(input(again, { checks }, { resume: true }), {
    ...nobody,
    implementer: request => {
      edits++;
      // With the implementer: the delivered commit is undone on its own base, so the candidate is uncommitted there, and the failed gate is named.
      assert.equal(git(request.cwd, "rev-parse", "HEAD"), f.head); assert.equal(candidate(request.cwd).status, "?? greeting.test.txt\n?? greeting.txt");
      assert.match(request.prompt.split("Current failure/feedback: ")[1] ?? "", /again-gate/u);
      writeFileSync(join(request.cwd, "greeting.txt"), "hello again\n"); return ok();
    },
    reviewer: () => { reviews++; return review(); },
  }, human);
  assert.equal(result.state, "delivered"); untouched(f); assert.deepEqual([edits, reviews, human.requests.length], [1, 1, 0]);
  assert.deepEqual(result.states, ["shape", "prepare", "rebase", "repairBudget", "repairTarget", "change", "scopeAfterChange", "verify", "sealReview", "review", "reviewResult",
    "commit", "rebase", "deliver", "success", "delivered"]);
  for (const state of ["stepFailed", "stepDecide", "keepDecide", "refuse", "stuck"]) assert.equal(result.states.includes(state), false, state);
  const commit = onTip(f, f.head); assert.notEqual(commit, delivered); assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello again");
  const run = held(again, result, new RegExp(`^Delivered ${branch} at ${commit}`, "u"));
  assert.deepEqual([run.delivery.outcome, run.delivery.baseCommit, run.delivery.commit, run.delivery.redelivered, run.result.checksPassed, run.result.repairs], ["delivered", f.head, commit, undefined, true, 1]);
  assert.deepEqual(ran(run), [["verify", "tests", true], ["verify", "again-gate", false], ["verify", "again-gate", false], ["verify", "tests", true], ["verify", "again-gate", true]]);
  assert.equal(deliveredAs(f), commit);
});

test("with resume in pr mode, a delivered ticket is not taken up: the run is refused, saying the pull request is brought up to date at its host, and nothing is changed or asked of the remote", async context => {
  const path = process.env.PATH; const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); const calls = recordGit(context, f);
  context.after(() => { process.env.PATH = path; });
  // The first pull request was closed without merging and handed off: its branch keeps the delivered commit and its record.
  writeFileSync(join(f.root, "bin/views"), "CLOSED\n");
  const first = await execute(input(f, { output: "pr" }), {}, person("hand off"));
  assert.equal(first.state, "handedOff"); assert.equal(existsSync(f.worktree), false);
  assert.equal(git(f.repo, "rev-list", "--count", `${f.head}..${branch}`), "1");
  const delivered = git(f.repo, "rev-parse", branch); assert.equal(deliveredAs(f), delivered);
  // The base moves on and is published, as its owner leaves it: only the output mode stands in the way.
  advance(f); git(f.repo, "push", "-q", "origin", "main");
  rmSync(join(f.root, "bin/args")); const before = [everything(f), pushed(), gh.views()]; const since = calls().length; const again = next(f, 2);
  const result = await execute(input(again, { output: "pr", setup: [command("process.exit(1)", { name: "install" })] }, { resume: true }), nobody);
  assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
  const run = held(again, result, /^Refused: .*\bpull request\b.*\bhost\b/iu); assert.doesNotMatch(result.output.summary, /Worktree kept/u);
  assert.deepEqual([run.delivery.outcome, run.delivery.commit, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.result.checks.length, run.result.agentInvocations],
    ["refused", null, false, false, 0, 0]);
  assert.deepEqual([everything(f), pushed(), gh.views()], before); assert.equal(git(f.repo, "rev-parse", branch), delivered); assert.equal(gh(), undefined);
  assert.deepEqual(calls().slice(since).filter(call => /^(?:ls-remote|fetch|push|worktree add)(?:\s|$)/u.test(call)), []);
});

/** The branch an earlier run of the ticket made and recorded, with no worktree left for it. */
const branchOnly = (f: Fixture, at = f.head) => { git(f.repo, "branch", branch, at); git(f.repo, "config", `branch.${branch}.ticket`, "proj-12"); };
const refusals: [label: string, arrange: (f: Fixture) => unknown, reason?: RegExp][] = [
  // Only a commit that a run delivered is taken up: the record must be there, and must name the branch's tip.
  ["a delivered commit whose record is gone, as on a branch delivered before commits were recorded", async f => {
    await deliverFirst(f); if (deliveredAs(f)) git(f.repo, "config", "--local", "--unset", deliveredKey);
  }, /deliver/iu],
  ["a commit of the right shape that a person made and no run delivered", f => { branchOnly(f, byHand(f, f.head)); }, /deliver/iu],
  ["a commit put in place of the delivered one, while the record still names the delivered commit", async f => {
    git(f.repo, "config", deliveredKey, await deliverFirst(f)); git(f.repo, "update-ref", `refs/heads/${branch}`, byHand(f, f.head));
  }, /deliver/iu],
  ["a record that names the commit below the delivered one", async f => { await deliverFirst(f); git(f.repo, "config", deliveredKey, f.head); }, /deliver/iu],
  // Every other refusal stays. Each commit below is recorded as delivered, so its shape alone is what refuses it.
  ["a second branch of the ticket beside the delivered one", async f => {
    await deliverFirst(f); git(f.repo, "branch", "ticket/proj-12-an-earlier-title", f.head); git(f.repo, "config", "branch.ticket/proj-12-an-earlier-title.ticket", "proj-12");
  }],
  ["a branch beside the delivered one that may be this ticket's, with no record of whose it is", async f => { await deliverFirst(f); git(f.repo, "branch", "ticket/proj-12-1", f.head); }],
  ["a branch that holds a second commit above the delivered one", async f => { place(f, byHand(f, await deliverFirst(f))); }],
  ["a commit under another subject", async f => { await deliverFirst(f); place(f, byHand(f, f.head, ["Add a salutation", "Ticket: PROJ-12"])); }],
  ["a commit whose Ticket: line names another ticket", async f => { await deliverFirst(f); place(f, byHand(f, f.head, ["Add a greeting", "Ticket: PROJ-13"])); }],
  ["a commit with no Ticket: line", async f => { await deliverFirst(f); place(f, byHand(f, f.head, ["Add a greeting"])); }],
  ["a merge commit at the tip, the one commit above the base", async f => {
    const older = f.head; const tip = advance(f); const delivered = await deliverFirst(f);
    place(f, git(f.repo, "commit-tree", git(f.repo, "rev-parse", `${delivered}^{tree}`), "-p", tip, "-p", older, "-m", "Add a greeting", "-m", "Ticket: PROJ-12"));
  }],
  ["a base moved back behind the commit the delivery stands on", async f => {
    advance(f); await deliverFirst(f); git(f.repo, "reset", "-q", "--hard", "HEAD^"); f.head = git(f.repo, "rev-parse", "HEAD");
  }],
  ["a delivered commit the base already holds", async f => { await deliverFirst(f); git(f.repo, "merge", "-q", "--ff-only", branch); f.head = git(f.repo, "rev-parse", "HEAD"); }],
  ["a branch still at its base", f => { branchOnly(f); }, /worktree directory .+ does not exist; nothing was changed/u],
];
for (const [label, arrange, reason] of refusals) {
  test(`resume with no worktree and ${label} is refused without changing anything`, async context => {
    const f = fixture(context); await arrange(f); const before = everything(f); const again = next(f, 2);
    const result = await execute(input(again, { setup: [command("process.exit(1)", { name: "install" })] }, { resume: true }), nobody);
    assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); untouched(f);
    const run = held(again, result, /^Refused: Cannot resume: /u); if (reason) assert.match(run.delivery.reason, reason);
    assert.doesNotMatch(result.output.summary, /Worktree kept/u);
    assert.deepEqual([run.delivery.outcome, run.delivery.resumed, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit, run.result.checks.length, run.result.agentInvocations],
      ["refused", undefined, false, false, null, 0, 0]);
    assert.deepEqual(everything(f), before);
  });
}

for (const path of ["docs/catalog.md"]) {
  test(`${path} describes, where it describes resume, taking up a delivered ticket whose worktree is gone: the record it needs, the road to rebase, and what the receipt says`, () => {
    const text = readFileSync(resolve(path), "utf8"); const prose = text.replace(/\s+/gu, " ");
    assert.ok(statements(text).some(said => /\bresum/iu.test(said) && /\bdelivered\b/iu.test(said) && /`rebase`/u.test(said)),
      `${path} must say in one sentence or table row that resume takes up a delivered commit and continues at \`rebase\``);
    assert.match(prose, /ticketDelivered/u, `${path} must name the record a delivery leaves with the branch`);
    assert.match(prose, /\bredelivered\b/u, `${path} must name what delivery.json records when the same commit is delivered again`);
  });
}

test("the catalog says which delivered commits resume refuses, what pr mode does instead, and no longer says what the delivered-candidate resume made untrue", () => {
  const said = statements(readFileSync(resolve("docs/catalog.md"), "utf8"));
  assert.ok(said.some(one => /\brecord/iu.test(one) && /\bdeliver/iu.test(one) && /\brefus|\bnot adopted\b|Cannot resume/iu.test(one)),
    "docs/catalog.md must say in one sentence or table row that a commit with no delivery record, or one whose record names another commit, is refused");
  assert.ok(said.some(one => /\bpull request\b/iu.test(one) && /\bhost\b/iu.test(one) && /\bresum|\bdelivered\b/iu.test(one)),
    "docs/catalog.md must say in one sentence or table row that in pr mode the pull request is brought up to date at its host");
  // Setup does run again on this road, the run does create its worktree, and a branch that holds a delivered commit is continued:
  // a sentence that still says otherwise must say where the delivered commit is the exception.
  const excepted = (one: string) => /\bdelivered\b|\brecreat/iu.test(one);
  assert.equal(said.some(one => one.trim() === "Setup commands are not run again."), false, "docs/catalog.md still says without exception that setup commands are not run again");
  assert.equal(said.some(one => /a resumed run, whose `worktreeCreated` is false/u.test(one) && !excepted(one)), false, "docs/catalog.md still says every resumed run has worktreeCreated false");
  assert.equal(said.some(one => /continue a branch that already holds a commit/u.test(one) && !excepted(one)), false, "docs/catalog.md still says resume never continues a branch that holds a commit");
});

test("a delivered ticket can follow successive base moves, with every run testing and recording its own delivery", async context => {
  const f = fixture(context);
  let delivered = await deliverFirst(f);
  let parent = f.head;
  for (const number of [2, 3, 4]) {
    const tip = number === 2 ? parent : advance(f, `base-${number}.txt`);
    const again = next(f, number);
    const result = await execute(input(again, {}, { resume: true }), nobody);
    assert.deepEqual(result.states, ["shape", "prepare", "rebase", "deliver", "success", "delivered"]);
    const run = held(again, result, /^Delivered /u);
    const commit = onTip(f, tip);
    assert.equal(deliveredAs(f), commit);
    assert.deepEqual([phases(run), run.result.checksPassed, run.result.agentInvocations], [["verify"], true, 0]);
    if (number === 2) {
      assert.equal(commit, delivered);
      assert.equal(run.delivery.redelivered, true);
    } else {
      assert.deepEqual(run.delivery.rebasedFrom, { baseCommit: parent, commit: delivered });
      assert.notEqual(commit, delivered);
    }
    delivered = commit;
    parent = tip;
  }
});

for (const stale of [true, false]) {
  test(`delivered resume refuses ${stale ? "a stale worktree registration" : "a branch checked out elsewhere"} without forcing recreation`, async context => {
    const f = fixture(context); await deliverFirst(f);
    const registered = stale ? f.worktree : join(f.root, "elsewhere");
    git(f.repo, "worktree", "add", registered, branch);
    if (stale) rmSync(registered, { recursive: true, force: true });
    const before = everything(f); const again = next(f, 2);
    const result = await execute(input(again, {}, { resume: true }), nobody);
    assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]);
    const run = held(again, result, /^Refused: Cannot resume: the worktree could not be recreated/u);
    assert.deepEqual(everything(f), before);
    assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.result.checks.length], [false, false, 0]);
  });
}

test("failed withdrawal is still refused, reports the recreated worktree as kept, and never claims that nothing changed", async context => {
  const f = fixture(context); const delivered = await deliverFirst(f); const again = next(f, 2);
  // Setup locks the recreated worktree and then fails, so the withdrawal that follows cannot remove it.
  const result = await execute(input(again, {
    setup: [{ name: "lock", command: ["git", "worktree", "lock", f.worktree] }, command("process.exit(1)", { name: "install" })],
  }, { resume: true }), nobody);
  assert.equal(result.state, "refused"); assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]);
  const run = refused(again, result, /^Cannot resume: .*recreated worktree could not be removed/u);
  assert.match(result.output.summary, /^Refused: Cannot resume: .*recreated worktree could not be removed/u);
  assert.ok(result.output.summary.includes(`Worktree kept at ${f.worktree}.`));
  assert.doesNotMatch(result.output.summary, /nothing was changed/iu);
  assert.deepEqual([run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit], [true, false, null]); assert.notEqual(run.result.checksPassed, true);
  assert.ok(existsSync(f.worktree));
  assert.deepEqual([git(f.repo, "rev-parse", branch), deliveredAs(f)], [delivered, delivered]);
});

test("resume with a regular file as the worktree root refuses without changing anything and writes its receipts", async context => {
  const f = fixture(context);
  const root = join(f.root, "worktrees"); writeFileSync(root, "keep this file\n");
  const snapshot = () => [git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), git(f.repo, "worktree", "list", "--porcelain"),
    git(f.repo, "config", "--local", "--list"), readFileSync(root, "utf8")];
  const before = snapshot();
  const result = await execute(input(f, { setup: [command("process.exit(1)")] }, { resume: true }), nobody);
  assert.deepEqual(result.states, ["shape", "prepare", "refuse", "refused"]); assert.equal(result.state, "refused"); untouched(f);
  const run = held(f, result, /^Refused: Cannot resume: worktree directory .+ does not exist; nothing was changed\. Evidence: /u);
  assert.deepEqual([run.delivery.outcome, run.delivery.worktreeCreated, run.delivery.worktreeRemoved, run.delivery.commit,
    run.result.outcome, run.result.checks.length, run.result.agentInvocations], ["refused", false, false, null, "blocked", 0, 0]);
  assert.deepEqual(snapshot(), before);
});

/** The text of a level-two or level-three section, up to the next heading of the same or a higher level. */
function sectionOf(text: string, heading: string) {
  const start = text.search(new RegExp(`^(#{2,3}) ${heading}\\b`, "mu"));
  if (start < 0) return undefined;
  const level = /^#+/u.exec(text.slice(start))![0].length;
  const rest = text.slice(start).split("\n").slice(1).join("\n");
  const end = rest.search(new RegExp(`^#{1,${level}} `, "mu"));
  return end < 0 ? rest : rest.slice(0, end);
}
test("the ticket-task page gives each step that can fail its recovery in one table, the catalog's Recovery section links to it, and no document lists blocked among ticket-task's endings", () => {
  const page = readFileSync(resolve("docs/workflows/ticket-task.md"), "utf8");
  const table = sectionOf(page, "Recovery by step");
  assert.ok(table !== undefined, "docs/workflows/ticket-task.md has no Recovery by step section");
  const rows = table.split("\n").filter(line => line.startsWith("|"));
  for (const step of ["shape", "prepare", "commit", "rebase", "deliver", "success", "cleanUp", "dropLocal", "archive", "remove"]) {
    assert.ok(rows.some(row => row.split("|")[1]!.includes(`\`${step}\``)), `the recovery table has no row for ${step}`);
  }
  const prose = table.replace(/\s+/gu, " ");
  for (const said of [/`retry`/u, /`hand off`/u, /`discard`/u, /`refused`/u, /`delivered`/u, /repair/iu, /\b(?:1|one) minute\b|`1m`/iu, /\b(?:3|three)\b/u]) assert.match(prose, said);
  const recovery = sectionOf(readFileSync(resolve("docs/catalog.md"), "utf8"), "Recovery");
  assert.ok(recovery?.includes("workflows/ticket-task.md#recovery-by-step"), "the catalog's Recovery section does not link to the ticket-task recovery table");
  // Ticket-task's final states, as each document lists them.
  const results = sectionOf(page, "Results") ?? "";
  assert.doesNotMatch(results, /\*\*`blocked`\*\*/u, "the ticket-task page still lists blocked as an ending");
  assert.match(results, /\*\*`refused`\*\*/u, "the ticket-task page does not list refused as an ending");
  assert.doesNotMatch(page, /\bblocked\(\(/u, "the ticket-task diagram still has a blocked ending");
  const catalog = readFileSync(resolve("docs/catalog.md"), "utf8");
  const finals = statements(catalog).filter(said => said.startsWith("Final states are "));
  assert.equal(finals.length, 1, "the catalog lists ticket-task's final states once");
  assert.doesNotMatch(finals[0]!, /`blocked`/u); assert.match(finals[0]!, /`refused`/u);
  const readme = sectionOf(readFileSync(resolve("README.md"), "utf8"), "Ticket delivery") ?? "";
  assert.ok(readme, "README.md has no Ticket delivery section");
  assert.doesNotMatch(readme, /ends `blocked`|\bblocks before\b/u, "the README still says a ticket run ends blocked");
  assert.match(readme, /`refused`/u, "the README does not name the refused ending");
});

test("the ticket-task page, the catalog's Recovery section, and the README say a replay conflict at delivery moves the candidate onto the tip in the same run, once, with org-26 and org-47 as the reason", () => {
  const page = readFileSync(resolve("docs/workflows/ticket-task.md"), "utf8");
  const catalog = readFileSync(resolve("docs/catalog.md"), "utf8");
  const recovery = sectionOf(catalog, "Recovery") ?? "";
  for (const [where, text] of [["docs/workflows/ticket-task.md", page], ["the catalog's Recovery section", recovery]] as const) {
    const said = statements(text);
    assert.ok(said.some(one => /\breplay/iu.test(one) && /\bconflict/iu.test(one) && /\bsame run\b/iu.test(one) && /\bimplementer\b/iu.test(one)),
      `${where} must say in one sentence or table row that a replay conflict goes to the implementer in the same run`);
    assert.ok(said.some(one => /\bonce\b/iu.test(one) && /\bmove/iu.test(one) && /\bstops?\b/iu.test(one)),
      `${where} must say in one sentence or table row that a run moves once and a second conflict stops`);
    assert.ok(said.some(one => /\bprepare\b|\bresumed run\b|\bwhen it resumed\b/iu.test(one) && /\bonce\b/iu.test(one) && /\bmove/iu.test(one)),
      `${where} must say that a move when a run resumed counts as its one move`);
    assert.ok(said.some(one => /\brepair budget\b/iu.test(one) && /\bconflict|\bsettl/iu.test(one)), `${where} must say the settling round uses the repair budget`);
    assert.ok(said.some(one => /\bfresh review\b|\breviewed again\b|\breview(?:ed)? afresh\b/iu.test(one)), `${where} must say the moved change gets a fresh review`);
    for (const ticket of ["org-26", "org-47"]) assert.ok(text.includes(ticket), `${where} must name ${ticket} as a reason`);
  }
  // Recovery by step: the rebase row says what a conflict now does, not that existing rules still apply.
  const row = (sectionOf(page, "Recovery by step") ?? "").split("\n").find(line => line.startsWith("|") && line.split("|")[1]!.includes("`rebase`")) ?? "";
  assert.match(row, /\bconflict/iu); assert.match(row, /\bimplementer\b/iu); assert.match(row, /\bonce\b/iu);
  assert.doesNotMatch(row, /Existing replay conflicts and repair rules still apply/u);
  // The catalog no longer says that only a resumed run moves a conflicting candidate.
  const state = catalog.split("\n").find(line => line.startsWith("| `rebase` |")) ?? "";
  assert.match(state, /\bconflict/iu, "the catalog's rebase row says what a replay conflict does"); assert.match(state, /\bimplementer\b/iu);
  assert.doesNotMatch(catalog.replace(/\s+/gu, " "), /The reason names the conflicting paths and new tip: a resumed run saves the candidate/u,
    "the catalog still says only a resumed run moves a conflicting candidate");
  const readme = sectionOf(readFileSync(resolve("README.md"), "utf8"), "Ticket delivery") ?? "";
  assert.ok(statements(readme).some(one => /\bconflict/iu.test(one) && /\bimplementer\b/iu.test(one) && /\bonce\b/iu.test(one)),
    "README.md's Ticket delivery section must say a replay conflict goes to the implementer once");
});

test("delivery retry after recording fails reuses the pull request that was already opened", async context => {
  const f = fixture(context); remote(f); const gh = fakeGh(context, f);
  const bin = join(f.root, "bin"); const lock = join(f.repo, ".git/config.lock"); const creates = join(f.root, "creates");
  renameSync(join(bin, "gh"), join(bin, "gh-fake"));
  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    `"${bin}/gh-fake" "$@" || exit $?`,
    `if [ "$1" = pr ] && [ "$2" = create ]; then echo create >> "${creates}"; touch "${lock}"; fi`,
  ].join("\n") + "\n", { mode: 0o755 });
  const human = person(() => { rmSync(lock); return "retry"; });
  const result = await untilEnd(input(f, { output: "pr" }), {}, human);
  const run = merged(f, result); untouched(f);
  assert.equal(readFileSync(creates, "utf8"), "create\n"); viewed(gh, 1);
  assert.equal(result.sleeps.length, 0, "configuration failures ask immediately");
  assert.equal(human.requests.length, 1); stepAsked(f, human.requests[0], "deliver", /git config failed; inspect .+git-config\.log/u, deliverChoices);
  asksWritten(run.directory, human.requests);
  assert.equal(result.states.filter(state => state === "commit").length, 1);
  assert.equal(result.states.filter(state => state === "review").length, 1);
  assert.equal(result.states.filter(state => state === "deliver").length, 2);
  assert.deepEqual(run.result.decisions, [{ stage: "deliverDecide", response: "retry" }]);
});

test("commit retry restores the verified index even when the candidate was already partly staged", async context => {
  const f = fixture(context); const hook = join(f.repo, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const human = person(() => {
    assert.equal(git(f.worktree, "diff", "--cached", "--name-only"), "greeting.txt");
    rmSync(hook); return "retry";
  });
  const result = await execute(input(f), {
    implementer: request => { const result = implement(request); git(request.cwd, "add", "greeting.txt"); return result; },
  }, human);
  assert.equal(result.state, "delivered"); untouched(f);
  assert.equal(result.states.filter(state => state === "review").length, 1);
  assert.equal(result.states.filter(state => state === "commit").length, 2);
  assert.equal(human.requests.length, 1); stepAsked(f, human.requests[0], "commit", /git commit failed/u, stepChoices);
  assert.deepEqual(evidence(f).result.decisions, [{ stage: "stepDecide", response: "retry" }]);
});

test("confirmed local discard retries only dropLocal after its deletion fails", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f, 0, ["CLOSED"]);
  const holder = join(f.root, "holder"); let placed = false;
  const human = person("discard", "confirm discard", () => { git(f.repo, "worktree", "remove", "--force", holder); return "retry"; });
  const result = await untilEnd(input(f, { output: "pr" }), {}, human, entry => {
    if (String(entry.value) === "dropLocal" && !placed) { placed = true; git(f.repo, "worktree", "add", "-q", holder, branch); }
  });
  retried(result, 3); viewed(gh, 1); untouched(f);
  assert.equal(result.state, "abandoned"); assert.deepEqual(result.states.slice(-3), ["dropLocal", "mergeAbandon", "abandoned"]);
  assert.equal(result.states.includes("cleanUp"), false);
  assert.equal(result.states.filter(state => state === "dropLocal").length, 2);
  assert.equal(human.requests.length, 3); mergeRetryAsked(human.requests[2], /git branch failed/u);
  const run = held(f, result, /^Abandoned: /u); asksWritten(run.directory, human.requests.slice(2));
  assert.equal(pushed(), `refs/heads/${branch} ${run.delivery.commit}`);
  assert.equal(git(f.repo, "branch", "--list", branch), "");
  const receipt = JSON.parse(readFileSync(join(run.directory, "merge.json"), "utf8"));
  assert.deepEqual([receipt.outcome, receipt.localDeleted, receipt.remoteDeleted], ["abandoned", true, false]);
  assert.deepEqual(run.result.decisions, []);
  assert.deepEqual([1, 2, 3].map(n => JSON.parse(readFileSync(join(run.directory, `human-${n}.json`), "utf8"))), [
    { stage: "mergeDecide", response: "discard" }, { stage: "confirmMergeDiscard", response: "confirm discard" }, { stage: "mergeRetryDecide", response: "retry" },
  ]);
});

test("setup configuration can fail twice and ask twice before retry continues the same worktree", async context => {
  const f = fixture(context); const lock = join(f.repo, ".git/config.lock"); let locked = false;
  const human = person("retry", () => { rmSync(lock); return "retry"; });
  const result = await execute(input(f), {}, human, {
    onEnter: entry => {
      if (String(entry.value) === "setup" && !locked) { locked = true; writeFileSync(lock, ""); }
    },
  });
  assert.equal(result.state, "delivered"); untouched(f);
  assert.equal(result.states.filter(state => state === "prepare").length, 1);
  assert.equal(result.states.filter(state => state === "setup").length, 3);
  assert.equal(human.requests.length, 2);
  for (const request of human.requests) stepAsked(f, request, "setup", /git config failed; inspect .+git-config\.log/u, stepChoices);
  asksWritten(evidence(f).directory, human.requests);
});

test("a completion receipt that cannot confirm passing verification ends refused instead of claiming delivery", async context => {
  const f = fixture(context); const saved = checkpointed();
  const result = await execute(input(f), {}, person(), {
    ...saved.options,
    onEnter: entry => {
      saved.options.onEnter!(entry);
      // Exercise finish's downgrade without changing the candidate or its review rules.
      if (String(entry.value) === "success") saved.data()!.task.lastChecksPassed = false;
    },
  });
  assert.equal(result.state, "refused"); assert.deepEqual(result.states.slice(-2), ["success", "refused"]);
  const run = evidence(f);
  assert.deepEqual([run.result.outcome, run.delivery.outcome], ["blocked", "refused"]);
  assert.match(run.delivery.reason, /final checkout no longer matches passing verification/u);
  assert.match(result.output.summary, /^Refused: /u);
});

/** Discover ownership records without prescribing the helper's filename or repository-key hash. */
function repositoryTurns(f: Fixture) {
  const records: { file: string; owner: { pid: number; [key: string]: unknown } }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      // Inspect only shared coordination files, never Git internals, candidates, or per-run evidence/status.
      if (file === f.repo || entry.name === ".git" || entry.name.startsWith("evidence") || entry.name.startsWith("widgets--")) continue;
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile()) continue;
      try {
        const owner = JSON.parse(readFileSync(file, "utf8"));
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) records.push({ file, owner });
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  visit(f.root);
  return records;
}

/** The lock must cover commit/replay/delivery, and must leave Agents and people free to take another turn. */
function assertRepositoryTurn(f: Fixture): RunHooks & { primitives: typeof runtime } {
  let state = "";
  const owned = () => {
    const turns = repositoryTurns(f);
    assert.equal(turns.length, 1, `${state} must hold exactly one repository turn`);
    assert.equal(turns[0]!.owner.pid, process.pid);
  };
  return {
    primitives: {
      ...runtime,
      operation: ((run: (...args: any[]) => any, on: any, options: any) => runtime.operation(async (...args: any[]) => {
        await Promise.resolve();
        const entered = state;
        if (["rebase", "deliver"].includes(entered)) owned();
        const event = await run(...args);
        if (entered === "commit" && event.type === "committed") owned();
        return event;
      }, on, options)) as typeof runtime.operation,
    },
    onEnter: entry => {
      state = String(entry.value);
      if (["change", "review", "decide", "stepDecide", "keepDecide", "handedOff", "delivered"].includes(state)) {
        assert.deepEqual(repositoryTurns(f), [], `${state} must release the repository turn`);
      }
    },
  };
}

function turnFixture(context: TestContext) {
  const f = fixture(context);
  writeFileSync(join(f.repo, "greeting.txt"), ["hello", "first=old", ...Array.from({ length: 12 }, (_, n) => `unchanged ${n}`), "second=old", "third=old", ""].join("\n"));
  git(f.repo, "add", "greeting.txt"); git(f.repo, "commit", "-qm", "shared greeting baseline");
  f.head = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "update-ref", "refs/heads/turn-base", f.head);
  return f;
}

type TurnMessage = { type: string; key?: string; state?: string; data?: any; commit?: string; message?: string; request?: number; published?: unknown[] };
/** Separate processes exercise the file lock rather than an in-memory mutex; all pauses and waits are bounded. */
function scriptedTurn(context: TestContext, f: Fixture, id: number, hold: string[] = [], line = "second", repositoryPath = f.repo) {
  const evidenceRoot = join(f.root, `evidence-turn-${id}`);
  const runId = randomUUID();
  const assignment = input(f, {
    path: repositoryPath, base: "refs/heads/turn-base",
    checks: [command('require("node:assert/strict").match(require("node:fs").readFileSync("greeting.txt", "utf8"), /^hello\\n/);')],
  }, { evidenceRoot, redGreen: false });
  assignment.ticket.id = `PROJ-${id}`;
  const name = `ticket/proj-${id}-add-a-greeting`;
  const config = join(f.root, `turn-${id}.json`);
  writeFileSync(config, JSON.stringify({ assignment, branch: name, hold, from: `${line}=old`, to: `${line}=new` }));
  const child = fork(resolve("tests/fixtures/ticket-turn-runner.ts"), [config], {
    // Keep Node's preload flags (including the checkout runtime loader), without inheriting test-runner flags.
    execArgv: process.execArgv.filter(arg => !arg.startsWith("--test")),
    env: { ...process.env, MACHINES_RUN_PARENT: runId, MACHINES_RUN_STATUS_DIR: join(evidenceRoot, "status") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: TurnMessage[] = [];
  let output = ""; let request = 0; let exited = false;
  child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  child.on("message", message => messages.push(message as TurnMessage));
  const exit = new Promise<void>(resolve => {
    child.on("exit", () => { exited = true; resolve(); });
    child.on("error", error => { messages.push({ type: "error", message: error.message }); exited = true; resolve(); });
  });
  const stop = async () => { if (!exited) child.kill("SIGKILL"); await exit; };
  context.after(stop);
  const waitFor = async (predicate: (message: TurnMessage) => boolean, description: string) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      const error = messages.find(message => message.type === "error");
      assert.equal(error, undefined, error?.message);
      assert.equal(exited, false, `Ticket ${id} exited before ${description}: ${output}`);
      await delay(20);
    }
    assert.fail(`Ticket ${id} did not reach ${description}; points: ${messages.filter(message => message.key).map(message => message.key).join(", ")}; ${output}`);
  };
  const inspect = async () => {
    child.send({ type: "inspect", request: ++request });
    return waitFor(message => message.type === "inspection" && message.request === request, "inspection");
  };
  return {
    child, name, runId, messages, evidenceRoot, stop, inspect,
    point: (key: string) => waitFor(message => message.type === "point" && message.key === key, key),
    result: () => waitFor(message => message.type === "result", "delivery"),
    release: (key: string) => child.send({ type: "release", key }),
    output: () => output,
  };
}

/** Read only the published record's current work, never private data or historical fields. */
function statusNotes(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(statusNotes);
  return Object.entries(value).flatMap(([key, entry]) =>
    ["now", "note"].includes(key) && typeof entry === "string" ? [entry] : []);
}
async function waitingForTurn(run: ReturnType<typeof scriptedTurn>) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const status = await run.inspect();
    assert.equal(run.messages.some(message => message.key === "commit:after:1"), false,
      "The waiting ticket committed while another ticket still owned the repository turn");
    const note = statusNotes(status.published).find(note => /wait|queue/iu.test(note) && /repository|turn|widgets/iu.test(note));
    if (note) return note;
    await delay(25);
  }
  assert.fail("A held repository turn must report waiting in now or note without asking a person");
}
function ownsTurn(f: Fixture, run: ReturnType<typeof scriptedTurn>, at: TurnMessage) {
  const turns = repositoryTurns(f);
  assert.equal(turns.length, 1, "The committed candidate must own a shared repository lock file");
  assert.equal(turns[0]!.owner.pid, run.child.pid);
  assert.ok([run.runId, basename(at.data.task.directory)].some(id => JSON.stringify(turns[0]!.owner).includes(id)),
    "The lock records its owning runtime or evidence run ID");
  return turns[0]!;
}

const deliveredTurn = (run: ReturnType<typeof scriptedTurn>, result: TurnMessage) => {
  assert.equal(result.state, "delivered");
  assert.equal(result.published?.length, 1, "The runtime publishes this run's status");
  assert.deepEqual(statusNotes(result.published), [], "Delivery must clear the published waiting message");
  assert.equal(result.data.task.result.checksPassed, true);
  const receipt = JSON.parse(readFileSync(join(result.data.task.directory, "delivery.json"), "utf8"));
  assert.equal(receipt.branch, run.name);
  return receipt;
};

test("repository turn: two concurrent tickets edit one file and the waiting ticket replays on the first delivery and reruns its gates", { timeout: 25_000 }, async context => {
  const f = turnFixture(context);
  const first = scriptedTurn(context, f, 21, ["review:agent:1", "commit:after:1"], "first");
  const second = scriptedTurn(context, f, 22, ["review:agent:1", "commit:after:1"]);
  try {
    await Promise.all([first.point("review:agent:1"), second.point("review:agent:1")]);
    first.release("review:agent:1"); await first.point("commit:after:1");
    second.release("review:agent:1"); await waitingForTurn(second);
    first.release("commit:after:1"); const a = await first.result(); deliveredTurn(first, a);
    // The test's integration action advances only this disposable base ref after delivery; ticket-task never merges.
    git(f.repo, "update-ref", "refs/heads/turn-base", a.commit!, f.head);
    await second.point("commit:after:1"); second.release("commit:after:1");
    const b = await second.result(); const receipt = deliveredTurn(second, b);
    assert.equal(git(f.repo, "rev-parse", `${second.name}^`), a.commit, "The second ticket is directly on the first delivered commit");
    assert.equal(receipt.baseCommit, a.commit);
    const contents = git(f.repo, "show", `${second.name}:greeting.txt`);
    assert.match(contents, /^first=new$/mu); assert.match(contents, /^second=new$/mu);
    assert.deepEqual(b.data.task.result.checks.map((check: any) => [check.phase, check.passed]), [["verify", true], ["reverify", true]]);
    assert.deepEqual(repositoryTurns(f), [], "Delivery releases the repository turn"); untouched(f);
  } finally { await Promise.all([first.stop(), second.stop()]); }
});

test("repository turn: a live owner's file records run and PID, reports waiting, and admits the waiter only after release", { timeout: 25_000 }, async context => {
  const f = turnFixture(context); const alias = join(f.root, "widgets-alias"); symlinkSync(f.repo, alias);
  const owner = scriptedTurn(context, f, 31, ["commit:after:1"], "first");
  let waiter: ReturnType<typeof scriptedTurn> | undefined;
  try {
    const committed = await owner.point("commit:after:1");
    const held = ownsTurn(f, owner, committed);
    // A second spelling of the same checkout and a separate evidence root must still share this turn.
    waiter = scriptedTurn(context, f, 32, ["commit:after:1"], "second", alias);
    await waitingForTurn(waiter);
    assert.deepEqual(repositoryTurns(f), [held], "A live owner's lock cannot be stolen or replaced by a waiter");
    owner.release("commit:after:1"); deliveredTurn(owner, await owner.result());
    const acquired = await waiter.point("commit:after:1"); ownsTurn(f, waiter, acquired);
    const status = await waiter.inspect();
    assert.equal(status.published?.length, 1);
    assert.deepEqual(statusNotes(status.published), [], "Acquiring the turn must clear the published waiting message before replay and delivery");
    waiter.release("commit:after:1"); deliveredTurn(waiter, await waiter.result());
    assert.deepEqual(repositoryTurns(f), []); untouched(f);
  } finally { await owner.stop(); await waiter?.stop(); }
});

test("repository turn: competing waiters reclaim a dead PID once, log the takeover, and remain exclusive", { timeout: 25_000 }, async context => {
  const f = turnFixture(context); const owner = scriptedTurn(context, f, 41, ["commit:after:1"], "first");
  const waiters: ReturnType<typeof scriptedTurn>[] = [];
  try {
    const held = ownsTurn(f, owner, await owner.point("commit:after:1"));
    waiters.push(scriptedTurn(context, f, 42, ["commit:after:1"], "second"), scriptedTurn(context, f, 43, ["commit:after:1"], "third"));
    await Promise.all(waiters.map(waitingForTurn));
    await owner.stop();
    assert.throws(() => process.kill(owner.child.pid!, 0), { code: "ESRCH" });
    const winner = await Promise.race(waiters.map(async run => ({ run, at: await run.point("commit:after:1") })));
    const loser = waiters.find(run => run !== winner.run)!;
    ownsTurn(f, winner.run, winner.at);
    await waitingForTurn(loser);
    const logs = winner.run.output() + readdirSync(winner.at.data.task.directory).filter(name => name.endsWith(".log"))
      .map(name => readFileSync(join(winner.at.data.task.directory, name), "utf8")).join("\n");
    assert.match(logs, /stale|dead|take.?over|reclaim/iu, "Stale takeover leaves an explanatory log line");
    assert.ok(logs.includes(String(held.owner.pid)), "The takeover log identifies the dead PID");
    winner.run.release("commit:after:1"); deliveredTurn(winner.run, await winner.run.result());
    const acquired = await loser.point("commit:after:1"); ownsTurn(f, loser, acquired);
    loser.release("commit:after:1"); deliveredTurn(loser, await loser.result());
    assert.deepEqual(repositoryTurns(f), []); untouched(f);
  } finally { await Promise.all([owner.stop(), ...waiters.map(run => run.stop())]); }
});

test("repository turn: conflict repair releases the turn and reacquires it before replaying onto a newer base", async context => {
  const f = fixture(context); let reviews = 0; let moved = ""; let current = ""; const prompts: string[] = [];
  const result = await execute(input(f), {
    implementer: request => {
      if (prompts.length === 1) {
        assert.deepEqual(repositoryTurns(f), [], "The implementer repairs without holding a repository turn");
        assert.equal(git(request.cwd, "rev-parse", "HEAD"), moved);
        current = advance(f, "later.txt", "The base can advance during conflict repair\n");
      }
      return settles(prompts)(request);
    },
    reviewer: () => { if (++reviews === 1) moved = advance(f, "greeting.txt", "hi\n"); return review(); },
  }, person(), assertRepositoryTurn(f));
  assert.equal(result.state, "delivered"); assert.equal(prompts.length, 2); assert.equal(reviews, 2);
  assert.equal(git(f.repo, "rev-parse", `${branch}^`), current);
  assert.equal(git(f.repo, "show", `${branch}:greeting.txt`), "hello\nhi");
  assert.deepEqual(phases(evidence(f)), ["red", "verify", "verify", "reverify"]);
  assert.deepEqual(repositoryTurns(f), []); untouched(f);
});

test("repository turn: the workflow documentation describes the commit-through-delivery turn in one paragraph", () => {
  const paragraphs = readFileSync(resolve("docs/workflows/ticket-task.md"), "utf8").split(/\n\s*\n/u);
  assert.ok(paragraphs.some(paragraph => /repository/iu.test(paragraph) && /turn|lock/iu.test(paragraph)
    && /commit/iu.test(paragraph) && /rebase|replay/iu.test(paragraph) && /deliver/iu.test(paragraph)
    && /wait/iu.test(paragraph) && /stale|dead|pid/iu.test(paragraph)),
  "One paragraph must describe the repository turn, waiting, and stale-owner recovery across commit, rebase, and delivery");
});

test("repository turn: different repositories sharing the worktree directory deliver independently", { timeout: 25_000 }, async context => {
  const firstRepo = turnFixture(context); const otherRepo = turnFixture(context);
  const first = scriptedTurn(context, firstRepo, 51, ["commit:after:1"], "first");
  let other: ReturnType<typeof scriptedTurn> | undefined;
  try {
    const held = ownsTurn(firstRepo, first, await first.point("commit:after:1"));
    other = scriptedTurn(context, firstRepo, 52, [], "second", otherRepo.repo);
    deliveredTurn(other, await other.result());
    assert.deepEqual(repositoryTurns(firstRepo), [held], "The other repository does not release this owner's turn");
    first.release("commit:after:1"); deliveredTurn(first, await first.result());
    assert.deepEqual(repositoryTurns(firstRepo), []);
    untouched(firstRepo); untouched(otherRepo);
  } finally { await Promise.all([first.stop(), other?.stop()]); }
});

test("repository turn: a commit failure releases before the person and retry reacquires", async context => {
  const f = fixture(context); const hook = join(f.repo, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const human = person(() => {
    assert.deepEqual(repositoryTurns(f), []);
    rmSync(hook); return "retry";
  });
  const result = await execute(input(f), {}, human, assertRepositoryTurn(f));
  assert.equal(result.state, "delivered"); assert.equal(human.requests.length, 1);
  assert.equal(result.states.filter(state => state === "commit").length, 2);
  assert.deepEqual(repositoryTurns(f), []);
});

for (const ending of ["stop", "error"] as const) test(`repository turn: actor ${ending} releases ownership while its PID remains alive`, async context => {
  const f = fixture(context); let state = ""; let actor: { stop: () => void };
  const primitives = {
    ...runtime,
    machine: ((config: any) => runtime.machine({ ...config, entry: [(args: any) => { actor = args.self; }, config.entry] })) as typeof runtime.machine,
    operation: ((run: (...args: any[]) => any, on: any, options: any) => runtime.operation(async (...args: any[]) => {
      await Promise.resolve();
      const entered = state; const event = await run(...args);
      if (entered === "commit" && event.type === "committed") {
        assert.equal(repositoryTurns(f).length, 1);
        if (ending === "error") throw new Error("Injected Operation failure after commit");
        actor.stop();
      }
      return event;
    }, on, options)) as typeof runtime.operation,
  };
  const result = execute(input(f), {}, person(), { primitives, onEnter: entry => { state = String(entry.value); } });
  if (ending === "error") await assert.rejects(result, /Injected Operation failure after commit/u);
  else await result;
  assert.deepEqual(repositoryTurns(f), []);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("repository turn: cancelling a waiter aborts polling and never acquires after release", async context => {
  const f = fixture(context);
  const { repositoryTurn } = await import("../defaults/_machine-shop/task.ts");
  const directory = join(f.root, ".machine-runs", "repository-turns");
  const owner = repositoryTurn(f.repo, directory, "owner");
  const waiter = repositoryTurn(f.repo, directory, "waiter");
  const controller = new AbortController();
  await owner.acquire(new AbortController().signal, () => {}, () => {});
  let waiting = false;
  const pending = waiter.acquire(controller.signal, note => { waiting ||= !!note; }, () => {});
  assert.equal(waiting, true);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  waiter.release(); assert.equal(repositoryTurns(f).length, 1, "A cancelled waiter must not release someone else's lock");
  owner.release(); await delay(150);
  assert.deepEqual(repositoryTurns(f), []);
});

test("repository turn: a sleeping delivery retry reacquires against the current base and reruns gates", async context => {
  const f = fixture(context); remote(f); fakeGh(context, f); failingPushes(f, 1);
  const assignment = input(f, { output: "pr" }); const saves = checkpointed();
  const first = await execute(assignment, {}, person(), { ...saves.options, onSleep: () => {} });
  assert.equal(first.state, "deliver"); assert.deepEqual(repositoryTurns(f), []);
  const checkpoint = saves.saved.deliver!;
  const tip = advance(f, "later.txt", "A new published base while the retry sleeps\n");
  git(f.repo, "push", "-q", "origin", "main");
  const resumed = checkpointed(checkpoint);
  const second = await execute(assignment, { implementer: () => assert.fail("Retry must keep the approved candidate"), reviewer: () => assert.fail("An unchanged replay does not need another review") }, person(), {
    ...resumed.options, continueAt: { value: checkpoint.value, context: checkpoint.context, due: new Date(0).toISOString(), retry: { attempt: 2, of: 4 } },
  });
  const run = merged(f, second);
  assert.equal(run.delivery.baseCommit, tip);
  assert.equal(git(f.repo, "rev-parse", `${run.delivery.commit}^`), tip);
  assert.deepEqual(phases(run), ["red", "verify", "reverify"]);
  assert.deepEqual(repositoryTurns(f), []);
});
