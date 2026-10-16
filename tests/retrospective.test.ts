import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { runtime } from "./runtime.ts";

// Loaded per test, so the module's absence fails each test on its own.
const load = () => import(pathToFileURL(resolve("defaults", "retrospective.ts")).href);

const day = 24 * 60 * 60 * 1000;
const now = Date.now();
const date = (time: number) => new Date(time).toISOString().slice(0, 10);

/** A workspace that is not a Git repository, holding a ticket and a source file the Machine must leave alone. */
function workspace(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dev-retrospective-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".machine-runs", "machine-shop"), { recursive: true });
  mkdirSync(join(root, ".tickets"));
  writeFileSync(join(root, ".tickets", "alpha.md"), "# Alpha\n\nA ticket the retrospective only reads about.\n");
  writeFileSync(join(root, "code.txt"), "source");
  return root;
}

interface Run {
  /** started.json; false leaves it out, a string is written as it stands. */
  started?: false | string;
  questions?: string[];
  /** Strings are decide answers; objects are written as they stand. */
  answers?: (string | { stage: string; response: string })[];
  falsify?: unknown[];
  /** result.json; a string is written as it stands. */
  result?: Record<string, unknown> | string;
  /** Modification time of every file in the folder, unless times names the file. */
  at?: number;
  times?: Record<string, number>;
}
/** A ticket-task evidence folder as ticket-task.ts and task.ts write it. */
function run(ws: string, id: string, spec: Run) {
  const folder = join(ws, ".machine-runs", "machine-shop", id);
  mkdirSync(folder);
  const at = spec.at ?? now - day;
  if (spec.started !== false) {
    writeFileSync(join(folder, "started.json"), spec.started ?? JSON.stringify({ workflow: "ticket-task", workspace: join(ws, ".worktrees", id), startedAt: new Date(at - 60_000).toISOString() }));
  }
  writeFileSync(join(folder, "agent-1.json"), JSON.stringify({ stage: "falsify", outcome: "sound", summary: "The ticket holds up." }));
  spec.falsify?.forEach((report, index) => writeFileSync(join(folder, `falsify-${index + 1}.json`), JSON.stringify(report)));
  spec.questions?.forEach((text, index) => writeFileSync(join(folder, `question-${index + 1}.txt`), text));
  spec.answers?.forEach((answer, index) => writeFileSync(join(folder, `human-${index + 1}.json`), JSON.stringify(typeof answer === "string" ? { stage: "decide", response: answer } : answer)));
  if (spec.result !== undefined) writeFileSync(join(folder, "result.json"), typeof spec.result === "string" ? spec.result : JSON.stringify(spec.result, null, 2));
  for (const name of readdirSync(folder)) {
    const time = new Date(spec.times?.[name] ?? at);
    utimesSync(join(folder, name), time, time);
  }
  return id;
}
const result = (outcome: string, finishedAt: number, reason = "") => ({
  schemaVersion: 1, workflow: "ticket-task", outcome, workspace: "/fixture/worktree", task: "A fixture ticket",
  startedAt: new Date(finishedAt - day / 2).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
  repairs: 1, reviewRounds: 3, agentInvocations: 6, checksPassed: outcome === "completed", reason,
  checks: [], agents: [], decisions: [], report: "/fixture/result.json",
});
const options = [
  "hand off: stop here and keep the worktree and branch exactly as they are, with nothing committed, for another workflow or a person. (recommended)",
  "more rounds: restart the repair budget and return to the stage that stopped with the standing feedback.",
  "archive: commit the candidate and keep that commit as an archive branch, then remove the worktree.",
  "discard: remove the worktree and delete the branch without saving the candidate; asks for confirmation first.",
  "any other reply: answer the question and return to the stage that stopped with fresh budgets and this answer as standing feedback.",
].join("\n");
/** A stuck question as ticket-task.ts writes it. */
const question = (ticket: string, title: string, state: string, reason: string) =>
  `Ticket ${ticket} is stuck: answer what is needed\n\nTicket ${ticket}: ${title}. Stopped in ${state}.\nThis run is stuck and needs a decision: ${reason}\n\nNeeds: Explain how to resolve the remaining findings.\nWorktree: /fixture/worktrees/${ticket}\nBranch: ticket/${ticket}\n${options}`;
