import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
async function execute(assignment: unknown, agents = {}) {
  const states: string[] = [];
  const result = await runtime.run(mod.default(runtime, assignment), {
    agents: { investigator: () => ok("ready", "Plan: add greeting.txt"), implementer: implement, reviewer: () => ok("approved", "Greeting matches the ticket"), ...agents },
    human: () => { throw new Error("Unexpected Human request"); }, onState: state => states.push(String(state)),
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

test("a ticket that triage finds unactionable is held with what is missing", async context => {
  const f = fixture(context);
  const result = await execute(input(f), { investigator: () => ok("blocked", "Acceptance criteria\nare missing"), implementer: () => assert.fail(), reviewer: () => assert.fail() });
  blocked(f, result, /Acceptance criteria\s+are missing/u);
  assert.ok(result.output.summary.startsWith(`Blocked: Acceptance criteria are missing. Worktree kept at ${f.worktree}. Evidence: `));
});

test("triage that edits the worktree blocks before implementation", async context => {
  const f = fixture(context);
  const result = await execute(input(f), { investigator: request => { writeFileSync(join(request.cwd, "code.txt"), "edited"); return ok("ready"); }, implementer: () => assert.fail(), reviewer: () => assert.fail() });
  blocked(f, result, /read-only stage/u);
});

test("an implementer blocker is returned without checks, review, or a commit", async context => {
  const f = fixture(context);
  const result = await execute(input(f), { implementer: () => ok("blocked", "Required API specification unavailable"), reviewer: () => assert.fail() });
  const run = blocked(f, result, /specification unavailable/u);
  assert.equal(run.result.checks.length, 0);
});

test("checks failing until the repair budget is exhausted commit and push nothing", async context => {
  const f = fixture(context); const pushed = remote(f); const gh = fakeGh(context, f); let edits = 0;
  const result = await execute(input(f, { output: "pr", checks: [command("process.exit(1)")] }, { maxRepairs: 2 }), {
    implementer: request => { edits++; return implement(request); }, reviewer: () => assert.fail(),
  });
  const run = blocked(f, result, /budget exhausted \(2\)/u);
  assert.equal(edits, 3); assert.deepEqual(run.result.checks.map(c => c.passed), [false, false, false]);
  assert.equal(pushed(), ""); assert.equal(gh(), undefined); assert.equal(run.delivery.commit, null);
  assert.equal(readFileSync(join(f.worktree, "greeting.txt"), "utf8"), "hello\n");
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
  const f = fixture(context);
  const result = await execute(input(f), { reviewer: request => { writeFileSync(join(request.cwd, "greeting.txt"), "unreviewed"); return ok("approved"); } });
  blocked(f, result, /read-only stage/u);
});

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
