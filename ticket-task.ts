import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, parseCheck, object, text } from "./defaults/_dev-machines/task.ts";

export const description = "Carry one local ticket for one Git repository from an isolated worktree through triage, implementation, checks, and review to a delivered branch, patch, or draft pull request; a stuck run waits for a Human decision.";
export const agentRoles = {
  investigator: "Decides whether the ticket is actionable as written, without editing",
  implementer: "Implements the ticket and its tests in the worktree",
  reviewer: "Reviews evidence and the resulting change without editing",
};

const publishTimeoutMs = 120_000;
// An archive also carries ignored files, which can be a whole dependency directory, and checks itself against a second copy of the candidate.
const archiveTimeoutMs = 120_000;
const decisions = ["more rounds", "hand off", "archive", "discard"] as const;
const confirmations = ["confirm discard", "go back"] as const;

export default function ticketTask(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent, human, final } = p;
  const { ticket, repository, branch, worktree, evidenceRoot, resume, work } = parseTicket(input);
  let baseCommit = "";
  let commitHash = "";
  let created = false;
  let adopted = false;
  let removed = false;
  let decision = "";
  let discardConfirmed = false;
  let patch = "";
  let reviewSummary = "";
  let prUrl = "";
  let patches: string[] = [];
  let held: { action: "hold"; summary: string } | undefined;

  /** A failed Git or gh step blocks with its output saved as evidence rather than copied into the ticket summary. */
  function attempt(file: string, args: string[], cwd: string, timeout?: number, failure = `${file} ${args[0]} failed`, env?: Record<string, string>, input?: string) {
    const done = run(file, args, cwd, timeout, env, input);
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
    if (resume) return adopt();
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

  /** A resumed run takes over the uncommitted candidate an earlier run left behind; every condition is read, never repaired. */
  function adopt(): Event {
    if (!existsSync(worktree) || !statSync(worktree).isDirectory()) return work.block(`Cannot resume: worktree directory ${worktree} does not exist; nothing was changed.`);
    const top = run("git", ["rev-parse", "--show-toplevel"], worktree);
    const common = (cwd: string) => run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    const [own, source] = [common(worktree), common(repository.path)];
    if (!top.ok || realpathSync(top.stdout) !== realpathSync(worktree) || !own.ok || !source.ok || realpathSync(own.stdout) !== realpathSync(source.stdout)) {
      return work.block(`Cannot resume: ${worktree} is not a Git worktree of ${repository.path}; nothing was changed.`);
    }
    if (run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${branch}`) {
      return work.block(`Cannot resume: HEAD in ${worktree} is not the branch ${branch}; nothing was changed.`);
    }
    if (run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], repository.path).stdout !== baseCommit) {
      return work.block(`Cannot resume: ${branch} does not point at the base commit ${baseCommit}, so something was committed on it or the base moved; nothing was changed.`);
    }
    adopted = true;
    return { type: "resumed" };
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

  const stuckPrompt = () => {
    const { reason, repairs, totalRepairs, maxRepairs } = work.status();
    return [
      `Ticket ${ticket.id}: ${ticket.title}`,
      `This run is stuck and needs a decision: ${reason}`,
      `Repair rounds used: ${repairs} of ${maxRepairs}${totalRepairs > repairs ? ` in this budget, ${totalRepairs} in all` : ""}.`,
      `Worktree: ${worktree}\nBranch: ${branch}\nEvidence: ${work.open()}`,
      [
        "more rounds: restart the repair budget and send the standing findings back to the implementer.",
        "hand off: stop here and keep the worktree and branch exactly as they are, with nothing committed, for another workflow or a person.",
        "archive: save the whole candidate, ignored files included, as candidate.patch in the evidence directory, then remove the worktree and delete the branch.",
        "discard: remove the worktree and delete the branch without saving the candidate; asks for confirmation first.",
      ].join("\n"),
    ].join("\n\n");
  };
  const discardPrompt = () => [
    `Discard the candidate for ticket ${ticket.id}: ${ticket.title}?`,
    `This removes the worktree ${worktree} and deletes the branch ${branch} in ${repository.path}.`,
    "The candidate will not be saved: no patch is written, and its uncommitted and committed work on that branch is lost.",
  ].join("\n\n");

  /** Writes the whole candidate against the base commit from a scratch index, so the worktree and its own index stay as they are. */
  function archive(): Event {
    const directory = work.open();
    const file = join(directory, "candidate.patch");
    const candidate = { GIT_INDEX_FILE: join(directory, "candidate.index") };
    const replay = { GIT_INDEX_FILE: join(directory, "replay.index") };
    const copy = join(directory, "candidate.checkout");
    const failure = "The candidate patch could not be written, so nothing was removed";
    const step = (env: Record<string, string>, ...args: string[]) => attempt("git", args, worktree, archiveTimeoutMs, failure, env);
    const unmark = (flag: string, paths: string[]) => paths.length === 0
      || attempt("git", ["update-index", flag, "-z", "--stdin"], worktree, archiveTimeoutMs, failure, candidate, paths.join("\0")).ok;
    if (existsSync(file) || existsSync(copy)) return work.block(`${failure}: ${file} or ${copy} already exists.`);
    try {
      // Starting from the worktree's index keeps the paths a sparse checkout left out of the worktree as they are.
      const staged = step({}, "rev-parse", "--path-format=absolute", "--git-path", "index");
      if (!staged.ok) return { type: "blocked" };
      if (existsSync(staged.stdout)) copyFileSync(staged.stdout, candidate.GIT_INDEX_FILE);
      // That index can also tell add to trust an entry instead of reading its file: assume-unchanged (a lowercase tag) and
      // skip-worktree (S or s). Removing the worktree deletes those files too, so the copy drops both marks wherever a file is present.
      const entries = step(candidate, "ls-files", "-v", "-z");
      if (!entries.ok) return { type: "blocked" };
      const marked = (tag: RegExp) => entries.stdout.split("\0").filter(entry => tag.test(entry[0] ?? "")).map(entry => entry.slice(2));
      const present = (path: string) => lstatSync(join(worktree, path), { throwIfNoEntry: false }) !== undefined;
      if (!unmark("--no-assume-unchanged", marked(/[a-z]/u)) || !unmark("--no-skip-worktree", marked(/s/iu).filter(present))) return { type: "blocked" };
      // Unlike commit, the add is forced and reaches outside a sparse checkout's patterns: ignored files and files there are deleted with the worktree too.
      if (!step(candidate, "add", "--all", "--force", "--sparse").ok || !step(candidate, "reset", "--quiet", "--", ".machine-runs").ok) return { type: "blocked" };
      // A patch records a nested repository as a bare commit id; its files would be deleted with the worktree.
      const changes = step(candidate, "diff", "--cached", "--raw", "--no-renames", baseCommit);
      if (!changes.ok) return { type: "blocked" };
      const nested = changes.stdout.split("\n").filter(line => /^:\d{6} 160000 /u.test(line)).map(line => line.slice(line.indexOf("\t") + 1));
      if (nested.length) return work.block(`${failure}: a patch cannot carry the files of the nested Git repository ${nested.join(", ")}.`);
      // The index holds what line-ending conversion and clean filters made of each file, and a checkout gives back what Git makes of that.
      // So the candidate is checked out beside the evidence and compared with the worktree itself, byte for byte.
      const listed = step(candidate, "ls-files", "--stage", "-z");
      if (!listed.ok) return { type: "blocked" };
      const modes = new Map(listed.stdout.split("\0").filter(Boolean).map(entry => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6)]));
      const unlike = () => {
        rmSync(copy, { recursive: true, force: true });
        if (!step(candidate, "checkout-index", "--all", `--prefix=${copy}/`).ok) return undefined;
        const [kept, rebuilt] = [contents(worktree), existsSync(copy) ? contents(copy) : new Map<string, string>()];
        // checkout-index leaves out what the sparse checkout left out of the worktree, so those paths are absent on both sides.
        return [...new Set([...kept.keys(), ...rebuilt.keys()])].sort().filter(path => kept.get(path) !== rebuilt.get(path));
      };
      let lost = unlike();
      // Where conversion loses a file's bytes, the patch takes the file as it is instead; the second checkout then has to return exactly that.
      const exact = (lost ?? []).filter(path => /^100/u.test(modes.get(path) ?? "") && lstatSync(join(worktree, path), { throwIfNoEntry: false })?.isFile());
      for (const path of exact) {
        const blob = step({}, "hash-object", "-w", "--no-filters", "--", path);
        if (!blob.ok || !step(candidate, "update-index", "--cacheinfo", `${modes.get(path)},${blob.stdout},${path}`).ok) return { type: "blocked" };
      }
      if (exact.length) lost = unlike();
      if (!lost) return { type: "blocked" };
      if (lost.length) {
        return work.block(`${failure}: a patch cannot give back ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ` and ${lost.length - 5} more` : ""} byte for byte. `
          + "Git writes something else there on checkout, as line-ending conversion and filters can, or cannot record the path at all.");
      }
      const tree = step(candidate, "write-tree");
      const base = step({}, "rev-parse", "--verify", "--quiet", `${baseCommit}^{tree}`);
      if (!tree.ok || !base.ok) return { type: "blocked" };
      // git apply rejects an empty patch, and removal without a patch belongs to a confirmed discard alone.
      if (tree.stdout === base.stdout) return work.block(`${failure}: the candidate does not differ from the base commit ${baseCommit}, and an empty patch does not apply.`);
      if (!step(candidate, "diff", "--cached", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv",
        "--src-prefix=a/", "--dst-prefix=b/", `--output=${file}`, baseCommit).ok) return { type: "blocked" };
      // Nothing is removed on the strength of a patch that does not rebuild that checked candidate from the base commit.
      if (!step(replay, "read-tree", baseCommit).ok || !step(replay, "apply", "--cached", "--whitespace=nowarn", file).ok) return { type: "blocked" };
      const rebuilt = step(replay, "write-tree");
      if (!rebuilt.ok) return { type: "blocked" };
      if (rebuilt.stdout !== tree.stdout) return work.block(`${failure}: applying it to ${baseCommit} does not reproduce the candidate.`);
      chmodSync(file, 0o600);
      patch = file;
      return { type: "archived" };
    } catch (error) {
      return work.block(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(candidate.GIT_INDEX_FILE, { force: true }); rmSync(replay.GIT_INDEX_FILE, { force: true }); rmSync(copy, { recursive: true, force: true });
      if (!patch && existsSync(file) && statSync(file).isFile()) rmSync(file);
    }
  }

  /** Removes this run's own worktree and branch, and nothing else, once the candidate is archived or a Human confirmed losing it. */
  function remove(): Event {
    if (!patch && !discardConfirmed) throw new Error("The worktree and branch are removed only after an archive or a confirmed discard");
    work.retire();
    if (!attempt("git", ["worktree", "remove", "--force", worktree], repository.path).ok) return { type: "blocked" };
    removed = true;
    if (!attempt("git", ["branch", "-D", branch], repository.path).ok) return { type: "blocked" };
    return { type: "removed" };
  }

  function conclude(wanted: "completed" | "blocked" | "handed-off" | "abandoned"): Event {
    const result = `${branch} at ${commitHash}${prUrl ? `, pull request ${prUrl}` : ""}${patches.length ? `, patch ${patches.join(", ")}` : ""}`;
    // The branch outlives the worktree; a blocked run keeps both for inspection, and a worktree that stays behind is not a delivery.
    if (wanted === "completed") {
      removed = attempt("git", ["worktree", "remove", worktree], repository.path, undefined,
        `The worktree could not be removed after delivering ${result}`).ok;
    }
    // A kept worktree the helper cannot fingerprint any more, as with a nested repository, still gets its ending recorded.
    work.retire();
    // The helper's receipt knows completed and blocked; delivery.json carries what a Human decided.
    const finished = work.finish(wanted === "completed" && removed ? "completed" : "blocked").type === "completed";
    const outcome = finished ? "delivered" : wanted === "completed" ? "blocked" : wanted;
    const directory = work.open();
    const reason = finished ? "" : String(work.output()?.reason);
    writeFileSync(join(directory, "delivery.json"), JSON.stringify({
      schemaVersion: 1, outcome, ...(finished ? {} : { reason }), ...(decision ? { decision } : {}),
      ticket: ticket.id, repository: { name: repository.name, path: repository.path }, branch,
      baseCommit: baseCommit || null, commit: commitHash || null, output: repository.output,
      ...(prUrl ? { prUrl } : {}), ...(patches.length ? { patches } : {}), ...(patch ? { patch } : {}),
      worktree, ...(adopted ? { resumed: true } : {}), worktreeCreated: created, worktreeRemoved: removed,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const brief = flat(reason).replace(/^(.{600}).+$/u, "$1…").replace(/[^.!?…]$/u, "$&.");
    held = { action: "hold", summary: [
      { delivered: `Delivered ${result}.`, blocked: `Blocked: ${brief}`, "handed-off": `Handed off on ${branch}: ${brief}`, abandoned: `Abandoned: ${brief}` }[outcome],
      ...(decision ? [`Decision: ${decision}.`] : []),
      ...(patch ? [`Candidate saved as ${patch}.`] : []),
      ...(outcome === "abandoned" ? [`Worktree and ${branch} removed${patch ? "" : " without saving the candidate"}.`] : []),
      ...((created || adopted) && !removed ? [`Worktree kept at ${worktree}.`] : []),
      `Evidence: ${directory}`,
    ].join(" ") };
    return { type: outcome === "handed-off" ? "handedOff" : outcome };
  }

  const record = (stage: string) => ({ event }: { event: Event }) => work.capture(stage, event);
  const chose = (value: string) => ({ event }: { event: Event }) => event.value === value;
  const decide = ({ event }: { event: Event }) => { decision = work.choice("decide", event, decisions); };
  return machine({
    initial: "prepare", output: () => held,
    states: {
      prepare: operation(prepare, { prepared: "start", resumed: "verify", blocked: "failure" }),
      start: operation(work.start, { started: "triage" }),
      triage: agent(() => work.prompt("Decide whether this ticket is actionable as written. Do not edit any file. Read the relevant code and judge whether the request, scope, and acceptance criteria are specific enough to implement and test in this repository. Return ready with a short implementation plan as the summary, or blocked with exactly what is missing."), {
        ready: { target: "triageResult", actions: record("triage") },
        blocked: { target: "decide", actions: record("triage") },
      }, { using: "investigator", cwd: worktree }),
      triageResult: operation(work.unchanged, { unchanged: "change", changed: "decide" }),
      change: agent(() => work.prompt("Implement the ticket and its tests, following the triage plan in the stage reports. Keep the change focused. Do not weaken checks or expand scope. Leave your changes uncommitted; the workflow commits and delivers them."), {
        completed: { target: "verify", actions: record("change") },
        blocked: { target: "decide", actions: record("change") },
      }, { using: "implementer", cwd: worktree }),
      verify: operation(() => work.checks(), { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => work.prompt("Review the current diff and verification evidence. Do not edit any file. Check acceptance criteria, regressions, scope, and whether tests actually establish the intended behavior. Return approved, revise with actionable findings, or blocked."), {
        approved: { target: "reviewResult", actions: ({ event }: { event: Event }) => { reviewSummary = work.capture("review", event); } },
        revise: { target: "reviewResult", actions: record("review") },
        blocked: { target: "reviewResult", actions: record("review") },
      }, { using: "reviewer", cwd: worktree }),
      reviewResult: operation(work.review, { approved: "commit", revise: "repairBudget", blocked: "decide" }),
      repairBudget: operation(work.repair, { retry: "change", exhausted: "decide" }),
      // Stuck work waits for a person; preparation, commit, and delivery failures still end blocked by themselves.
      decide: human(stuckPrompt, {
        submitted: [
          { guard: chose("more rounds"), target: "change", actions: (args: { event: Event }) => { decide(args); work.renew(); } },
          { guard: chose("hand off"), target: "handOff", actions: decide },
          { guard: chose("archive"), target: "archive", actions: decide },
          { target: "confirmDiscard", actions: decide },
        ],
      }, { choices: decisions }),
      confirmDiscard: human(discardPrompt, {
        submitted: [
          { guard: chose("confirm discard"), target: "remove", actions: ({ event }: { event: Event }) => { work.choice("confirmDiscard", event, confirmations); discardConfirmed = true; } },
          { target: "decide", actions: ({ event }: { event: Event }) => { work.choice("confirmDiscard", event, confirmations); } },
        ],
      }, { choices: confirmations }),
      archive: operation(archive, { archived: "remove", blocked: "failure" }),
      remove: operation(remove, { removed: "abandon", blocked: "failure" }),
      commit: operation(commit, { committed: "deliver", blocked: "failure" }),
      deliver: operation(deliver, { delivered: "success", blocked: "failure" }),
      success: operation(() => conclude("completed"), { delivered: "delivered", blocked: "blocked" }),
      failure: operation(() => conclude("blocked"), { delivered: "delivered", blocked: "blocked" }),
      handOff: operation(() => conclude("handed-off"), { handedOff: "handedOff" }),
      abandon: operation(() => conclude("abandoned"), { abandoned: "abandoned" }),
      delivered: final(), blocked: final(), handedOff: final(), abandoned: final(),
    },
  });
}

function parseTicket(input: unknown) {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const data = object(value, "input", ["ticket", "repository", "worktreeRoot", "evidenceRoot", "maxRepairs", "resume"]);
  // Trackers attach their own fields (source, metadata) to a ticket; only id, title, and body are read.
  const ticket = object(data.ticket, "ticket", Object.keys(data.ticket ?? {}));
  const id = text(ticket.id, "ticket.id");
  const title = flat(text(ticket.title, "ticket.title"));
  if (ticket.body !== undefined && typeof ticket.body !== "string") throw new Error("ticket.body must be a string");
  const slug = id.toLowerCase().replace(/[^a-z0-9._-]/gu, "-");
  if (!/[a-z0-9]/u.test(slug) || slug.length > 100 || /^\.|\.\.|\.$|\.lock$/u.test(slug)) {
    throw new Error("ticket.id must yield a non-empty slug that is usable as a branch and directory name");
  }
  if (data.resume !== undefined && typeof data.resume !== "boolean") throw new Error("resume must be a boolean");

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
    workspace: worktree, checks: repo.checks, maxRepairs: data.maxRepairs ?? 3,
  }, { checks: true, git: "clean", evidenceRoot });
  return {
    ticket: { id, title }, branch: `ticket/${slug}`, worktree, evidenceRoot, work, resume: data.resume === true,
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
/** What a patch can carry of each path below a checkout: a file's bytes and executable bit, or a link's target. Git's own directory and run evidence are left out. */
function contents(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (path === ".git" || path === ".machine-runs") continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isSymbolicLink()) found.set(path, `link ${readlinkSync(join(root, path))}`);
      else if (!entry.isFile()) found.set(path, "special");
      else found.set(path, `file ${statSync(join(root, path)).mode & 0o100} ${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`);
    }
  };
  walk("");
  return found;
}
/** Resolves symlinks in the part of a path that already exists. */
function real(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(real(parent), basename(path));
}
const flat = (value: string) => value.replace(/\s+/gu, " ").trim();
function run(file: string, args: string[], cwd: string, timeout = 30_000, env: Record<string, string> = {}, input?: string) {
  const done = spawnSync(file, args, {
    cwd, encoding: "utf8", shell: false, timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_REPO: undefined, ...env },
  });
  return { ok: !done.error && done.status === 0, stdout: (done.stdout ?? "").trim(), detail: done.error?.message ?? (done.stderr ?? "").trim() };
}
function git(cwd: string, ...args: string[]): string {
  const done = run("git", args, cwd);
  if (!done.ok) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${done.detail}`);
  return done.stdout;
}
