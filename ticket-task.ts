import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, parseCheck, object, text, jsonObject } from "./defaults/_dev-machines/task.ts";

export const description = "Carry one local ticket for one Git repository from an isolated worktree through triage, implementation, checks, and review to a delivered branch, patch, or draft pull request; a stuck run waits for a Human decision.";
export const agentRoles = {
  investigator: "Decides whether the ticket is actionable as written, without editing",
  implementer: "Implements the ticket and its tests in the worktree",
  reviewer: "Reviews evidence and the resulting change without editing",
};

const publishTimeoutMs = 120_000;
const decisions = ["more rounds", "hand off", "archive", "discard"] as const;
const confirmations = ["confirm discard", "go back"] as const;

export default function ticketTask(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent, human, final } = p;
  const { ticket, repository, prefix, worktree, evidenceRoot, resume, work, branch: named } = parseTicket(input);
  // A resumed run continues on the branch its worktree is already on, whatever title named it.
  let branch = named;
  let baseCommit = "";
  let commitHash = "";
  let created = false;
  let adopted = false;
  let removed = false;
  let decision = "";
  let discardConfirmed = false;
  let archived: { branch: string; commit: string } | undefined;
  let reviewSummary = "";
  let prUrl = "";
  // Where prepare found the base published: the remote's URL and the pull request base branch there, its default branch by name when the base names none.
  // The push and the pull request go there, whatever the remote, the local refs, and gh's own configuration are by then.
  let checked = "";
  let checkedBase = "";
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
  /** A branch is named for this ticket when the id slug is its whole name after ticket/ or is followed by the `-` that starts a title slug. */
  const fits = (name: string) => name === prefix || name.startsWith(`${prefix}-`);
  /** The id slug a run recorded with the branch it made, or "" for a branch made by hand or before branches carried the record. */
  const recorded = (name: string) => run("git", ["config", "--local", "--get", `branch.${name}.ticket`], repository.path).stdout;
  /** The id slug in the ticket commit at a branch's tip, when that ticket would take exactly this name; "" otherwise, as for a branch still at its base. */
  const committed = (name: string) => {
    const [subject = "", ...body] = run("git", ["log", "-1", "--no-show-signature", "--format=%s%n%b", `refs/heads/${name}`], repository.path).stdout.split("\n");
    const titled = titleSlug(subject);
    return body.map(line => idSlug(/^Ticket: (.+)$/u.exec(line)?.[1] ?? "")).find(slug => slug && (name === `ticket/${slug}` || (titled && name === `ticket/${slug}-${titled}`))) ?? "";
  };
  /**
   * A name cannot tell a title from the rest of a longer id (org titled "1 fix", org-1 titled "fix"), so whose a branch is comes from its
   * record, else from the ticket commit it holds, else from being named ticket/<id-slug> exactly, as every branch was before they carried
   * a title. "" when none of these says: the branch may be this ticket's, so it is neither started beside nor taken over.
   */
  const owner = (name: string) => recorded(name) || committed(name) || (name === prefix ? ticket.slug : "");
  const unresolved = (name: string) => `no record of its ticket, and its name does not say where the id ends: it may be this ticket's, or that of a ticket whose id goes on after ${ticket.slug}-. `
    + `Nothing was changed. Record whose it is with git config branch.${name}.ticket <id-slug> (${ticket.slug} for this ticket), then run again.`;

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
    // A resumed run's base is the commit its branch is on, so the branch is read before the remote is asked about the base.
    if (resume && adopt().type === "blocked") return { type: "blocked" };
    if (repository.output === "pr" && !published()) return { type: "blocked" };
    if (resume) {
      adopted = true;
      return { type: "resumed" };
    }
    const owners = new Map(git(repository.path, "for-each-ref", "--format=%(refname)", "refs/heads/ticket/").split("\n")
      .map(ref => ref.slice("refs/heads/".length)).filter(fits).map(name => [name, owner(name)]));
    const first = (whose: string) => [...owners].find(([, slug]) => slug === whose)?.[0];
    // Any branch of this ticket blocks, so a retitled ticket cannot start a second one.
    const existing = first(ticket.slug);
    if (existing) {
      return work.block(`Branch ${existing} already exists in ${repository.path} for this ticket; nothing was changed. Deliver or delete it before running this ticket again.`);
    }
    // So does a branch that may be this ticket's: a run started beside it could be that second branch.
    const open = first("");
    if (open) return work.block(`Branch ${open} already exists in ${repository.path} with ${unresolved(open)}`);
    // Another ticket's id and title can spell the same name; its branch is left alone.
    if (owners.has(branch)) {
      return work.block(`Branch ${branch} already exists in ${repository.path} for ticket ${owners.get(branch)}, whose id and title spell the name this ticket would take; nothing was changed.`);
    }
    if (existsSync(worktree)) return work.block(`Worktree directory ${worktree} already exists; nothing was changed.`);
    if (!attempt("git", ["worktree", "add", "-b", branch, worktree, baseCommit], repository.path).ok) return { type: "blocked" };
    created = true;
    // Git keeps the record with the branch: it follows a rename and goes when the branch is deleted.
    if (!attempt("git", ["config", "--local", `branch.${branch}.ticket`, ticket.slug], repository.path).ok) return { type: "blocked" };
    if (!repository.setup.every(command => work.check(command, "setup"))) return { type: "blocked" };
    if (pending() !== "") {
      return work.block("A setup command changed tracked or unignored files in the worktree; they would be committed with the ticket. Ignore its outputs in the repository.");
    }
    return { type: "prepared" };
  }

  /**
   * The push sends every commit the remote lacks below the ticket commit, so in pr mode the base must already be on the pull request's
   * base branch there. The remote itself is asked, since a remote-tracking ref only says what it held at the last fetch.
   */
  function published(): boolean {
    const refuse = (why: string) => { work.block(why); return false; };
    // The remote's configured URL, not its name, keeps a separate pushurl from sending the commit elsewhere.
    checked = run("git", ["config", "--get", `remote.${repository.remote}.url`], repository.path).stdout || repository.remote;
    const name = pullRequestBase();
    // A base that names no branch stands for the remote's default branch, which the remote names with the same answer.
    const ref = name ? `refs/heads/${name}` : "HEAD";
    const listed = attempt("git", ["ls-remote", "--symref", checked, ref], repository.path, publishTimeoutMs,
      `Remote ${repository.remote} could not be reached to check that the base is published; nothing was changed`);
    if (!listed.ok) return false;
    const lines = listed.stdout.split("\n").map(line => line.split("\t"));
    const tip = lines.find(([id, at]) => at === ref && /^[0-9a-f]{40,64}$/u.test(id ?? ""))?.[0];
    const head = lines.find(([id, at]) => at === "HEAD" && id?.startsWith("ref: refs/heads/"))?.[0]?.slice("ref: refs/heads/".length);
    const where = name ? `${name} on ${repository.remote}` : `the default branch${head ? ` ${head}` : ""} on ${repository.remote}`;
    if (!tip) return refuse(`The pull request base ${where} does not exist, so the base cannot be shown to be published. Push it first; nothing was changed.`);
    // gh is told this branch by name: left to choose, it reads branch.<name>.gh-merge-base before the default branch, and that was never compared.
    if (!name && !head) return refuse(`Remote ${repository.remote} does not say which branch is its default, so the pull request base cannot be named. Set repository.base to a branch; nothing was changed.`);
    checkedBase = name ?? head!;
    // A remote that is ahead of every local ref has a tip this repository lacks. Fetching it by URL stores the commits and moves no ref.
    if (!run("git", ["cat-file", "-e", `${tip}^{commit}`], repository.path).ok
      && !attempt("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", checked, tip], repository.path, publishTimeoutMs,
        `The tip of ${where} could not be fetched to check that the base is published; nothing was changed`).ok) return false;
    if (run("git", ["merge-base", "--is-ancestor", baseCommit, tip], repository.path).ok) return true;
    const ahead = git(repository.path, "rev-list", "--count", `${tip}..${baseCommit}`);
    return refuse(`Base ${repository.base ?? "HEAD"} has ${ahead} unpublished local commit${ahead === "1" ? " that is" : "s that are"} not in ${where}, `
      + "and the pull request would carry them. The base must be pushed first; nothing was changed.");
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
    // The earlier run may have named its branch from another title, or before branches carried one; the name is read, not recomputed.
    const head = run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout;
    const current = head.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : "";
    if (!fits(current)) return work.block(`Cannot resume: HEAD in ${worktree} is not on a branch of this ticket, ${prefix} or ${prefix}-<title>; nothing was changed.`);
    const whose = owner(current);
    if (!whose) return work.block(`Cannot resume: HEAD in ${worktree} is on ${current}, which has ${unresolved(current)}`);
    if (whose !== ticket.slug) return work.block(`Cannot resume: HEAD in ${worktree} is on ${current}, which belongs to ticket ${whose}; nothing was changed.`);
    branch = current;
    const tip = run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], repository.path).stdout;
    // The base may have gone on while the ticket was stuck. The candidate stays on the commit it was made from, which this run takes as its base; nothing is rebased.
    if (!tip || !run("git", ["merge-base", "--is-ancestor", tip, baseCommit], repository.path).ok) {
      if (!tip || !run("git", ["merge-base", tip, baseCommit], repository.path).ok) {
        return work.block(`Cannot resume: ${branch} shares no history with the base commit ${baseCommit}; nothing was changed.`);
      }
      const own = git(repository.path, "rev-list", "--count", `${baseCommit}..${tip}`);
      return work.block(`Cannot resume: ${branch} holds ${own} commit${own === "1" ? " that is" : "s that are"} not in the base commit ${baseCommit}, `
        + "so something was committed on it or the base moved back; only an uncommitted candidate is resumed, and nothing was changed.");
    }
    baseCommit = tip;
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
      const hosted = hostedRepository(checked);
      if (!hosted) return work.block(`Remote ${repository.remote} does not name a hosted owner/repository, so a pull request cannot be opened there; ${branch} was not pushed.`);
      // The only ref ever pushed is this run's own branch at the approved commit, without force and whatever push.followTags says.
      // It goes to the URL prepare checked, read once: a remote reconfigured since then, as an Agent can do, is not asked again.
      if (!attempt("git", ["push", "--no-follow-tags", checked, `${commitHash}:refs/heads/${branch}`], worktree, publishTimeoutMs).ok) return { type: "blocked" };
      const body = join(directory, "pull-request.md");
      writeFileSync(body, [
        ticket.title,
        ...(ticket.summary ? ["## Summary", ticket.summary] : []),
        "## Checks", repository.checks.map(name => `- ${name}: passed`).join("\n"),
        // The helper has already taken the summary out of a JSON report; one that is still an object is evidence, not text for a reader.
        "## Review", jsonObject(reviewSummary) ? "The reviewer approved this change without a written summary; its report is kept with the run evidence." : reviewSummary,
        `Ticket: ${ticket.id}`,
      ].join("\n\n") + "\n", { flag: "wx", mode: 0o600 });
      // The base is always named, and is the one prepare compared with the remote, not one read again from refs or configuration that may have changed since.
      const opened = attempt("gh", ["pr", "create", "--repo", hosted, ...(repository.draft ? ["--draft"] : []), "--base", checkedBase,
        "--head", branch, "--title", ticket.title, "--body-file", body], worktree, publishTimeoutMs);
      if (!opened.ok) return { type: "blocked" };
      prUrl = opened.stdout.split(/\s+/u).findLast(word => /^https?:\/\/\S+$/u.test(word)) ?? "";
      if (!prUrl) return work.block(`gh pr create printed no pull request URL; inspect ${branch} on ${repository.remote}.`);
    }
    return { type: "delivered" };
  }

  /** Where an archive keeps the candidate: this run's branch name with archive/ in place of ticket/. */
  const archiveBranch = () => `archive/${branch.slice("ticket/".length)}`;
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
        `archive: commit the candidate as delivery would have and keep that commit as the branch ${archiveBranch()}, then remove the worktree and delete ${branch}. Ignored files are not kept.`,
        "discard: remove the worktree and delete the branch without saving the candidate; asks for confirmation first.",
      ].join("\n"),
    ].join("\n\n");
  };
  const discardPrompt = () => [
    `Discard the candidate for ticket ${ticket.id}: ${ticket.title}?`,
    `This removes the worktree ${worktree} and deletes the branch ${branch} in ${repository.path}.`,
    "The candidate will not be saved: no archive branch is made, and its uncommitted and committed work on that branch is lost.",
  ].join("\n\n");

  /** Saves what delivery would have committed as a commit on a branch of its own, which outlives the worktree and the ticket branch. */
  function archive(): Event {
    const name = archiveBranch();
    const failure = "The candidate could not be archived, so nothing was removed";
    if (run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], repository.path).ok) {
      return work.block(`${failure}: branch ${name} already exists in ${repository.path}, and nothing was staged.`);
    }
    // Whether the candidate still matches its checks is settled here; the archive commit is this workflow's own and is not drift.
    work.retire();
    // Staged as commit stages it, so ignored files stay out here as they would have there.
    if (!attempt("git", ["add", "--all"], worktree, undefined, failure).ok || !attempt("git", ["reset", "--quiet", "--", ".machine-runs"], worktree, undefined, failure).ok) return { type: "blocked" };
    const head = () => git(worktree, "rev-parse", "HEAD");
    const parent = head();
    if (run("git", ["diff", "--cached", "--quiet"], worktree).ok) {
      // Removal without anything saved belongs to a confirmed discard alone. Commits an Agent made on the branch are a candidate, archived as they are.
      if (parent === baseCommit) return work.block(`${failure}: the candidate does not differ from its base commit ${baseCommit}, so there is nothing to archive; discard removes it.`);
    } else {
      const tree = git(worktree, "write-tree"); const title = `Archive: ${ticket.title}`;
      if (!attempt("git", ["commit", "--quiet", "--no-verify", "-m", title, "-m", `Ticket: ${ticket.id}`], worktree, undefined, failure).ok) return { type: "blocked" };
      // --no-verify skips only the hooks that can refuse a commit. One that runs after it can reset HEAD and leave a clean worktree without the candidate.
      const [origin, subject, ...body] = git(worktree, "log", "-1", "--no-show-signature", "--format=%T %P%n%s%n%b").split("\n");
      if (origin !== `${tree} ${parent}`) {
        return work.block(`${failure}: a commit hook or Git configuration moved HEAD off the archive commit or changed what it holds, so ${name} would not hold the candidate; HEAD is at ${head()}.`);
      }
      // One that prepares the message still runs too, and the archive is found again by its subject and its ticket.
      if (subject !== title || !body.some(line => flat(line) === flat(`Ticket: ${ticket.id}`))) {
        return work.block(`${failure}: a commit hook or Git configuration changed the archive commit's message, so ${name} would not name the ticket; HEAD is at ${head()}, which holds the candidate.`);
      }
    }
    // Whatever the commit left behind would be deleted with the worktree.
    if (pending() !== "") return work.block(`${failure}: the worktree is not clean after the archive commit, so ${name} would not hold all of the candidate.`);
    const commit = head();
    if (!attempt("git", ["branch", name, commit], worktree, undefined, failure).ok) return { type: "blocked" };
    archived = { branch: name, commit };
    return { type: "archived" };
  }

  /** Removes this run's own worktree and branch, and nothing else, once the candidate is archived or a Human confirmed losing it. */
  function remove(): Event {
    if (!archived && !discardConfirmed) throw new Error("The worktree and branch are removed only after an archive or a confirmed discard");
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
      ...(prUrl ? { prUrl } : {}), ...(patches.length ? { patches } : {}), ...(archived ? { archive: archived } : {}),
      worktree, ...(adopted ? { resumed: true } : {}), worktreeCreated: created, worktreeRemoved: removed,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const brief = flat(reason).replace(/^(.{600}).+$/u, "$1…").replace(/[^.!?…]$/u, "$&.");
    held = { action: "hold", summary: [
      { delivered: `Delivered ${result}.`, blocked: `Blocked: ${brief}`, "handed-off": `Handed off on ${branch}: ${brief}`, abandoned: `Abandoned: ${brief}` }[outcome],
      ...(decision ? [`Decision: ${decision}.`] : []),
      ...(archived ? [`Candidate archived on ${archived.branch} at ${archived.commit}.`] : []),
      ...(outcome === "abandoned" ? [`Worktree and ${branch} removed${archived ? "" : " without saving the candidate"}.`] : []),
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
  const slug = idSlug(id);
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
  const prefix = `ticket/${slug}`;
  const titled = titleSlug(title);
  return {
    ticket: { id, slug, title, summary: firstParagraph(ticket.body ?? "") }, prefix, branch: titled ? `${prefix}-${titled}` : prefix,
    worktree, evidenceRoot, work, resume: data.resume === true,
    repository: { name, path, base, setup, output, remote, draft: repo.draft !== false,
      checks: (repo.checks as { name: string }[]).map(c => c.name) },
  };
}
/** A ticket id as branch and worktree names carry it. */
const idSlug = (id: string) => id.toLowerCase().replace(/[^a-z0-9._-]/gu, "-");
/** The part of a branch name that says what the ticket is about: at most 48 characters of `[a-z0-9]` runs joined by `-`, or "" when the title has none. */
export function titleSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  if (slug.length <= 48) return slug;
  // A cut inside a word goes back to the `-` before it; a first word longer than the limit has no such `-` and leaves nothing.
  return slug.slice(0, Math.max(slug.lastIndexOf("-", 48), 0));
}
/** The first paragraph of a ticket body below its leading headings, or "" when the body has no such text. A blank line or the next heading ends it. */
function firstParagraph(body: string): string {
  const lines = body.split(/\r?\n/u);
  const heading = (line: string) => /^\s*#{1,6}(?:\s|$)/u.test(line);
  const start = lines.findIndex(line => line.trim() !== "" && !heading(line));
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && (line.trim() === "" || heading(line)));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
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