const budget = (ticket: string, where: string) => question(ticket, `Fixture ticket ${ticket}`, "reviewBudget",
  `Review budget exhausted (3). One blocker remains: an echo clears the reopened focus (${where}).\nBlocker: Recognize every queued echo, not only the last one (${where})`);
const scopeQuestion = "Should Scope include docs/catalog.md, which the change must describe?";
const scopeRecommended = "Widen Scope to include docs/catalog.md";
const scope = (ticket: string) => question(ticket, `Fixture ticket ${ticket}`, "falsifyResult",
  `Ticket owner must settle 1 open questions:\n1. ${scopeQuestion} Options: ${scopeRecommended} (recommended); Leave docs out Why: the catalog lists every Machine.`);
const scopeFalsify = { type: "questions", summary: "Scope leaves out the catalog.", questions: [{ text: scopeQuestion, options: [scopeRecommended, "Leave docs out"], recommended: scopeRecommended, assumable: false, why: "The catalog lists every Machine." }] };

/**
 * The analyst's contract, as the plan sets it: its prompt carries the extracted stops as one-line JSON (an array, or an object
 * with a stops array), each with an id and the key of its group; it returns classified, with a JSON summary of each stop's
 * {id, cause, needsNoPerson} and each group's {key, suggestion, repository}. The same fields are also put on the event itself.
 */
type Stop = { id: string; key: string } & Record<string, unknown>;
function stopsIn(prompt: string): Stop[] {
  const isStops = (value: unknown): value is Stop[] => Array.isArray(value) && value.length > 0
    && value.every(stop => stop && typeof stop.id === "string" && typeof stop.key === "string");
  for (const line of prompt.split("\n")) {
    for (let at = 0; at < line.length; at++) {
      if (line[at] !== "[" && line[at] !== "{") continue;
      let value: unknown;
      try { value = JSON.parse(line.slice(at)); } catch { continue; }
      if (isStops(value)) return value;
      if (value && typeof value === "object" && isStops((value as { stops?: unknown }).stops)) return (value as { stops: Stop[] }).stops;
    }
  }
  return assert.fail(`The analyst prompt carries no one-line JSON list of stops with id and key:\n${prompt}`);
}
const suggestion = "Suggested change for this cause";
function analyst(prompts: string[], cause: (stop: Stop) => string, needsNoPerson: (stop: Stop) => boolean = () => true) {
  return (request: { prompt: string }) => {
    prompts.push(request.prompt);
    const stops = stopsIn(request.prompt);
    const body = {
      stops: stops.map(stop => ({ id: stop.id, cause: cause(stop), needsNoPerson: needsNoPerson(stop) })),
      groups: [...new Set(stops.map(stop => stop.key))].map(key => ({ key, suggestion, repository: "machine-shop" })),
    };
    return { type: "classified", summary: JSON.stringify(body), ...body };
  };
}
const causeOf = (stop: Stop) => /review budget/iu.test(JSON.stringify(stop)) ? "Review budget spent on a blocker the implementer could fix" : "Scope widened only in an answer";

async function execute(workspaces: string[], agent: unknown, extra = {}) {
  const runs = join(workspaces[0]!, ".machine-runs", "machine-shop");
  const before = readdirSync(runs);
  const mod = await load();
  const outcome = await runtime.run(mod.default(runtime, { workspaces, ...extra }), {
    agents: { analyst: agent }, human: () => { throw new Error("Unexpected Human request"); },
  });
  const created = readdirSync(runs).filter(id => !before.includes(id));
  assert.equal(created.length, 1, `The Machine opens exactly one evidence folder of its own, found ${JSON.stringify(created)}`);
  const folder = join(runs, created[0]!);
  const report = outcome.output as unknown;
  assert.equal(typeof report, "string", "The Machine's output is its Markdown report");
  assert.equal(readFileSync(join(folder, "report.md"), "utf8").trim(), String(report).trim(), "The report is written to the run's evidence folder");
  return { state: outcome.value, report: String(report), folder };
}

