import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, parseCheck, object, text } from "./defaults/_dev-machines/task.ts";

export const description = "Carry one local ticket for one Git repository from an isolated worktree through triage, implementation, checks, and review to a delivered branch, patch, or draft pull request.";
export const agentRoles = {
  investigator: "Decides whether the ticket is actionable as written, without editing",
  implementer: "Implements the ticket and its tests in the worktree",
  reviewer: "Reviews evidence and the resulting change without editing",
};

const publishTimeoutMs = 120_000;

export default function ticketTask(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent, final } = p;
  const { ticket, repository, branch, worktree, evidenceRoot, work } = parseTicket(input);
  let baseCommit = "";
  let commitHash = "";
  let created = false;
  let reviewSummary = "";
  let prUrl = "";
  let patches: string[] = [];
  let held: { action: "hold"; summary: string } | undefined;

  /** A failed Git or gh step blocks with its output saved as evidence rather than copied into the ticket summary. */
  function attempt(file: string, args: string[], cwd: string, timeout?: number, failure = `${file} ${args[0]} failed`) {
    const done = run(file, args, cwd, timeout);
    if (!done.ok) {
      const log = join(work.open(), `${file}-${args[0]}.log`);
      writeFileSync(log, `${file} ${args.join(" ")}\n${done.stdout}\n${done.detail}\n`, { flag: "wx", mode: 0o600 });
      work.block(`${failure}; inspect ${log}`);
    }
    return done;
  }
  const pending = () => git(worktree, "status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).machine-runs");

  function prepare(): Event {
    const top = run("git", ["rev-parse", "--show-toplevel"], repository.path);
    if (!top.ok || realpathSync(top.stdout) !== realpathSync(repository.path)) throw new Error("repository.path must be a Git checkout root, not a subdirectory or a bare repository");
    // The lexical check at construction cannot see symlinks; nothing has been written yet.
    separate(real(repository.path), real(worktree), real(evidenceRoot));
    // Evidence lives under evidenceRoot, so a blocked preparation is recorded without touching the repository.
    work.open();
    const base = run("git", ["rev-parse", "--verify", "--quiet", `${repository.base ?? "HEAD"}^{commit}`], repository.path);
    if (!base.ok) return work.block(`Base ${repository.base ?? "HEAD"} does not resolve to a commit in ${repository.path}.`);
    baseCommit = base.stdout;
    if (run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repository.path).ok) {
      return work.block(`Branch ${branch} already exists in ${repository.path}; nothing was changed. Deliver or delete it before running this ticket again.`);
    }
    if (existsSync(worktree)) return work.block(`Worktree directory ${worktree} already exists; nothing was changed.`);
    if (!attempt("git", ["worktree", "add", "-b", branch, worktree, baseCommit], repository.path).ok) return { type: "blocked" };
    created = true;
    if (!repository.setup.every(command => work.check(command, "setup"))) return { type: "blocked" };
    if (pending() !== "") {
      return work.block("A setup command changed tracked or unignored files in the worktree; they would be committed with the ticket. Ignore its outputs in the repository.");
    }
    return { type: "prepared" };
  }

  function commit(): Event {
    if (git(worktree, "rev-parse", "HEAD") !== baseCommit || run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${branch}`) {
      return work.block(`An Agent committed or moved HEAD or ${branch} itself; only this workflow commits. Nothing was delivered.`);
    }
    if (!work.accept()) return { type: "blocked" };
    // Unstaging afterwards also drops run evidence an Agent staged by force; an exclude pathspec fails outright on an ignored .machine-runs.
    git(worktree, "add", "--all");
    git(worktree, "reset", "--quiet", "--", ".machine-runs");
    if (run("git", ["diff", "--cached", "--quiet"], worktree).ok) return work.block("Nothing to commit: the approved candidate does not differ from its base commit.");
    const tree = git(worktree, "write-tree");
    if (!attempt("git", ["commit", "--quiet", "-m", ticket.title, "-m", `Ticket: ${ticket.id}`], worktree).ok) return { type: "blocked" };
    // Commit hooks run, but only the approved tree under the ticket's own message may be delivered.
    const [origin, subject, ...body] = git(worktree, "log", "-1", "--no-show-signature", "--format=%T %P%n%s%n%b").split("\n");
    if (origin !== `${tree} ${baseCommit}` || pending() !== "" || subject !== ticket.title || !body.some(line => flat(line) === flat(`Ticket: ${ticket.id}`))) {
      return work.block(`A commit hook or Git configuration changed the approved candidate or its commit message; ${branch} holds that unapproved commit and nothing was delivered.`);
    }
    const head = git(worktree, "rev-parse", "HEAD");
    // A hook can also detach HEAD or reset the branch; the ticket branch itself must hold the approved commit.
    if (run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${branch}` || git(repository.path, "rev-parse", `refs/heads/${branch}`) !== head) {
      return work.block(`A commit hook or Git configuration moved HEAD or ${branch} away from the approved commit; nothing was delivered.`);
    }
    commitHash = head;
    return { type: "committed" };
  }

  /** gh needs a branch name; a commit, tag, or the remote-tracking prefix is not one. */
  function pullRequestBase(): string | undefined {
    const base = repository.base;
    const branchExists = (ref: string) => run("git", ["show-ref", "--verify", "--quiet", ref], repository.path).ok;
    if (!base || branchExists(`refs/heads/${base}`)) return base;
    const prefix = `${repository.remote}/`;
    return base.startsWith(prefix) && branchExists(`refs/remotes/${base}`) ? base.slice(prefix.length) : undefined;
  }

  function deliver(): Event {
    const directory = work.open();
    if (repository.output === "patch") {
      const made = attempt("git", ["format-patch", "--output-directory", directory, `${baseCommit}..HEAD`], worktree);
      if (!made.ok) return { type: "blocked" };
      patches = made.stdout.split("\n").filter(Boolean);
    }
    if (repository.output === "pr") {
      // gh must open the pull request in the repository the push went to, whatever GH_REPO or other remotes say.
      const remoteUrl = run("git", ["config", "--get", `remote.${repository.remote}.url`], repository.path).stdout;
      const hosted = hostedRepository(remoteUrl);
      if (remoteUrl && !hosted) return work.block(`Remote ${repository.remote} does not name a hosted owner/repository, so a pull request cannot be opened there; ${branch} was not pushed.`);
      // The only ref ever pushed is this run's own branch at the approved commit, without force and whatever push.followTags says.
      // Pushing to that same URL, not the remote's name, keeps a separate pushurl from sending the commit elsewhere.
      if (!attempt("git", ["push", "--no-follow-tags", remoteUrl || repository.remote, `${commitHash}:refs/heads/${branch}`], worktree, publishTimeoutMs).ok) return { type: "blocked" };
      const body = join(directory, "pull-request.md");
      writeFileSync(body, [
        `Ticket: ${ticket.id}`, ticket.title,
        "## Checks", repository.checks.map(name => `- ${name}: passed`).join("\n"),
        "## Review", reviewSummary, "",
      ].join("\n\n"), { flag: "wx", mode: 0o600 });
      const base = pullRequestBase();
      const opened = attempt("gh", ["pr", "create", "--repo", hosted!, ...(repository.draft ? ["--draft"] : []), ...(base ? ["--base", base] : []),
        "--head", branch, "--title", ticket.title, "--body-file", body], worktree, publishTimeoutMs);
      if (!opened.ok) return { type: "blocked" };
      prUrl = opened.stdout.split(/\s+/u).findLast(word => /^https?:\/\/\S+$/u.test(word)) ?? "";
      if (!prUrl) return work.block(`gh pr create printed no pull request URL; inspect ${branch} on ${repository.remote}.`);
    }
    return { type: "delivered" };
  }

  function conclude(outcome: "completed" | "blocked"): Event {
    const result = `${branch} at ${commitHash}${prUrl ? `, pull request ${prUrl}` : ""}${patches.length ? `, patch ${patches.join(", ")}` : ""}`;
    // The branch outlives the worktree; a blocked run keeps both for inspection, and a worktree that stays behind is not a delivery.
    const removed = outcome === "completed" && attempt("git", ["worktree", "remove", worktree], repository.path, undefined,
      `The worktree could not be removed after delivering ${result}`).ok;
    const delivered = work.finish(removed ? "completed" : "blocked").type === "completed";
    const directory = work.open();
    const reason = delivered ? "" : String(work.output()?.reason);
    writeFileSync(join(directory, "delivery.json"), JSON.stringify({
      schemaVersion: 1, outcome: delivered ? "delivered" : "blocked", ...(delivered ? {} : { reason }),
      ticket: ticket.id, repository: { name: repository.name, path: repository.path }, branch,
      baseCommit: baseCommit || null, commit: commitHash || null, output: repository.output,
      ...(prUrl ? { prUrl } : {}), ...(patches.length ? { patches } : {}),
      worktree, worktreeCreated: created, worktreeRemoved: removed,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const brief = flat(reason).replace(/^(.{600}).+$/u, "$1…").replace(/[^.!?…]$/u, "$&.");
    held = { action: "hold", summary: [
      delivered ? `Delivered ${result}.` : `Blocked: ${brief}`,
      ...(created && !removed ? [`Worktree kept at ${worktree}.`] : []),
      `Evidence: ${directory}`,
    ].join(" ") };
    return { type: delivered ? "delivered" : "blocked" };
  }

  const record = (stage: string) => ({ event }: { event: Event }) => work.capture(stage, event);
  return machine({
    initial: "prepare", output: () => held,
    states: {
      prepare: operation(prepare, { prepared: "start", blocked: "failure" }),
      start: operation(work.start, { started: "triage" }),
      triage: agent(() => work.prompt("Decide whether this ticket is actionable as written. Do not edit any file. Read the relevant code and judge whether the request, scope, and acceptance criteria are specific enough to implement and test in this repository. Return ready with a short implementation plan as the summary, or blocked with exactly what is missing."), {
        ready: { target: "triageResult", actions: record("triage") },
        blocked: { target: "failure", actions: record("triage") },
      }, { using: "investigator", cwd: worktree }),
      triageResult: operation(work.unchanged, { unchanged: "change", changed: "failure" }),
      change: agent(() => work.prompt("Implement the ticket and its tests, following the triage plan in the stage reports. Keep the change focused. Do not weaken checks or expand scope. Leave your changes uncommitted; the workflow commits and delivers them."), {
        completed: { target: "verify", actions: record("change") },
        blocked: { target: "failure", actions: record("change") },
      }, { using: "implementer", cwd: worktree }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Review the current diff and verification evidence. Do not edit any file. Check acceptance criteria, regressions, scope, and whether tests actually establish the intended behavior. Return approved, revise with actionable findings, or blocked."), {
        approved: { target: "reviewResult", actions: ({ event }: { event: Event }) => { reviewSummary = work.capture("review", event); } },
        revise: { target: "reviewResult", actions: record("review") },
        blocked: { target: "reviewResult", actions: record("review") },
      }, { using: "reviewer", cwd: worktree }),
      reviewResult: operation(work.review, { approved: "commit", revise: "repairBudget", blocked: "failure" }),
      repairBudget: operation(work.repair, { retry: "change", exhausted: "failure" }),
      commit: operation(commit, { committed: "deliver", blocked: "failure" }),
      deliver: operation(deliver, { delivered: "success", blocked: "failure" }),
      success: operation(() => conclude("completed"), { delivered: "delivered", blocked: "blocked" }),
      failure: operation(() => conclude("blocked"), { delivered: "delivered", blocked: "blocked" }),
      delivered: final(), blocked: final(),
    },
  });
}

function parseTicket(input: unknown) {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const data = object(value, "input", ["ticket", "repository", "worktreeRoot", "evidenceRoot", "maxRepairs"]);
  // Trackers attach their own fields (source, metadata) to a ticket; only id, title, and body are read.
  const ticket = object(data.ticket, "ticket", Object.keys(data.ticket ?? {}));
  const id = text(ticket.id, "ticket.id");
  const title = flat(text(ticket.title, "ticket.title"));
  if (ticket.body !== undefined && typeof ticket.body !== "string") throw new Error("ticket.body must be a string");
  const slug = id.toLowerCase().replace(/[^a-z0-9._-]/gu, "-");
  if (!/[a-z0-9]/u.test(slug) || slug.length > 100 || /^\.|\.\.|\.$|\.lock$/u.test(slug)) {
    throw new Error("ticket.id must yield a non-empty slug that is usable as a branch and directory name");
  }

  const repo = object(data.repository, "repository", ["name", "path", "base", "setup", "checks", "output", "remote", "draft"]);
  const name = text(repo.name, "repository.name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new Error("repository.name must be one path segment of letters, digits, '.', '_', or '-'");
  const output = repo.output;
  if (output !== "pr" && output !== "branch" && output !== "patch") throw new Error('repository.output must be "pr", "branch", or "patch"');
  const base = repo.base === undefined ? undefined : text(repo.base, "repository.base");
  const remote = repo.remote === undefined ? "origin" : text(repo.remote, "repository.remote");
  if (base?.startsWith("-") || remote.startsWith("-")) throw new Error("repository.base and repository.remote must not start with '-'");
  if (repo.draft !== undefined && typeof repo.draft !== "boolean") throw new Error("repository.draft must be a boolean");
  if (repo.setup !== undefined && !Array.isArray(repo.setup)) throw new Error("repository.setup must be an array");
  const setup = ((repo.setup ?? []) as unknown[]).map((entry, i) => parseCheck(entry, `repository.setup[${i}]`));
  if (setup.length > 20 || new Set(setup.map(c => c.name)).size !== setup.length) throw new Error("repository.setup takes at most 20 uniquely named commands");

  const path = absolute(repo.path, "repository.path");
  const evidenceRoot = absolute(data.evidenceRoot, "evidenceRoot");
  const worktree = join(absolute(data.worktreeRoot, "worktreeRoot"), `${name}--${slug}`);
  separate(path, worktree, evidenceRoot);
  const work = taskRun("ticket-task", {
    task: [`Ticket ${id}: ${title}`, ...(ticket.body?.trim() ? [ticket.body] : [])].join("\n\n"),
    workspace: worktree, checks: repo.checks, maxRepairs: data.maxRepairs,
  }, { checks: true, git: "clean", evidenceRoot });
  return {
    ticket: { id, title }, branch: `ticket/${slug}`, worktree, evidenceRoot, work,
    repository: { name, path, base, setup, output, remote, draft: repo.draft !== false,
      checks: (repo.checks as { name: string }[]).map(c => c.name) },
  };
}
function absolute(value: unknown, name: string): string {
  const path = text(value, name);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}
/** Run files inside the source checkout would change its status, and evidence inside the worktree could be committed. */
function separate(repository: string, worktree: string, evidenceRoot: string): void {
  const inside = (path: string, parent: string) => {
    const rest = relative(parent, path);
    return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  };
  if (inside(worktree, repository) || inside(evidenceRoot, repository)) throw new Error("worktreeRoot and evidenceRoot must be outside repository.path; the source checkout is never written to");
  if (inside(evidenceRoot, worktree)) throw new Error("evidenceRoot must be outside the worktree; evidence is never committed");
  // Evidence is written below evidenceRoot/.machine-runs, which must not be or contain the checkout either.
  if (inside(repository, join(evidenceRoot, ".machine-runs"))) throw new Error("repository.path must be outside evidenceRoot/.machine-runs; the source checkout is never written to");
}
/** host/owner/repository for an https, ssh, or scp-style remote URL; undefined for a local path or anything else. */
export function hostedRepository(url: string): string | undefined {
  let host: string; let path: string;
  const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):(?!\/)([^:\s]+)$/u.exec(url);
  if (/^(?:https?|ssh):\/\//u.test(url)) {
    try { ({ hostname: host, pathname: path } = new URL(url)); } catch { return undefined; }
  } else if (scp) [, host, path] = scp as unknown as [string, string, string];
  else return undefined;
  const parts = path.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "").split("/");
  return host && parts.length === 2 && parts.every(part => /^[\w.-]+$/u.test(part)) ? `${host}/${parts.join("/")}` : undefined;
}
/** Resolves symlinks in the part of a path that already exists. */
function real(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(real(parent), basename(path));
}
const flat = (value: string) => value.replace(/\s+/gu, " ").trim();
function run(file: string, args: string[], cwd: string, timeout = 30_000) {
  const done = spawnSync(file, args, {
    cwd, encoding: "utf8", shell: false, timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_REPO: undefined },
  });
  return { ok: !done.error && done.status === 0, stdout: (done.stdout ?? "").trim(), detail: done.error?.message ?? (done.stderr ?? "").trim() };
}
function git(cwd: string, ...args: string[]): string {
  const done = run("git", args, cwd);
  if (!done.ok) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${done.detail}`);
  return done.stdout;
}