/** The report's level-two sections, in order. */
function sections(report: string) {
  return report.split(/^(?=## )/mu).filter(part => part.startsWith("## ")).map(part => ({ heading: part.split("\n")[0]!, body: part }));
}
function section(report: string, pattern: RegExp, not?: RegExp) {
  const found = sections(report).find(part => pattern.test(part.heading) && !(not?.test(part.heading)));
  return found ?? assert.fail(`No "## " section matching ${pattern} in the report:\n${report}`);
}
const noPerson = (report: string) => section(report, /no person/iu);
const repeated = (report: string) => section(report, /repeat/iu);
const single = (report: string) => section(report, /single|once/iu, /repeat/iu);
const unreadable = (report: string) => section(report, /unreadable/iu);
const count = (n: number) => new RegExp(`\\b(?:count|stops)\\W{0,6}${n}\\b|\\b${n}\\s+(?:stops|runs|times)\\b|\\(${n}\\)|×\\s*${n}\\b`, "iu");

test("the report groups two spent review budgets under one cause, marks all three stops as needing no person, and leaves out the completed run", async context => {
  const ws = workspace(context);
  // The reviewer's blocker was fixed after the answer, and one run went on to complete while the other is still asleep.
  const first = run(ws, "run-budget-first", { questions: [budget("alpha", "src/hub.ts:120")], answers: ["Owner's answer: fix the reviewer's blocker, within Scope. Then return to review."], result: result("completed", now - day / 2) });
  const second = run(ws, "run-budget-second", { questions: [budget("beta", "src/hub.ts:340")], answers: ["Owner's answer: fix what the reviewer found and continue."] });
  const scoped = run(ws, "run-scope-question", { falsify: [scopeFalsify], questions: [scope("gamma")], answers: [`Owner's answer: take your recommended option: ${scopeRecommended}.`], result: result("completed", now - day / 2) });
  const completed = run(ws, "run-completed-quietly", { result: result("completed", now - day / 2) });
  const prompts: string[] = [];
  const { state, report } = await execute([ws], analyst(prompts, causeOf));
  assert.equal(state, "done");
  assert.ok(prompts.length > 0, "The analyst classifies the extracted stops");
  assert.ok(prompts.every(prompt => !prompt.includes(completed)), "The analyst is not given the completed run");
  assert.doesNotMatch(report, new RegExp(completed, "u"));

  const marked = noPerson(report); const group = repeated(report); const once = single(report);
  for (const id of [first, second, scoped]) assert.match(marked.body, new RegExp(id, "u"), `${id} is marked as needing no person`);
  const order = sections(report).map(part => part.heading);
  assert.ok(order.indexOf(marked.heading) < order.indexOf(group.heading), "The stops that needed no person come first");
  assert.ok(order.indexOf(group.heading) < order.indexOf(once.heading), "Repeated causes come before single stops");

  assert.match(group.body, new RegExp(first, "u")); assert.match(group.body, new RegExp(second, "u"));
  assert.match(group.body, count(2), "The repeated cause carries its count of 2");
  assert.match(group.body, /Review budget spent on a blocker the implementer could fix/u);
  assert.ok(group.body.includes(suggestion) && group.body.includes("machine-shop"), "The repeated cause has one suggested change and its repository");
  assert.doesNotMatch(group.body, new RegExp(scoped, "u"));
  assert.match(once.body, new RegExp(scoped, "u"));
  assert.doesNotMatch(once.body, new RegExp(`${first}|${second}`, "u"));
});

test("hand off, archive and discard answers stay marked as needing a person whatever the analyst says", async context => {
  const ws = workspace(context);
  const fixed = run(ws, "run-fixed-blocker", { questions: [budget("alpha", "src/hub.ts:120")], answers: ["Owner's answer: fix the reviewer's blocker."] });
  const kept = ["hand off", "archive", "discard"].map(answer => run(ws, `run-answered-${answer.replace(" ", "-")}`, { questions: [budget("beta", "src/hub.ts:340")], answers: [answer] }));
  const { report } = await execute([ws], analyst([], causeOf, () => true));
  const marked = noPerson(report);
  assert.match(marked.body, new RegExp(fixed, "u"));
  for (const id of kept) {
    assert.doesNotMatch(marked.body, new RegExp(id, "u"), `${id} needed a person`);
    assert.match(report, new RegExp(id, "u"), `${id} is still reported`);
  }
});

test("a stop outside the window is not reported", async context => {
  const ws = workspace(context);
  const since = date(now - 3 * day);
  const inside = run(ws, "run-recent-question", { questions: [budget("alpha", "src/hub.ts:120")], answers: ["Owner's answer: fix the reviewer's blocker."] });
  // Its question was asked before the window, though the run finished inside it: the question's own file time decides.
  const asked = run(ws, "run-question-before-window", {
    questions: [budget("beta", "src/hub.ts:340")], answers: ["Owner's answer: fix the reviewer's blocker."],
    result: result("completed", now - day), at: now - 10 * day, times: { "result.json": now - day },
  });
  const ended = run(ws, "run-blocked-before-window", { result: result("blocked", now - 10 * day, "Repair budget exhausted (3). lint failed"), at: now - 10 * day });
  const prompts: string[] = [];
  const { state, report } = await execute([ws], analyst(prompts, causeOf), { since });
  assert.equal(state, "done");
  assert.match(report, new RegExp(inside, "u"));
  for (const id of [asked, ended]) {
    assert.doesNotMatch(report, new RegExp(id, "u"), `${id} stopped before ${since}`);
    assert.ok(prompts.every(prompt => !prompt.includes(id)), `The analyst is not given ${id}`);
  }
});

test("a run whose evidence cannot be read is reported as unreadable by name, and the rest of the report is still written", async context => {
  const ws = workspace(context);
  const missing = run(ws, "run-without-started", { started: false, questions: [budget("alpha", "src/hub.ts:120")], answers: ["Owner's answer: fix the reviewer's blocker."] });
  const broken = run(ws, "run-with-broken-result", { questions: [budget("beta", "src/hub.ts:340")], answers: ["Owner's answer: fix the reviewer's blocker."], result: "{ not json" });
  const unanswered = run(ws, "run-with-more-answers-than-questions", { questions: [budget("gamma", "src/hub.ts:560")], answers: ["Owner's answer: fix the reviewer's blocker.", "Owner's answer: continue."] });
  // Readable: answers at other stages are ignored, and a run from before question files is classified from its result.
  const merged = run(ws, "run-with-merge-answer", { questions: [budget("delta", "src/hub.ts:780")], answers: ["Owner's answer: fix the reviewer's blocker.", { stage: "merge", response: "discard" }], result: result("blocked", now - day / 2, "Merge was discarded") });
  const older = run(ws, "run-without-question-files", { answers: ["Owner's answer: rerun the checks."], result: result("blocked", now - day / 2, "Repair budget exhausted (3). lint failed") });
  const { state, report } = await execute([ws], analyst([], causeOf));
  assert.equal(state, "done");
  const listed = unreadable(report);
  for (const id of [missing, broken, unanswered]) assert.match(listed.body, new RegExp(id, "u"), `${id} is reported as unreadable`);
  for (const id of [merged, older]) {
    assert.doesNotMatch(listed.body, new RegExp(id, "u"), `${id} is readable`);
    assert.match(report, new RegExp(id, "u"), `${id} is still reported`);
  }
  assert.match(noPerson(report).body, new RegExp(merged, "u"), "The readable stops are still classified and reported");
});

/** Every path under a directory with its kind, mode, modification time and content; directory times change when entries are added. */
function snapshot(root: string, skip?: string) {
  const entries: Record<string, string> = {};
  const walk = (path: string) => {
    if (path === skip) return;
    const stat = lstatSync(path);
    const name = relative(root, path) || ".";
    if (stat.isDirectory()) {
      entries[name] = `directory ${stat.mode}`;
      for (const child of readdirSync(path)) walk(join(path, child));
    } else if (stat.isSymbolicLink()) entries[name] = `link ${readlinkSync(path)}`;
    else entries[name] = `file ${stat.mode} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  };
  walk(root);
  return entries;
}

test("the Machine changes no file outside its own evidence folder in any workspace it reads", async context => {
  const first = workspace(context); const second = workspace(context);
  run(first, "run-budget-first", { questions: [budget("alpha", "src/hub.ts:120")], answers: ["Owner's answer: fix the reviewer's blocker."] });
  run(first, "run-completed-quietly", { result: result("completed", now - day / 2) });
  run(first, "run-without-started", { started: false, questions: [budget("beta", "src/hub.ts:340")], answers: ["Owner's answer: continue."] });
  const elsewhere = run(second, "run-budget-second", { questions: [budget("gamma", "src/hub.ts:560")], answers: ["Owner's answer: fix what the reviewer found."], result: result("blocked", now - day / 2, "Review budget exhausted (3).") });
  run(second, "run-scope-question", { falsify: [scopeFalsify], questions: [scope("delta")], answers: [`Owner's answer: take your recommended option: ${scopeRecommended}.`], result: result("completed", now - day / 2) });
  const before = [snapshot(first), snapshot(second)];
  const { state, report, folder } = await execute([first, second], analyst([], causeOf));
  assert.equal(state, "done");
  assert.match(report, new RegExp(elsewhere, "u"), "Every named workspace is read");
  assert.deepEqual(snapshot(first, folder), before[0]);
  assert.deepEqual(snapshot(second), before[1]);
});

test("invalid retrospective input is refused before effects", async context => {
  const ws = workspace(context);
  const mod = await load();
  const before = snapshot(ws);
  for (const input of [
    { workspaces: ["relative"] }, { workspaces: [] }, { workspaces: Array(21).fill(ws) },
    { workspaces: [ws], task: "unknown field" }, { workspaces: [ws], since: "yesterday" },
    { workspaces: [ws], since: "2026-02-30" }, { workspaces: [ws], since: "2026-1-01" },
  ]) assert.throws(() => mod.default(runtime, input));
  assert.deepEqual(snapshot(ws), before);
});

test("malformed analyst JSON retries once, then blocks with an incomplete report", async context => {
  const ws = workspace(context);
  const id = run(ws, "run-needing-classification", { questions: [budget("alpha", "src/hub.ts:120")], answers: ["continue"] });
  let calls = 0;
  const { state, report, folder } = await execute([ws], () => {
    calls++;
    return { type: "classified", summary: "not JSON" };
  });
  assert.equal(state, "blocked"); assert.equal(calls, 2);
  assert.match(report, /Classification blocked/u);
  assert.match(report, new RegExp(id, "u"));
  assert.doesNotMatch(noPerson(report).body, new RegExp(id, "u"));
  const receipt = JSON.parse(readFileSync(join(folder, "result.json"), "utf8"));
  assert.equal(receipt.repairs, 1); assert.equal(receipt.agentInvocations, 2);
  assert.match(receipt.reason, /Malformed analyst report/u);
});

for (const malformed of ["missing stop", "duplicate stop", "unknown stop", "missing group", "duplicate group", "unknown group", "invalid mark"]) {
  test(`classification coverage rejects ${malformed}, then accepts a corrected reply`, async context => {
    const ws = workspace(context);
    run(ws, "run-coverage", { questions: [budget("alpha", "src/hub.ts:120")], answers: ["continue"] });
    const valid = analyst([], causeOf);
    let calls = 0;
    const { state } = await execute([ws], (request: { prompt: string }) => {
      calls++;
      const response = valid(request);
      if (calls !== 1) return response;
      const body = JSON.parse(response.summary);
      if (malformed === "missing stop") body.stops = [];
      if (malformed === "duplicate stop") body.stops.push(body.stops[0]);
      if (malformed === "unknown stop") body.stops[0].id = "unknown";
      if (malformed === "missing group") body.groups = [];
      if (malformed === "duplicate group") body.groups.push(body.groups[0]);
      if (malformed === "unknown group") body.groups[0].key = "unknown";
      if (malformed === "invalid mark") body.stops[0].needsNoPerson = "yes";
      return { type: "classified", summary: JSON.stringify(body) };
    });
    assert.equal(state, "done"); assert.equal(calls, 2);
  });
}

test("empty and other-workflow evidence needs no analyst", async context => {
  const ws = workspace(context);
  run(ws, "other-workflow", { started: JSON.stringify({ workflow: "review-code", startedAt: new Date(now).toISOString() }), result: "broken JSON is outside the ticket-task selection" });
  run(ws, "only-started", {});
  run(ws, "quietly-completed", { result: result("completed", now - day) });
  const { state, report } = await execute([ws], () => assert.fail("No stops need classification"));
  assert.equal(state, "done");
  assert.doesNotMatch(report, /other-workflow|only-started|quietly-completed/u);
});

test("legacy completed answers form one stop using the ending time and answer as reason", async context => {
  const ws = workspace(context);
  run(ws, "legacy-completed", { answers: ["rerun the checks"], result: result("completed", now - day), at: now - 20 * day });
  run(ws, "legacy-blocked", { answers: ["continue"], result: result("blocked", now - day, "Repair budget exhausted (3).") });
  const prompts: string[] = [];
  const { state, report } = await execute([ws], analyst(prompts, stop => String(stop.reason)));
  assert.equal(state, "done");
  const stops = stopsIn(prompts[0]!);
  assert.equal(stops.length, 2);
  assert.equal(stops.find(stop => stop.run === "legacy-completed")!.reason, "rerun the checks");
  assert.ok(stops.every(stop => stop.question === null));
  assert.match(report, /No question text recorded/u);
});

test("recommendations use the latest preceding falsify report, answers match numeric order, and missing answers are not automatic", async context => {
  const ws = workspace(context);
  const firstQuestionTime = now - 2 * day;
  const secondQuestionTime = now - day;
  run(ws, "run-multiple-questions", {
    questions: [scope("alpha"), budget("alpha", "src/hub.ts:120"), budget("alpha", "src/hub.ts:340")],
    answers: [{ stage: "confirmDiscard", response: "go back" }, "take the recommendation", "fix the blocker"],
    falsify: [scopeFalsify, { ...scopeFalsify, questions: [{ text: "Later question", recommended: "Later recommendation" }] }],
    times: { "question-1.txt": firstQuestionTime, "question-2.txt": secondQuestionTime, "falsify-1.json": firstQuestionTime - 60_000, "falsify-2.json": secondQuestionTime + 60_000 },
  });
  const prompts: string[] = [];
  const { report } = await execute([ws], analyst(prompts, causeOf));
  const stops = stopsIn(prompts[0]!);
  assert.deepEqual(stops[0]!.answers, ["take the recommendation"]);
  assert.deepEqual(stops[1]!.answers, ["fix the blocker"]);
  assert.deepEqual(stops[2]!.answers, []);
  assert.deepEqual(stops[0]!.recommendations, [{ text: scopeQuestion, recommended: scopeRecommended }]);
  assert.ok(!JSON.stringify(stops).includes("Later recommendation"));
  assert.doesNotMatch(noPerson(report).body, /src\/hub.ts:340/u);
  assert.match(section(report, /not ended/iu).body, /run-multiple-questions/u);
  assert.ok(prompts[0]!.lastIndexOf("do not read any files") > prompts[0]!.indexOf("Read this run's check logs"));
});

test("symlinked runs are skipped and symlinked files and roots are not followed", async context => {
  const ws = workspace(context); const other = workspace(context);
  const outside = join(other, "outside.json");
  writeFileSync(outside, JSON.stringify({ workflow: "ticket-task", startedAt: new Date(now - day).toISOString() }));
  const root = join(ws, ".machine-runs", "machine-shop");
  symlinkSync(other, join(root, "linked-run"));
  mkdirSync(join(root, "linked-started"));
  symlinkSync(outside, join(root, "linked-started", "started.json"));
  run(ws, "invalid-stage", { questions: [budget("alpha", "src/hub.ts:120")] });
  writeFileSync(join(root, "invalid-stage", "review-1.json"), "not json");
  rmSync(join(other, ".machine-runs"), { recursive: true });
  symlinkSync(join(ws, ".machine-runs"), join(other, ".machine-runs"));
  const before = snapshot(other);
  const { state, report } = await execute([ws, other], () => assert.fail("Unreadable runs must not reach the analyst"));
  assert.equal(state, "done");
  assert.doesNotMatch(report, /linked-run/u);
  assert.match(unreadable(report).body, /linked-started/u);
  assert.match(unreadable(report).body, /invalid-stage/u);
  assert.match(unreadable(report).body, /Unsafe evidence directory/u);
  assert.deepEqual(snapshot(other), before);
});

test("an analyst blocker returns an incomplete report without a retry", async context => {
  const ws = workspace(context);
  run(ws, "run-ambiguous", { questions: [budget("alpha", "src/hub.ts:120")] });
  let calls = 0;
  const { state, report } = await execute([ws], () => { calls++; return { type: "blocked", summary: "Cannot infer a cause from this evidence" }; });
  assert.equal(state, "blocked"); assert.equal(calls, 1);
  assert.match(report, /Cannot infer a cause/u);
});

test("ending-only failures retain supplied repository, ticket and stage-report blocker locations", async context => {
  const ws = workspace(context);
  run(ws, "ending-only", { result: result("failed", now - day, "Operation failed before asking a question") });
  const folder = join(ws, ".machine-runs", "machine-shop", "ending-only");
  const stamp = new Date(now - 2 * day);
  for (const [name, body] of [
    ["delivery.json", { ticket: "org-45", repository: { name: "machine-shop", path: "/source/not-to-read" } }],
    ["review-1.json", { summary: "Blocker in defaults/example.ts:42" }],
  ] as const) {
    writeFileSync(join(folder, name), JSON.stringify(body));
    utimesSync(join(folder, name), stamp, stamp);
  }
  const prompts: string[] = [];
  const { state, report } = await execute([ws], analyst(prompts, stop => String(stop.reason)));
  assert.equal(state, "done");
  const stops = stopsIn(prompts[0]!);
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.ticket, "org-45");
  assert.deepEqual(stops[0]!.repository, { name: "machine-shop", path: "/source/not-to-read" });
  assert.match(report, /defaults\/example.ts:42/u);
  assert.match(report, /not the stop decision/u);
  assert.doesNotMatch(noPerson(report).body, /ending-only/u);
});

test("shuffled evidence listings pair twelve questions with numerically ordered decide answers", async context => {
  const ws = workspace(context);
  const questions = Array.from({ length: 12 }, (_, index) =>
    question("alpha", "Ordering", "reviewBudget", `Stop ${index + 1}.`));
  const answers = questions.map((_, index) => index === 2 ? "hand off" : `continue stop ${index + 1}`);
  const id = run(ws, "shuffled-evidence", { questions, answers, result: result("completed", now - day / 2) });
  const folder = join(ws, ".machine-runs", "machine-shop", id);
  writeFileSync(join(folder, "delivery.json"), "{}");
  const shuffled = [
    "human-3.json", "started.json", "human-1.json", "human-2.json", "delivery.json",
    "question-2.txt", "result.json", "question-1.txt", "question-3.txt", "agent-1.json",
    ...[12, 10, 8, 6, 4, 11, 9, 7, 5].flatMap(n => [`question-${n}.txt`, `human-${n}.json`]),
  ];
  assert.deepEqual([...shuffled].sort(), readdirSync(folder).sort());
  const original = fs.readdirSync;
  const mocked = context.mock.method(fs, "readdirSync", (...args: unknown[]) =>
    args[0] === folder ? [...shuffled] : Reflect.apply(original, fs, args));
  syncBuiltinESMExports();
  try {
    const prompts: string[] = [];
    const { state, report } = await execute([ws], analyst(prompts, stop => String(stop.reason)));
    assert.equal(state, "done");
    const stops = stopsIn(prompts[0]!);
    assert.equal(stops.length, questions.length);
    for (const [index, stop] of stops.entries()) {
      assert.equal(stop.question, questions[index]);
      assert.deepEqual(stop.answers, [answers[index]]);
    }
    assert.doesNotMatch(noPerson(report).body, /Cause: Stop 3\./u);
    assert.match(noPerson(report).body, /Cause: Stop 1\./u);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("singular and plural open-question reasons share one cause", async context => {
  const ws = workspace(context);
  for (const n of [1, 2]) run(ws, `scope-${n}`, {
    questions: [question("alpha", "Scope", "falsifyResult", `Ticket owner must settle ${n} open question${n === 1 ? "" : "s"}:\nScope needs an answer.`)],
    answers: ["continue"],
  });
  const { report } = await execute([ws], analyst([], causeOf));
  const grouped = repeated(report).body;
  assert.match(grouped, count(2));
  assert.match(grouped, /scope-1/u);
  assert.match(grouped, /scope-2/u);
});
