import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Event, MachinePrimitives } from "@dna113p/machines";
import { taskRun, taskData, type TaskData, parseCheck, object, text, jsonObject } from "./defaults/_machine-shop/task.ts";
import { brief } from "./defaults/_machine-shop/brief.ts";
import { outsideScope } from "./defaults/_machine-shop/scope.ts";

export const description = "Carry one local ticket for one Git repository from an isolated worktree through falsification, planning, plan review, implementation, checks, and review to a delivered branch, patch, or pull request; a pull request is then watched until it merges, when its branch is deleted and the ticket completes; a stuck run sleeps on a Human question.";
export const agentRoles = {
  investigator: "Tries to falsify the ticket, then plans its implementation without editing",
  tester: "Writes failing tests for the ticket's acceptance criteria before implementation",
  implementer: "Implements the ticket and its tests in the worktree",
  reviewer: "Reviews evidence and the resulting change without editing",
};

const publishTimeoutMs = 120_000;
// A sandboxed harness may be unable to start the project's checks at all. That is not a blocker: the checks are the workflow's to run.
const cannotRun = "Run the checks you can. If your environment cannot run them, as when a sandbox refuses to start processes, say which and why in your summary and still return completed: the workflow runs every required check itself after you return. Return blocked only for something a person must decide or supply.";
const decisions = ["more rounds", "hand off", "archive", "discard"] as const;
const decisionOf = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[.,;:!?…]+$/u, "").trim().toLowerCase();
  return decisions.find(decision => decision === normalized);
};
const confirmations = ["confirm discard", "go back"] as const;
const mergeDecisions = ["hand off", "discard"] as const;

export default function ticketTask(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent, human, wait, final } = p;
  type PlanningStage = "falsify" | "plan" | "planReview";
  const saved = p.data({
    branch: "",
    baseCommit: "",
    commitHash: "",
    taken: "",
    untested: false,
    redelivered: false,
    firstApproved: null as { baseCommit: string; commit: string } | null,
    rebasedFrom: null as { baseCommit: string; commit: string } | null,
    rebaseSteps: 0,
    created: false,
    adopted: false,
    removed: false,
    decision: "",
    questions: 0,
    stoppedIn: "",
    discardConfirmed: false,
    archived: null as { branch: string; commit: string } | null,
    reviewSummary: "",
    standingReview: null as string | null,
    reviews: [] as Event[],
    // Keep evidence across rebases, but compare reports only within the current patch's reviews.
    reviewsFrom: 0,
    reviewNotes: [] as { text: string; where: string }[],
    prUrl: "",
    mergeChecks: 0,
    ghFailures: 0,
    mergeReason: "",
    mergeDecision: "",
    localDeleted: false,
    remoteDeleted: false,
    // Where prepare found the base published: the remote's URL and the pull request base branch there, its default branch by name when the base names none.
    // The push and the pull request go there, whatever the remote, the local refs, and gh's own configuration are by then.
    checked: "",
    checkedBase: "",
    patches: [] as string[],
    held: null as { action: "hold" | "complete"; summary: string } | null,
    repairing: "change" as PlanningStage | "test" | "change",
    scopeChecks: 0,
    provedRed: false,
    planningReport: { type: "sound" } as Event,
    planningReports: { falsify: 0, plan: 0, planReview: 0 } as Record<PlanningStage, number>,
    plan: "",
    planRevisions: 0,
    questionsReturned: false,
    questionsFault: "",
    ownerQuestions: null as { text: string; where: string; options?: string[]; recommended?: string; why?: string }[] | null,
    wouldAssume: [] as FalsifyQuestion[],
    answers: [] as string[],
    assumptions: [] as Assumption[],
    assumptionsJson: "",
    task: taskData(),
  });
  const { ticket, repository, prefix, worktree, evidenceRoot, resume, redGreen, assume, work, branch: named } = parseTicket(input, saved.task);
  // A continued run keeps its saved branch; resume may adopt the worktree's branch.
  saved.branch ||= named;
  const assumptionsPrompt = () => saved.assumptionsJson ? ["Assumptions:", saved.assumptionsJson] : [];
  // Answers remain in every later stage's prompt, including after a sleeping run continues.
  const prompt = (instruction: string) => [
    work.prompt(instruction),
    ...(saved.answers.length ? ["Answers from the ticket owner:", ...saved.answers] : []),
  ].join("\n\n");

  function scope(stage: "test" | "change"): Event {
    saved.repairing = stage;
    // -z keeps spaces, newlines, and quoted characters literal. Rename records put the new name first, then the old name.
    const entries = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], {
      cwd: worktree, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }).split("\0");
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (!entry) continue;
      paths.push(entry.slice(3));
      if (/[RC]/u.test(entry.slice(0, 2))) paths.push(entries[++index]!);
    }
    const changed = [...new Set(paths)].filter(path => path !== ".machine-runs" && !path.startsWith(".machine-runs/")).sort();
    const outside = outsideScope(changed, ticket.sections.scope);
    writeFileSync(join(work.open(), `scope-${++saved.scopeChecks}.json`), JSON.stringify({ stage, changed, outside }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (outside.length) {
      work.block(`Paths outside the ticket Scope after ${stage}: ${outside.map(path => JSON.stringify(path)).join(", ")}. Scope: ${ticket.sections.scope.join(", ")}.`);
      return { type: "failed" };
    }
    return { type: "passed" };
  }

  /** A failed Git or gh step blocks with its output saved as evidence rather than copied into the ticket summary. */
  /** `again` is for states a continued run may repeat: their log may already exist. */
  function attempt(file: string, args: string[], cwd: string, timeout?: number, failure = `${file} ${args[0]} failed`, again = false) {
    const done = run(file, args, cwd, timeout);
    if (!done.ok) {
      const log = join(work.open(), `${file}-${args[0]}.log`);
      writeFileSync(log, `${file} ${args.join(" ")}\n${done.stdout}\n${done.detail}\n`, { ...(again ? {} : { flag: "wx" }), mode: 0o600 });
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
  const branchOwners = () => new Map(git(repository.path, "for-each-ref", "--format=%(refname)", "refs/heads/ticket/").split("\n")
    .map(ref => ref.slice("refs/heads/".length)).filter(fits).map(name => [name, owner(name)]));
  const unresolved = (name: string) => `no record of its ticket, and its name does not say where the id ends: it may be this ticket's, or that of a ticket whose id goes on after ${ticket.slug}-. `
    + `Nothing was changed. Record whose it is with git config branch.${name}.ticket <id-slug> (${ticket.slug} for this ticket), then run again.`;

  function shape(): Event {
    const top = run("git", ["rev-parse", "--show-toplevel"], repository.path);
    if (!top.ok || realpathSync(top.stdout) !== realpathSync(repository.path)) throw new Error("repository.path must be a Git checkout root, not a subdirectory or a bare repository");
    // The lexical check at construction cannot see symlinks; nothing has been written yet.
    separate(real(repository.path), real(worktree), real(evidenceRoot));
    // Evidence lives under evidenceRoot, so a blocked preparation is recorded without touching the repository.
    work.open();
    if (ticket.sections.missing.length) return work.block(`Ticket body is missing required sections or non-empty lists: ${ticket.sections.missing.join(", ")}. Expected shape:\n## Goal\nDescribe the goal.\n## Scope\n- path/or/glob\n## Acceptance\n- Testable criterion\n## Forbidden\n- nothing beyond the scope above`);
    return { type: "prepared" };
  }

  function prepare(): Event {
    const base = run("git", ["rev-parse", "--verify", "--quiet", `${repository.base ?? "HEAD"}^{commit}`], repository.path);
    if (!base.ok) return work.block(`Base ${repository.base ?? "HEAD"} does not resolve to a commit in ${repository.path}.`);
    saved.baseCommit = base.stdout;
    // A resumed run's base is the commit its branch is on, so the branch is read before the remote is asked about the base.
    if (resume) {
      const adoption = adopt();
      if (adoption.type === "blocked") return adoption;
      if (adoption.type === "redeliver") {
        saved.adopted = true;
        return adoption;
      }
    }
    if (repository.output === "pr" && !published()) return { type: "blocked" };
    if (resume) {
      saved.adopted = true;
      return { type: pending() === "" ? "prepared" : "resumed" };
    }
    const owners = branchOwners();
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
    if (owners.has(saved.branch)) {
      return work.block(`Branch ${saved.branch} already exists in ${repository.path} for ticket ${owners.get(saved.branch)}, whose id and title spell the name this ticket would take; nothing was changed.`);
    }
    if (existsSync(worktree)) return work.block(`Worktree directory ${worktree} already exists; nothing was changed.`);
    if (!attempt("git", ["worktree", "add", "-b", saved.branch, worktree, saved.baseCommit], repository.path).ok) return { type: "blocked" };
    saved.created = true;
    // Git keeps the record with the branch: it follows a rename and goes when the branch is deleted.
    if (!attempt("git", ["config", "--local", `branch.${saved.branch}.ticket`, ticket.slug], repository.path).ok) return { type: "blocked" };
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
    saved.checked = run("git", ["config", "--get", `remote.${repository.remote}.url`], repository.path).stdout || repository.remote;
    const name = pullRequestBase();
    // A base that names no branch stands for the remote's default branch, which the remote names with the same answer.
    const ref = name ? `refs/heads/${name}` : "HEAD";
    const listed = attempt("git", ["ls-remote", "--symref", saved.checked, ref], repository.path, publishTimeoutMs,
      `Remote ${repository.remote} could not be reached to check that the base is published; nothing was changed`);
    if (!listed.ok) return false;
    const lines = listed.stdout.split("\n").map(line => line.split("\t"));
    const tip = lines.find(([id, at]) => at === ref && /^[0-9a-f]{40,64}$/u.test(id ?? ""))?.[0];
    const head = lines.find(([id, at]) => at === "HEAD" && id?.startsWith("ref: refs/heads/"))?.[0]?.slice("ref: refs/heads/".length);
    const where = name ? `${name} on ${repository.remote}` : `the default branch${head ? ` ${head}` : ""} on ${repository.remote}`;
    if (!tip) return refuse(`The pull request base ${where} does not exist, so the base cannot be shown to be published. Push it first; nothing was changed.`);
    // gh is told this branch by name: left to choose, it reads branch.<name>.gh-merge-base before the default branch, and that was never compared.
    if (!name && !head) return refuse(`Remote ${repository.remote} does not say which branch is its default, so the pull request base cannot be named. Set repository.base to a branch; nothing was changed.`);
    saved.checkedBase = name ?? head!;
    // A remote that is ahead of every local ref has a tip this repository lacks. Fetching it by URL stores the commits and moves no ref.
    if (!run("git", ["cat-file", "-e", `${tip}^{commit}`], repository.path).ok
      && !attempt("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", saved.checked, tip], repository.path, publishTimeoutMs,
        `The tip of ${where} could not be fetched to check that the base is published; nothing was changed`).ok) return false;
    if (run("git", ["merge-base", "--is-ancestor", saved.baseCommit, tip], repository.path).ok) return true;
    const ahead = git(repository.path, "rev-list", "--count", `${tip}..${saved.baseCommit}`);
    return refuse(`Base ${repository.base ?? "HEAD"} has ${ahead} unpublished local commit${ahead === "1" ? " that is" : "s that are"} not in ${where}, `
      + "and the pull request would carry them. The base must be pushed first; nothing was changed.");
  }

  /** A resumed run adopts the worktree an earlier run left behind, with or without a candidate; every condition is read, never repaired. */
  function adopt(): Event {
    let present: boolean;
    try {
      present = Boolean(lstatSync(worktree, { throwIfNoEntry: false }));
    } catch {
      return work.block(`Cannot resume: worktree directory ${worktree} does not exist; nothing was changed.`);
    }
    if (!present) return takeUp();
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
    saved.branch = current;
    const tip = run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${saved.branch}^{commit}`], repository.path).stdout;
    // Adopt the candidate on its own base; after approval, rebase compares it with the source checkout's current tip.
    if (!tip || !run("git", ["merge-base", "--is-ancestor", tip, saved.baseCommit], repository.path).ok) {
      if (!tip || !run("git", ["merge-base", tip, saved.baseCommit], repository.path).ok) {
        return work.block(`Cannot resume: ${saved.branch} shares no history with the base commit ${saved.baseCommit}; nothing was changed.`);
      }
      const own = git(repository.path, "rev-list", "--count", `${saved.baseCommit}..${tip}`);
      return work.block(`Cannot resume: ${saved.branch} holds ${own} commit${own === "1" ? " that is" : "s that are"} not in the base commit ${saved.baseCommit}, `
        + "so something was committed on it or the base moved back; only an uncommitted candidate is resumed, and nothing was changed.");
    }
    saved.baseCommit = tip;
    // A clean resume plans afresh; only a candidate carries the answers its plan used.
    if (pending() !== "") {
      const directory = run("git", ["rev-parse", "--path-format=absolute", "--git-dir"], worktree);
      if (!directory.ok) return work.block(`Cannot resume: cannot locate ticket-task-assumptions.json in the worktree's Git directory: ${directory.detail}; nothing was changed.`);
      const file = join(directory.stdout, "ticket-task-assumptions.json");
      try {
        // lstat distinguishes an absent file from an unreadable or dangling saved link.
        if (lstatSync(file, { throwIfNoEntry: false })) {
          const answers: unknown = JSON.parse(readFileSync(file, "utf8"));
          const malformed = assumptionField(answers);
          if (malformed) return work.block(`Cannot resume: ${file}: ${malformed}; nothing was changed.`);
          saved.assumptions = (answers as Assumption[]).map(({ question, answer, options, why }) => ({ question, answer, options, why }));
          saved.assumptionsJson = JSON.stringify(saved.assumptions, null, 2) + "\n";
        }
      } catch (error) {
        return work.block(`Cannot resume: ${file}: ${String(error)}; nothing was changed.`);
      }
      if (saved.assumptionsJson) writeFileSync(join(work.open(), "assumptions.json"), saved.assumptionsJson, { flag: "wx", mode: 0o600 });
    }
    return { type: "resumed" };
  }

  /** Only the recorded delivery may bypass review; all eligibility checks precede recreating its worktree. */
  function takeUp(): Event {
    const refuse = (why: string) => work.block(`Cannot resume: ${why}; nothing was changed.`);
    const missing = () => refuse(`worktree directory ${worktree} does not exist`);
    const owners = branchOwners();
    const names = [...owners].filter(([, slug]) => slug === ticket.slug).map(([name]) => name);
    if (!names.length) return missing();
    if (names.length !== 1 || [...owners.values()].includes("")) {
      return refuse("there is more than one branch of this ticket, or a sibling branch has unresolved ownership");
    }
    const name = names[0]!;
    const tip = git(repository.path, "rev-parse", `refs/heads/${name}`);
    if (run("git", ["merge-base", "--is-ancestor", tip, saved.baseCommit], repository.path).ok) return missing();
    const [parent, subject, ...body] = git(repository.path, "log", "-1", "--no-show-signature", "--format=%P%n%s%n%b", tip).split("\n");
    if (!parent || parent.includes(" ") || !run("git", ["merge-base", "--is-ancestor", parent, saved.baseCommit], repository.path).ok
      || git(repository.path, "rev-list", "--count", `${saved.baseCommit}..${tip}`) !== "1"
      || subject !== ticket.title || !body.some(line => line === `Ticket: ${ticket.id}`)) {
      return refuse(`${name} does not hold exactly one ticket commit with the expected parent, subject, and Ticket line above an ancestor of the current base`);
    }
    const delivered = run("git", ["config", "--local", "--get", `branch.${name}.ticketDelivered`], repository.path);
    if (!delivered.ok || delivered.stdout !== tip) return refuse(`${name} has no delivery record matching its tip`);
    if (repository.output === "pr") return refuse("the delivered pull request is brought up to date at its host");
    if (!attempt("git", ["worktree", "add", worktree, name], repository.path, undefined,
      "Cannot resume: the worktree could not be recreated; nothing was changed").ok) return { type: "blocked" };
    saved.created = true;
    saved.branch = name;
    if (!repository.setup.every(command => work.check(command, "setup"))) return withdraw("setup failed on the delivered commit");
    if (pending() !== "" || git(worktree, "rev-parse", "HEAD") !== tip
      || run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}`) {
      return withdraw("setup changed tracked or unignored files, HEAD, or the ticket branch");
    }
    saved.baseCommit = parent;
    saved.commitHash = saved.taken = tip;
    saved.firstApproved = { baseCommit: saved.baseCommit, commit: tip };
    saved.untested = true;
    return { type: "redeliver" };
  }

  /** A refusal after recreation removes only the worktree this run made, retaining the recorded delivery. */
  function withdraw(why: string): Event {
    saved.commitHash = "";
    saved.untested = false;
    if (!attempt("git", ["worktree", "remove", "--force", worktree], repository.path, undefined,
      `Cannot resume: ${why}; the recreated worktree could not be removed`).ok) return { type: "blocked" };
    saved.removed = true;
    return work.block(`Cannot resume: ${why}; the recreated worktree was removed.`);
  }

  function commit(): Event {
    if (git(worktree, "rev-parse", "HEAD") !== saved.baseCommit || run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}`) {
      return work.block(`An Agent committed or moved HEAD or ${saved.branch} itself; only this workflow commits. Nothing was delivered.`);
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
    if (origin !== `${tree} ${saved.baseCommit}` || pending() !== "" || subject !== ticket.title || !body.some(line => flat(line) === flat(`Ticket: ${ticket.id}`))) {
      return work.block(`A commit hook or Git configuration changed the approved candidate or its commit message; ${saved.branch} holds that unapproved commit and nothing was delivered.`);
    }
    const head = git(worktree, "rev-parse", "HEAD");
    // A hook can also detach HEAD or reset the branch; the ticket branch itself must hold the approved commit.
    if (run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}` || git(repository.path, "rev-parse", `refs/heads/${saved.branch}`) !== head) {
      return work.block(`A commit hook or Git configuration moved HEAD or ${saved.branch} away from the approved commit; nothing was delivered.`);
    }
    saved.commitHash = head;
    saved.firstApproved ??= { baseCommit: saved.baseCommit, commit: head };
    return { type: "committed" };
  }

  /** Every new stop or return to an Agent leaves an uncommitted candidate on the ticket's own branch. */
  function undo(onto: string): void {
    if (run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}`) {
      git(worktree, "symbolic-ref", "HEAD", `refs/heads/${saved.branch}`);
    }
    git(worktree, "reset", "--quiet", "--mixed", onto);
    saved.commitHash = "";
    saved.untested = false;
    saved.baseCommit = onto;
    work.reopen();
  }

  function rebase(): Event {
    const resolved = run("git", ["rev-parse", "--verify", "--quiet", `${repository.base ?? "HEAD"}^{commit}`], repository.path);
    if (!resolved.ok || resolved.stdout === saved.baseCommit) {
      if (saved.untested) {
        if (!resolved.ok) return withdraw("the current base no longer resolves");
        if (work.checks().type !== "passed" || !work.accept()) return withdraw("verification gates failed on the delivered commit");
        saved.untested = false;
        saved.redelivered = true;
      }
      return { type: "current" };
    }
    const tip = resolved.stdout;
    const original = saved.baseCommit;
    const approved = saved.commitHash;
    let cleanupFailure = "";
    const stop = (reason: string): Event => {
      work.block(reason + (cleanupFailure ? ` Cleaning leftovers failed, so some may reappear on resume; inspect ${cleanupFailure}.` : ""));
      return { type: "stuck" };
    };
    // Unlike attempt's one-off delivery logs, these steps may recur after repair or a Human grants more rounds.
    const step = (args: string[], cwd = worktree, timeout?: number) => {
      const done = run("git", args, cwd, timeout);
      let log = "";
      if (!done.ok) {
        log = join(work.open(), `rebase-${++saved.rebaseSteps}-${args[0]}.log`);
        writeFileSync(log, `git ${args.join(" ")}\n${done.stdout}\n${done.detail}\n`, { flag: "wx", mode: 0o600 });
      }
      return { ...done, log };
    };
    const restore = () => {
      if (["rebase-merge", "rebase-apply"].some(state => existsSync(git(worktree, "rev-parse", "--git-path", state)))) {
        git(worktree, "rebase", "--abort");
      }
      // A hook may have detached HEAD or switched branches. Reattach only this ticket's branch before resetting it.
      if (run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}`) {
        git(worktree, "symbolic-ref", "HEAD", `refs/heads/${saved.branch}`);
      }
      if (git(worktree, "rev-parse", "HEAD") !== approved || pending() !== "") git(worktree, "reset", "--hard", approved);
      // The approved tree was clean: remove later outputs under its ignore rules before making the candidate untracked.
      const cleaned = step(["clean", "-f", "-d", "-q", "-e", "/.machine-runs"]);
      if (!cleaned.ok) cleanupFailure = cleaned.log;
      undo(original);
    };
    if (!run("git", ["merge-base", "--is-ancestor", original, tip], repository.path).ok) {
      undo(original);
      return work.block(`Base ${original} was rewritten or moved back to ${tip}; the ticket must be delivered by hand.`);
    }
    if (repository.output === "pr") {
      const ref = `refs/heads/${saved.checkedBase}`;
      const listed = step(["ls-remote", saved.checked, ref], repository.path, publishTimeoutMs);
      const remoteTip = listed.stdout.split("\n").map(line => line.split("\t"))
        .find(([id, at]) => at === ref && /^[0-9a-f]{40,64}$/u.test(id ?? ""))?.[0];
      const available = listed.ok && remoteTip && (run("git", ["cat-file", "-e", `${remoteTip}^{commit}`], repository.path).ok
        || step(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", saved.checked, remoteTip], repository.path, publishTimeoutMs).ok);
      if (!available || !run("git", ["merge-base", "--is-ancestor", tip, remoteTip!], repository.path).ok) {
        undo(original);
        return stop(`Base ${tip} cannot be shown to be published on ${saved.checkedBase} at ${repository.remote}; the base must be pushed first. Inspect any rebase logs in ${work.open()}.`);
      }
    }
    const patchId = (commit: string) => {
      const diff = step(["diff-tree", "-p", "--no-ext-diff", "--no-textconv", `${commit}^`, commit]);
      if (!diff.ok) return "";
      // Retain both patches as evidence and feed Git a file descriptor, without a shell pipeline.
      const patch = join(work.open(), `rebase-${++saved.rebaseSteps}.patch`);
      writeFileSync(patch, diff.stdout + "\n", { flag: "wx", mode: 0o600 });
      const fd = openSync(patch, "r");
      try {
        const id = spawnSync("git", ["patch-id", "--stable"], {
          cwd: worktree, stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
        });
        const value = !id.error && id.status === 0 ? /^[0-9a-f]{40,64}(?=\s)/u.exec(id.stdout)?.[0] ?? "" : "";
        if (!value) writeFileSync(`${patch}.log`, `${id.stdout ?? ""}\n${id.error?.message ?? id.stderr ?? ""}\n`, { flag: "wx", mode: 0o600 });
        return value;
      } finally { closeSync(fd); }
    };
    const before = patchId(approved);
    if (!before) {
      undo(original);
      return stop(`Cannot identify the approved patch for replay onto ${tip}; inspect the rebase logs in ${work.open()}.`);
    }
    const replay = step(["rebase", "--no-autostash", "--no-update-refs", "--onto", tip, original]);
    if (!replay.ok) {
      const conflicts = git(worktree, "diff", "--name-only", "--diff-filter=U");
      restore();
      return stop(`Replay onto ${tip} failed${conflicts ? ` with conflicts in ${conflicts.split("\n").join(", ")}` : " (Git or a hook refused it)"}. `
        + `The approved candidate is uncommitted on ${original}; resume alone will stop again until a person ports the candidate onto the new base. Inspect rebase logs in ${work.open()}.`);
    }
    const count = git(worktree, "rev-list", "--count", `${tip}..HEAD`);
    if (count === "0") {
      restore();
      return stop(`Base ${tip} already holds this change; the approved candidate is uncommitted on ${original}.`);
    }
    const head = git(worktree, "rev-parse", "HEAD");
    const [parents, subject, ...body] = git(worktree, "log", "-1", "--no-show-signature", "--format=%P%n%s%n%b").split("\n");
    const after = patchId(head);
    if (count !== "1" || parents !== tip || subject !== ticket.title || !body.some(line => flat(line) === flat(`Ticket: ${ticket.id}`))
      || pending() !== "" || !after || run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}`) {
      restore();
      return stop(`Replay onto ${tip} did not leave exactly one clean ticket commit on ${saved.branch} with the expected parent, subject, Ticket line, and patch id; the approved candidate was restored uncommitted on ${original}.`);
    }
    saved.rebasedFrom ??= saved.firstApproved;
    const undoOnTip = (why: string): Event | undefined => {
      // Only added paths become untracked after a mixed reset; modified and deleted paths stay tracked.
      const restoreAndStop = (reason: string) => {
        restore();
        return stop(`${reason} Undo onto ${tip} was needed because ${why}. The approved candidate is uncommitted on its original base ${original}; resume alone will stop again until the candidate or ignore rules are reconciled.`);
      };
      const paths = join(work.open(), `rebase-${++saved.rebaseSteps}.paths`);
      // Keep raw output: run() trims whitespace, which can be part of the first filename.
      const added = spawnSync("git", ["diff-tree", "-r", "--no-renames", "--diff-filter=A", "--name-only", "-z", tip, head], {
        cwd: worktree, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      });
      if (added.error || added.status !== 0) {
        writeFileSync(`${paths}.log`, `${added.stdout ?? ""}\n${added.error?.message ?? added.stderr ?? ""}\n`, { flag: "wx", mode: 0o600 });
        return restoreAndStop(`Cannot identify added paths before undo; inspect ${paths}.log.`);
      }
      writeFileSync(paths, added.stdout, { flag: "wx", mode: 0o600 });
      const fd = openSync(paths, "r");
      try {
        // --no-index checks paths while the replayed commit still tracks them; -z preserves literal filenames.
        const ignored = spawnSync("git", ["check-ignore", "--no-index", "-v", "-z", "--stdin"], {
          cwd: worktree, stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
        });
        if (ignored.error || (ignored.status !== 0 && ignored.status !== 1)) {
          writeFileSync(`${paths}.log`, `${ignored.stdout ?? ""}\n${ignored.error?.message ?? ignored.stderr ?? ""}\n`, { flag: "wx", mode: 0o600 });
          return restoreAndStop(`Cannot check ignore rules before undo; inspect ${paths}.log.`);
        }
        const entries = ignored.stdout.split("\0");
        const dropped: string[] = [];
        // Verbose NUL records are source, line, pattern, path. A negated pattern re-includes the path.
        for (let index = 0; index + 3 < entries.length; index += 4) {
          if (!entries[index + 2]!.startsWith("!")) dropped.push(`${JSON.stringify(entries[index + 3])} (rule in ${JSON.stringify(entries[index])}:${entries[index + 1]})`);
        }
        if (dropped.length) return restoreAndStop(`Ignore rules would drop added files from the next commit: ${dropped.slice(0, 10).join(", ")}${dropped.length > 10 ? `; and ${dropped.length - 10} more` : ""}.`);
      } finally { closeSync(fd); }
      undo(tip);
      return undefined;
    };
    // Setup sees a committed, clean tree as it does in prepare, so unignored outputs cannot hide among candidate changes.
    for (const command of repository.setup) {
      const passed = work.check(command, "setup");
      if (git(worktree, "rev-parse", "HEAD") !== head || run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}`) {
        restore();
        work.reopen(true);
        return stop(`setup: ${command.name} moved HEAD or the ticket branch on base ${tip}; the approved candidate was restored uncommitted on ${original}.`);
      }
      if (!passed || pending() !== "") {
        const stopped = undoOnTip(`setup: ${command.name} ${passed ? "changed tracked or unignored files" : "failed"}`);
        work.reopen(true);
        if (stopped) return stopped;
        saved.reviewsFrom = saved.reviews.length;
        return stop(`setup: ${command.name} ${passed ? "changed tracked or unignored files" : "failed"} on base ${tip}; inspect its setup log in ${work.open()}.`);
      }
    }
    if (before !== after) {
      const stopped = undoOnTip("the replayed patch differs from the approved patch");
      if (stopped) return stopped;
      saved.reviewsFrom = saved.reviews.length;
      work.block(`Base moved from ${original} to ${tip} and the replayed patch differs from the approved patch; verify and review this candidate again.`);
      return { type: "review" };
    }
    if (work.checks(saved.untested ? "verify" : "reverify").type !== "passed" || (saved.untested && !work.accept())) {
      const stopped = undoOnTip("reverify gates failed");
      work.reopen(true);
      if (stopped) return stopped;
      saved.reviewsFrom = saved.reviews.length;
      return { type: "failed" };
    }
    saved.commitHash = head;
    saved.baseCommit = tip;
    saved.untested = false;
    return { type: "rebased" };
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
      const made = attempt("git", ["format-patch", "--output-directory", directory, `${saved.baseCommit}..HEAD`], worktree);
      if (!made.ok) return { type: "blocked" };
      saved.patches = made.stdout.split("\n").filter(Boolean);
    }
    if (repository.output === "pr") {
      // gh must open the pull request in the repository the push went to, whatever GH_REPO or other remotes say.
      const hosted = hostedRepository(saved.checked);
      if (!hosted) return work.block(`Remote ${repository.remote} does not name a hosted owner/repository, so a pull request cannot be opened there; ${saved.branch} was not pushed.`);
      // The only ref ever pushed is this run's own branch at the approved commit, without force and whatever push.followTags says.
      // It goes to the URL prepare checked, read once: a remote reconfigured since then, as an Agent can do, is not asked again.
      if (!attempt("git", ["push", "--no-follow-tags", saved.checked, `${saved.commitHash}:refs/heads/${saved.branch}`], worktree, publishTimeoutMs).ok) return { type: "blocked" };
      const body = join(directory, "pull-request.md");
      writeFileSync(body, [
        ticket.title,
        ...(ticket.summary ? ["## Summary", ticket.summary] : []),
        ...(saved.assumptions.length ? ["## Assumptions", saved.assumptions.map(({ question, answer, why }) => `- ${flat(question)} Assumed: ${flat(answer)} (${flat(why)})`).join("\n")] : []),
        "## Checks", repository.checks.map(name => `- ${name}: passed`).join("\n"),
        // The helper has already taken the summary out of a JSON report; one that is still an object is evidence, not text for a reader.
        "## Review", jsonObject(saved.reviewSummary) ? "The reviewer approved this change without a written summary; its report is kept with the run evidence." : saved.reviewSummary,
        ...(saved.reviewNotes.length ? ["## Review notes", saved.reviewNotes.map(note => `- ${flat(note.text)}${flat(note.where) ? ` (${flat(note.where)})` : ""}`).join("\n")] : []),
        `Ticket: ${ticket.id}`,
      ].join("\n\n") + "\n", { flag: "wx", mode: 0o600 });
      // The base is always named, and is the one prepare compared with the remote, not one read again from refs or configuration that may have changed since.
      const opened = attempt("gh", ["pr", "create", "--repo", hosted, ...(repository.draft ? ["--draft"] : []), "--base", saved.checkedBase,
        "--head", saved.branch, "--title", ticket.title, "--body-file", body], worktree, publishTimeoutMs);
      if (!opened.ok) return { type: "blocked" };
      saved.prUrl = opened.stdout.split(/\s+/u).findLast(word => /^https?:\/\/\S+$/u.test(word)) ?? "";
      if (!saved.prUrl) return work.block(`gh pr create printed no pull request URL; inspect ${saved.branch} on ${repository.remote}.`);
    }
    if (!attempt("git", ["config", "--local", `branch.${saved.branch}.ticketDelivered`, saved.commitHash], repository.path).ok) return { type: "blocked" };
    return { type: "delivered" };
  }

  /** Where an archive keeps the candidate: this run's branch name with archive/ in place of ticket/. */
  const archiveBranch = () => `archive/${saved.branch.slice("ticket/".length)}`;
  const standing = () => {
    const { reason, repairs, totalRepairs, maxRepairs, reviewRounds, totalReviewRounds, maxReviewRounds } = work.status();
    return [
      `Ticket ${ticket.id}: ${ticket.title}. Stopped in ${saved.stoppedIn}.`,
      `This run is stuck and needs a decision: ${reason}\n`,
      `Repair rounds used: ${repairs} of ${maxRepairs}${totalRepairs > repairs ? ` in this budget, ${totalRepairs} in all` : ""}.`,
      `Review rounds used: ${reviewRounds} of ${maxReviewRounds}${totalReviewRounds > reviewRounds ? ` in this budget, ${totalReviewRounds} in all` : ""}.`,
    ].join("\n");
  };
  const locations = () => [`Worktree: ${worktree}`, `Branch: ${saved.branch}`, `Evidence: ${work.open()}`];
  const stuckPrompt = () => brief({
    decision: `Ticket ${ticket.id} is stuck: answer what is needed`, standing: standing(),
    needs: stuckNeeds(), evidence: locations(),
    options: [
      { name: "more rounds", does: saved.repairing === "falsify" || saved.repairing === "plan" || saved.repairing === "planReview"
        ? `restart the repair budget and return to ${saved.repairing} with the standing feedback.`
        : `restart the repair budget and send the standing findings back to the ${saved.repairing === "test" ? "tester" : "implementer"}.` },
      { name: "hand off", does: "stop here and keep the worktree and branch exactly as they are, with nothing committed, for another workflow or a person.", recommended: true },
      { name: "archive", does: `commit the candidate as delivery would have and keep that commit as the branch ${archiveBranch()}, then remove the worktree and delete ${saved.branch}. Ignored files are not kept.` },
      { name: "discard", does: "remove the worktree and delete the branch without saving the candidate; asks for confirmation first." },
      { name: "any other reply", does: "answer the question and return to the stage that stopped with fresh budgets and this answer as standing feedback." },
    ],
  });
  const discardPrompt = () => brief({
    decision: `Discard the candidate for ticket ${ticket.id}?`,
    standing: `${standing()}\nThe candidate will not be saved: no archive branch is made, and its uncommitted and committed work on that branch is lost.`,
    evidence: locations(),
    options: [
      { name: "confirm discard", does: `remove the worktree ${worktree} and delete the branch ${saved.branch} in ${repository.path}.` },
      { name: "go back", does: "return to the decision with the candidate kept." },
    ],
  });
  const questionCount = () => `${saved.ownerQuestions!.length} open question${saved.ownerQuestions!.length === 1 ? "" : "s"}`;
  const questionText = (question: { text: string; where: string }, cap = Infinity) => {
    const where = flat(question.where);
    return `${capped(question.text, cap)}${where ? ` (${where})` : ""}`;
  };
  const questionLines = (cap?: number) => saved.ownerQuestions!.map((question, index) => {
    const options = question.options ? ` Options: ${[`${capped(question.recommended!, cap)} (recommended)`, ...question.options.filter(option => option !== question.recommended).map(option => capped(option, cap))].join("; ")} Why: ${capped(question.why!, cap)}` : "";
    return `${index + 1}. ${questionText(question, cap)}${options}`;
  }).join("\n");
  const wouldAssumeLines = (cap?: number) => saved.wouldAssume.length
    ? `\nHad these been the only questions, the run would have assumed:\n${saved.wouldAssume.map(question => `- ${capped(question.text, cap)} → ${capped(question.recommended, cap)}`).join("\n")}` : "";
  function stuckNeeds(): string {
    const { reason } = work.status();
    // Ask for one owner response while preserving the actual question or criterion as context.
    const why = flat(reason);
    const needs = /^(Repair|Review) budget exhausted/u.test(why)
      ? `Explain how to resolve the remaining findings: ${why}`
      : `Clarify how to resolve this blocker: ${why}`;
    return saved.ownerQuestions
      ? `Answer the open question${saved.ownerQuestions.length === 1 ? "" : "s"}:\n${questionLines(600)}${wouldAssumeLines(600)}`
      : needs.replace(/^(.{600}).+$/u, "$1…");
  }
  const stopped = (state: string, run: () => Event) => () => { saved.stoppedIn = state; return run(); };

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
      if (parent === saved.baseCommit) return work.block(`${failure}: the candidate does not differ from its base commit ${saved.baseCommit}, so there is nothing to archive; discard removes it.`);
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
    saved.archived = { branch: name, commit };
    return { type: "archived" };
  }

  /** Removes this run's own worktree and branch, and nothing else, once the candidate is archived or a Human confirmed losing it. */
  function remove(): Event {
    if (!saved.archived && !saved.discardConfirmed) throw new Error("The worktree and branch are removed only after an archive or a confirmed discard");
    work.retire();
    if (!attempt("git", ["worktree", "remove", "--force", worktree], repository.path).ok) return { type: "blocked" };
    saved.removed = true;
    if (!attempt("git", ["branch", "-D", saved.branch], repository.path).ok) return { type: "blocked" };
    return { type: "removed" };
  }

  function conclude(wanted: "completed" | "blocked" | "handed-off" | "abandoned"): Event {
    const result = `${saved.branch} at ${saved.commitHash}${saved.prUrl ? `, pull request ${saved.prUrl}` : ""}${saved.patches.length ? `, patch ${saved.patches.join(", ")}` : ""}`;
    // The branch outlives the worktree; a blocked run keeps both for inspection, and a worktree that stays behind is not a delivery.
    if (wanted === "completed") {
      saved.removed = attempt("git", ["worktree", "remove", worktree], repository.path, undefined,
        `The worktree could not be removed after delivering ${result}`).ok;
    }
    // A kept worktree the helper cannot fingerprint any more, as with a nested repository, still gets its ending recorded.
    work.retire();
    // The helper's receipt knows completed and blocked; delivery.json carries what a Human decided.
    const finished = work.finish(wanted === "completed" && saved.removed ? "completed" : "blocked").type === "completed";
    const outcome = finished ? "delivered" : wanted === "completed" ? "blocked" : wanted;
    const directory = work.open();
    const reason = finished ? "" : String(work.output()?.reason);
    writeFileSync(join(directory, "delivery.json"), JSON.stringify({
      schemaVersion: 1, outcome, ...(finished ? {} : { reason }), ...(saved.decision ? { decision: saved.decision } : {}),
      ticket: ticket.id, repository: { name: repository.name, path: repository.path }, branch: saved.branch,
      baseCommit: saved.baseCommit || null, commit: saved.commitHash || null, output: repository.output,
      ...(saved.rebasedFrom ? { rebasedFrom: saved.rebasedFrom } : {}),
      ...(finished && saved.redelivered ? { redelivered: true } : {}),
      ...(saved.assumptions.length ? { assumptions: saved.assumptions } : {}),
      ...(saved.prUrl ? { prUrl: saved.prUrl } : {}), ...(saved.patches.length ? { patches: saved.patches } : {}), ...(saved.archived ? { archive: saved.archived } : {}),
      worktree, ...(saved.adopted ? { resumed: true } : {}), worktreeCreated: saved.created, worktreeRemoved: saved.removed, reviewNotes: saved.reviewNotes,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const reasonBrief = flat(reason).replace(/^(.{600}).+$/u, "$1…").replace(/[^.!?…]$/u, "$&.");
    saved.held = { action: "hold", summary: [
      { delivered: `Delivered ${result}.`, blocked: `Blocked: ${reasonBrief}`, "handed-off": `Handed off on ${saved.branch}: ${reasonBrief}`, abandoned: `Abandoned: ${reasonBrief}` }[outcome],
      ...(finished && saved.taken ? [saved.redelivered ? "The base has not moved, so the same commit was delivered again unchanged."
        : `The delivered commit ${saved.taken} was replayed onto the new base ${saved.baseCommit}.`] : []),
      ...(saved.decision ? [`Decision: ${saved.decision}.`] : []),
      ...(saved.archived ? [`Candidate archived on ${saved.archived.branch} at ${saved.archived.commit}.`] : []),
      ...(outcome === "abandoned" ? [`Worktree and ${saved.branch} removed${saved.archived ? "" : " without saving the candidate"}.`] : []),
      ...((saved.created || saved.adopted) && !saved.removed ? [`Worktree kept at ${worktree}.`] : []),
      `Evidence: ${directory}`,
    ].join(" ") };
    return { type: outcome === "handed-off" ? "handedOff" : outcome };
  }

  function checkMerge(): Event {
    const args = ["pr", "view", saved.prUrl, "--json", "state", "--jq", ".state"];
    const checked = run("gh", args, repository.path, publishTimeoutMs);
    saved.mergeChecks++;
    if (checked.ok && ["OPEN", "MERGED", "CLOSED"].includes(checked.stdout)) {
      saved.ghFailures = 0;
      if (checked.stdout === "MERGED") return { type: "merged" };
      if (checked.stdout === "CLOSED") {
        saved.mergeReason = `Pull request ${saved.prUrl} was closed without merging.`;
        return { type: "decide" };
      }
      return { type: "waiting" };
    }
    const detail = checked.ok ? `Unexpected gh state: ${JSON.stringify(checked.stdout)}` : checked.detail || checked.stdout || "gh exited unsuccessfully without a message";
    const log = join(work.open(), `gh-pr-view-${saved.mergeChecks}.log`);
    // A state continued from its checkpoint runs again, so this log may already exist.
    writeFileSync(log, `gh ${args.join(" ")}\n${checked.stdout}\n${detail}\n`, { mode: 0o600 });
    if (++saved.ghFailures < 3) return { type: "waiting" };
    saved.mergeReason = `gh failed 3 times in a row: ${detail}; inspect ${log}`;
    return { type: "decide" };
  }

  function dropLocal(): Event {
    // A run continued after a crash may find the branch already deleted; only Git's clean "no such ref" skips the delete.
    const shown = run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${saved.branch}`], repository.path);
    const missing = !shown.ok && shown.status === 1 && !shown.detail;
    if (!shown.ok && !missing) return work.block(`git show-ref could not tell whether ${saved.branch} exists: ${shown.detail || `exit ${shown.status}`}`);
    if (!missing && !attempt("git", ["branch", "-D", saved.branch], repository.path, undefined, undefined, true).ok) return { type: "blocked" };
    saved.localDeleted = true;
    return { type: "removed" };
  }

  /** Only a MERGED answer permits deleting the pushed branch, at the URL used for delivery. */
  function cleanUp(): Event {
    const ref = `refs/heads/${saved.branch}`;
    const listArgs = ["ls-remote", "--heads", saved.checked, ref];
    const listed = attempt("git", listArgs, repository.path, publishTimeoutMs, undefined, true);
    if (!listed.ok) return { type: "blocked" };
    if (listed.stdout) {
      const args = ["push", "--no-follow-tags", saved.checked, "--delete", ref];
      const deleted = run("git", args, repository.path, publishTimeoutMs);
      if (!deleted.ok) {
        // The host can delete the branch between our query and push. Only a successful empty query excuses the failed push.
        const remaining = attempt("git", listArgs, repository.path, publishTimeoutMs, undefined, true);
        const log = join(work.open(), "git-push.log");
        writeFileSync(log, `git ${args.join(" ")}\n${deleted.stdout}\n${deleted.detail}\n`, { mode: 0o600 });
        if (!remaining.ok) return { type: "blocked" };
        if (remaining.stdout) return work.block(`git push failed deleting ${saved.branch}; inspect ${log}`);
      }
    }
    saved.remoteDeleted = true;
    if (dropLocal().type === "blocked") return { type: "blocked" };
    return settle("merged");
  }

  // Delivery and result receipts were already written before waiting; this receipt records the later ending, and a continued run may write it again.
  function settle(outcome: "merged" | "handedOff" | "abandoned" | "blocked"): Event {
    const directory = work.open();
    const reason = outcome === "blocked" ? work.status().reason : saved.mergeReason;
    writeFileSync(join(directory, "merge.json"), JSON.stringify({
      schemaVersion: 1, outcome, prUrl: saved.prUrl, branch: saved.branch, checks: saved.mergeChecks,
      ghFailures: saved.ghFailures, localDeleted: saved.localDeleted, remoteDeleted: saved.remoteDeleted,
      ...(reason ? { reason } : {}), ...(saved.mergeDecision ? { decision: saved.mergeDecision } : {}),
    }, null, 2) + "\n", { mode: 0o600 });
    const ending = {
      merged: `Merged ${saved.prUrl}; deleted ${saved.branch} locally and on ${repository.remote}.`,
      handedOff: `Handed off ${saved.prUrl} on ${saved.branch}: ${flat(reason)} Branch kept locally and on ${repository.remote}.`,
      abandoned: `Abandoned ${saved.prUrl}: ${flat(reason)} Deleted ${saved.branch} locally; the pushed branch is kept on ${repository.remote}.`,
      blocked: `Blocked after delivering ${saved.prUrl} on ${saved.branch}: ${flat(reason)} Local branch ${saved.localDeleted ? "deleted" : "kept"}; remote branch ${saved.remoteDeleted ? "deleted" : "not confirmed deleted"}.`,
    }[outcome];
    saved.held = { action: outcome === "merged" ? "complete" : "hold", summary: `${ending} Evidence: ${directory}` };
    return { type: outcome };
  }

  const mergePrompt = (confirm = false) => brief({
    decision: confirm ? `Discard the local branch for ticket ${ticket.id}?` : `Decide what happens to ticket ${ticket.id}`,
    standing: `${saved.mergeReason}\nPull request: ${saved.prUrl}\nBranch: ${saved.branch}\nThe worktree has already been removed. The pushed branch will be kept.`,
    evidence: [`Evidence: ${work.open()}`],
    options: confirm ? [
      { name: "confirm discard", does: `delete only the local branch ${saved.branch} in ${repository.path}.` },
      { name: "go back", does: "return to the decision with the branch kept." },
    ] : [
      { name: "hand off", does: "keep the branch and leave the ticket open for someone else.", recommended: true },
      { name: "discard", does: "delete only the local branch after confirmation and leave the ticket open." },
    ],
  });

  const record = (stage: string) => ({ event }: { event: Event }) => { saved.stoppedIn = stage; work.capture(stage, event); };
  const rememberPlanning = ({ event }: { event: Event }) => { saved.planningReport = event; };
  /** Keep the raw report even if its summary is refused; guards and validation run only after capture. */
  function keep(stage: PlanningStage): { summary: string } | { refusal: string } {
    saved.repairing = stage;
    writeFileSync(join(work.open(), `${stage}-${++saved.planningReports[stage]}.json`), JSON.stringify(saved.planningReport, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    try {
      return { summary: work.capture(stage, saved.planningReport) };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`Agent ${stage} must return a non-empty summary`)) return { refusal: error.message };
      throw error;
    }
  }
  function falsifyResult(): Event {
    const kept = keep("falsify");
    const directory = run("git", ["rev-parse", "--path-format=absolute", "--git-dir"], worktree);
    if (!directory.ok) return work.block(`Cannot locate ticket-task-assumptions.json in the worktree's Git directory: ${directory.detail}`);
    const file = join(directory.stdout, "ticket-task-assumptions.json");
    // Even a malformed report replaces the earlier plan's assumptions with none.
    try { rmSync(file, { force: true }); }
    catch (error) { return work.block(`Cannot delete saved assumptions ${file}: ${String(error)}`); }
    saved.assumptions = [];
    saved.assumptionsJson = "";
    if (work.unchanged().type === "changed") return { type: "blocked" };
    if ("refusal" in kept) return work.block(kept.refusal);
    const event = saved.planningReport;
    if (event.type === "sound") {
      saved.questionsFault = "";
      work.block("");
      return { type: "sound" };
    }
    const malformed = questionField(event.questions);
    saved.questionsFault = malformed ?? "";
    if (malformed) {
      if (!saved.questionsReturned) {
        saved.questionsReturned = true;
        return { type: "reask" };
      }
      return work.block(`The falsify report's questions were missing or malformed twice: ${malformed}. The report is kept in ${join(work.open(), `falsify-${saved.planningReports.falsify}.json`)}.`);
    }
    const questions = event.questions as FalsifyQuestion[];
    const open = assume ? questions.filter(question => !question.assumable) : questions;
    if (!open.length) {
      saved.assumptions = questions.map(({ text, recommended, options, why }) => ({ question: text, answer: recommended, options, why }));
      saved.assumptionsJson = JSON.stringify(saved.assumptions, null, 2) + "\n";
      try { writeFileSync(file, saved.assumptionsJson, { flag: "wx", mode: 0o600 }); }
      catch (error) { return work.block(`Cannot write saved assumptions ${file}: ${String(error)}`); }
      writeFileSync(join(work.open(), "assumptions.json"), saved.assumptionsJson, { flag: "wx", mode: 0o600 });
      work.block("");
      return { type: "assumed" };
    }
    saved.ownerQuestions = open.map(({ text, options, recommended, why }) => ({ text, where: "", options, recommended, why }));
    saved.wouldAssume = assume ? questions.filter(question => question.assumable) : [];
    return work.block(`Ticket owner must settle ${questionCount()}:\n${questionLines()}${wouldAssumeLines()}`);
  }
  function planResult(): Event {
    const kept = keep("plan");
    if (work.unchanged().type === "changed") return { type: "blocked" };
    if ("refusal" in kept) return work.block(kept.refusal);
    saved.plan = kept.summary;
    return { type: "planned" };
  }
  function planReviewResult(): Event {
    const kept = keep("planReview");
    if (work.unchanged().type === "changed") return { type: "blocked" };
    if ("refusal" in kept) return work.block(kept.refusal);
    if (saved.planningReport.type === "approved") {
      saved.repairing = "change";
      work.block("");
      return { type: "approved" };
    }
    if (saved.planningReport.type === "tooBroad") {
      saved.repairing = "plan";
      return work.block(`Plan review found the ticket too broad for one run. Suggested split:\n${kept.summary}`);
    }
    if (saved.planRevisions++ === 0) return { type: "revise" };
    saved.repairing = "plan";
    return work.block(kept.summary);
  }
  const recordReview = ({ event }: { event: Event }) => {
    saved.reviewSummary = work.capture("review", event);
    saved.reviews.push(event);
    writeFileSync(join(work.open(), `review-${saved.reviews.length}.json`), JSON.stringify(event, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // Keep well-formed minor notes even when another part of this round's report blocks delivery.
    if (Array.isArray(event.findings)) for (const finding of event.findings) {
      if (finding?.severity === "minor" && typeof finding.text === "string" && typeof finding.where === "string") {
        if (!saved.reviewNotes.some(note => note.text.trim().toLowerCase() === finding.text.trim().toLowerCase()
          && note.where.trim().toLowerCase() === finding.where.trim().toLowerCase())) {
          saved.reviewNotes.push({ text: finding.text, where: finding.where });
        }
      }
    }
  };
  function reviewResult(): Event {
    // Keep the helper's read-only guard, but judge the report here instead of trusting its event type.
    if (work.unchanged().type === "changed") return { type: "blocked" };
    const event = saved.reviews.at(-1)!;
    if (event.type === "blocked") return work.block(saved.reviewSummary);
    // Even a malformed report can contain useful findings. Keep them apart from the Machine's stop reason.
    const feedback = [
      saved.reviewSummary,
      ...(Array.isArray(event.criteria) ? event.criteria.flatMap((criterion, index) => criterion?.met === false && ticket.sections.acceptance[index]
        ? [`Unmet criterion: ${ticket.sections.acceptance[index]}${typeof criterion.evidence === "string" ? ` (${criterion.evidence})` : ""}`] : []) : []),
      ...(Array.isArray(event.findings) ? event.findings.flatMap(finding => (finding?.severity === "blocker" || finding?.severity === "discussion") && typeof finding.text === "string"
        ? [`${finding.severity === "blocker" ? "Blocker" : "Discussion"}: ${finding.text}${typeof finding.where === "string" ? ` (${finding.where})` : ""}`] : []) : []),
    ].join("\n");
    const stop = (reason: string) => { saved.standingReview = feedback; return work.block(reason); };
    const malformed = reviewField(event, ticket.sections.acceptance);
    if (malformed) return stop(`Malformed review report: ${malformed}.`);
    const report = event as ReviewReport;
    const unmet = report.criteria.flatMap((criterion, index) => criterion.met ? [] : [ticket.sections.acceptance[index]!]);
    const blockers = report.findings.filter(finding => finding.severity === "blocker");
    const discussions = report.findings.filter(finding => finding.severity === "discussion");
    const previous = saved.reviews.length - 1 > saved.reviewsFrom ? saved.reviews.at(-2) : undefined;
    const prior = previous && previous.type !== "blocked" && !reviewField(previous, ticket.sections.acceptance) ? previous as ReviewReport : undefined;
    // Decide whether repair is needed first, then whether another repair can make progress.
    if (unmet.length || blockers.length) {
      const before = new Set(prior?.findings.filter(finding => finding.severity === "blocker").map(finding => finding.text));
      const now = new Set(blockers.map(finding => finding.text));
      const newFindings = report.newSinceLastRound.trim().toLowerCase();
      if (prior && (!newFindings || newFindings.replace(/\.$/u, "") === "none") && now.size === before.size && [...now].every(text => before.has(text))) {
        return stop(blockers.length
          ? `Review is not converging: newSinceLastRound is none and these blockers are unchanged: ${blockers.map(finding => `${finding.text} (${finding.where})`).join("; ")}`
          : `Review is not converging: newSinceLastRound is none and criteria remain unmet: ${unmet.join("; ")}`);
      }
      work.block(feedback);
      return { type: "revise" };
    }
    if (discussions.length && prior?.findings.some(finding => finding.severity === "discussion")) {
      saved.ownerQuestions = discussions.map(({ text, where }) => ({ text, where }));
      return stop(`Ticket owner must settle ${questionCount()}:\n${questionLines()}`);
    }
    if (discussions.length) {
      work.block(feedback);
      return { type: "revise" };
    }
    return { type: "approved" };
  }
  const chose = (value: string) => ({ event }: { event: Event }) => event.value === value;
  const choseDecision = (value: typeof decisions[number]) => ({ event }: { event: Event }) => decisionOf(event.value) === value;
  const decide = ({ event }: { event: Event }) => { saved.decision = decisionOf(work.choice("decide", event))!; };
  const continueWork = ({ event }: { event: Event }) => {
    const reply = work.choice("decide", event);
    saved.decision = decisionOf(reply) ?? reply;
    if (saved.decision !== "more rounds") {
      saved.answers.push(saved.decision);
    }
    work.renew();
    saved.ownerQuestions = null;
    saved.wouldAssume = [];
    if (saved.standingReview !== null) work.block(saved.standingReview);
    saved.standingReview = null;
  };
  const mergeDecide = ({ event }: { event: Event }) => { saved.mergeDecision = work.choice("mergeDecide", event, mergeDecisions); };
  return machine({
    initial: "shape", output: () => saved.held ?? undefined,
    states: {
      shape: operation(shape, { prepared: "prepare", blocked: "failure" }),
      // A clean resume starts planning afresh. A resumed candidate is held to Scope; red cannot be proved again once implemented.
      prepare: operation(prepare, { prepared: "start", resumed: "scopeAfterChange", redeliver: "rebase", blocked: "failure" }),
      start: operation(work.start, { started: "falsify" }),
      falsify: agent(() => prompt([
        "Try to falsify this ticket before anyone implements it: look for evidence that it is wrong, already done, impossible in this repository, or underspecified. Do not edit any file. Read the relevant code and check the request, scope, and acceptance criteria. Return sound with a one-paragraph summary if the ticket survives, or questions with a questions array of 1–10 entries shaped as { text, options: string[], recommended: string, assumable: boolean, why }, giving the exact questions a person could answer. text and why must be non-empty strings; options must be a non-empty array of non-empty strings; recommended must copy one of those options exactly. Mark assumable true only for a gap whose conservative answer loses nothing if wrong: it stops, refuses, or keeps more. A product decision, a change of scope, or anything irreversible is never assumable.",
        ...(saved.questionsFault ? [`Your last report's questions were missing or malformed: ${saved.questionsFault}.`] : []),
        "Put the questions in the report's questions field, not in the summary or message.",
      ].join("\n")), {
        sound: { target: "falsifyResult", actions: rememberPlanning },
        questions: { target: "falsifyResult", actions: rememberPlanning },
      }, { using: "investigator", cwd: worktree }),
      falsifyResult: operation(stopped("falsifyResult", falsifyResult), { sound: "plan", assumed: "plan", reask: "falsify", blocked: "stuck" }),
      plan: agent(() => prompt([
        "Plan the implementation of this sound ticket. Do not edit any file. Cover the acceptance criteria, tests, permitted paths, and required checks. Address any plan review feedback in the stage reports. Return planned with the complete plan as the summary. Keep it concise: name the files and the tests, and do not restate the ticket.",
        ...assumptionsPrompt(),
      ].join("\n")), {
        planned: { target: "planResult", actions: rememberPlanning },
      }, { using: "investigator", cwd: worktree }),
      planResult: operation(stopped("planResult", planResult), { planned: "planReview", blocked: "stuck" }),
      planReview: agent(() => prompt([
        "Review the plan against the ticket, relevant code, scope, acceptance criteria, and tests. Do not edit any file. Return approved with a summary if it is ready to implement, or revise with a summary of what must change. Prefer concise plans: send back as revise a plan that restates the ticket or carries detail the implementer does not need. Return tooBroad if the ticket is too broad for one run, with a summary suggesting a split into smaller tickets, one per line. Only one revision of the plan is allowed.",
        ...assumptionsPrompt(),
        "Plan:", saved.plan,
      ].join("\n")), {
        approved: { target: "planReviewResult", actions: rememberPlanning },
        revise: { target: "planReviewResult", actions: rememberPlanning },
        tooBroad: { target: "planReviewResult", actions: rememberPlanning },
      }, { using: "reviewer", cwd: worktree }),
      planReviewResult: operation(stopped("planReviewResult", planReviewResult), { approved: redGreen ? "test" : "change", revise: "plan", blocked: "stuck" }),
      test: agent(() => {
        saved.repairing = "test";
        return prompt([
          "Write only tests that encode the acceptance criteria below, one or more per criterion, inside the Scope paths below. Do not implement anything and do not change non-test files. The tests must fail now and pass once the ticket is implemented. Leave changes uncommitted.",
          ...assumptionsPrompt(),
          ...(saved.plan ? ["Plan:", saved.plan] : []),
          "Acceptance criteria:", ...ticket.sections.acceptance.map(text => `- ${text}`),
          "Scope:", ...ticket.sections.scope.map(text => `- ${text}`),
          cannotRun,
        ].join("\n"));
      }, {
        completed: { target: "scopeAfterTest", actions: record("test") },
        blocked: { target: "stuck", actions: record("test") },
      }, { using: "tester", cwd: worktree }),
      scopeAfterTest: operation(() => scope("test"), { passed: "red", failed: "repairBudget" }),
      red: operation(() => {
        saved.repairing = "test";
        const result = work.redCheck(repository.redCheck);
        saved.provedRed = result.type === "passed";
        return result;
      }, { passed: "change", failed: "repairBudget" }),
      change: agent(() => {
        saved.repairing = "change";
        return prompt([
          "Implement the ticket and its tests. Keep the change focused. Do not weaken checks or expand scope. Leave your changes uncommitted; the workflow commits and delivers them.",
          ...assumptionsPrompt(),
          ...(saved.plan ? ["Plan:", saved.plan] : []),
          ...(redGreen ? ["The tester's tests in the stage reports are the contract; make them pass without weakening or deleting them. If a test is wrong, say so in the summary rather than changing its intent."] : []),
          "Acceptance criteria:", ...ticket.sections.acceptance.map(text => `- ${text}`),
          "Scope (the only paths you may change; the workflow checks them):", ...ticket.sections.scope.map(text => `- ${text}`),
          "Forbidden:", ...ticket.sections.forbidden.map(text => `- ${text}`),
          "Resolve discussion findings or explain why they need the ticket owner in your summary.",
          cannotRun,
        ].join("\n"));
      }, {
        completed: { target: "scopeAfterChange", actions: record("change") },
        blocked: { target: "stuck", actions: record("change") },
      }, { using: "implementer", cwd: worktree }),
      scopeAfterChange: operation(() => scope("change"), { passed: "verify", failed: "repairBudget" }),
      verify: operation(() => { saved.repairing = "change"; return work.checks(); }, { passed: "sealReview", failed: "repairBudget" }),
      sealReview: operation(work.seal, { sealed: "review" }),
      review: agent(() => prompt([
        "Review the current diff and verification evidence. Do not edit any file. Check acceptance criteria, regressions, scope, and whether tests actually establish the intended behavior.",
        ...assumptionsPrompt(),
        ...(saved.assumptions.length ? ["An assumption you disagree with is a discussion finding for the ticket owner."] : []),
        ...(saved.provedRed ? ["The tests were written before the implementation and the Machine saw them fail; check that the implementation makes them pass for the right reason and that no test was weakened."] : []),
        "Acceptance criteria:", ...ticket.sections.acceptance.map((text, index) => `${index + 1}. ${text}`),
        "Return one criteria entry per acceptance criterion, in order, with its text exactly as given, a boolean met, and evidence as a file:line or command.",
        "Tag findings: blocker = must change before delivery; discussion = a question only the ticket owner can settle; minor = worth noting, not worth a round.",
        "On a second or later review, say what is new versus the previous report in newSinceLastRound, or none if nothing is new. Read previous review-<n>.json reports alongside the stage reports in the evidence directory.",
        "For blocked, only the summary is required. For approved or revise, include the full structured report below.",
        'End with one line: MACHINES_EVENT {"type":"approved"|"revise"|"blocked","summary":"<one paragraph>","criteria":[{"text":"<criterion as given>","met":true|false,"evidence":"<file:line or command>"}],"findings":[{"severity":"blocker"|"discussion"|"minor","text":"<finding>","where":"<file:line>"}],"newSinceLastRound":"none"|"<what changed in this round\'s findings>"}',
      ].join("\n")), {
        approved: { target: "reviewResult", actions: recordReview },
        revise: { target: "reviewResult", actions: recordReview },
        blocked: { target: "reviewResult", actions: recordReview },
      }, { using: "reviewer", cwd: worktree }),
      reviewResult: operation(stopped("reviewResult", reviewResult), { approved: "commit", revise: "reviewBudget", blocked: "stuck" }),
      repairBudget: operation(stopped("repairBudget", work.repair), { retry: "repairTarget", exhausted: "stuck" }),
      repairTarget: operation(() => ({ type: saved.repairing }), { falsify: "falsify", plan: "plan", planReview: "planReview", test: "test", change: "change" }),
      reviewBudget: operation(stopped("reviewBudget", work.reviewRound), { retry: "change", exhausted: "stuck" }),
      // Preparation, commit, and delivery failures still end blocked by themselves.
      stuck: operation(() => {
        writeFileSync(join(work.open(), `question-${++saved.questions}.txt`), stuckPrompt() + "\n", { mode: 0o600 });
        return { type: "ask" };
      }, { ask: "decide" }),
      decide: human(stuckPrompt, {
        submitted: [
          { guard: ({ event }: { event: Event }) => typeof event.value === "string" && !event.value.trim(), target: "stuck" },
          // Back to the planning or editing stage that stopped, including the tester after a failed red.
          { guard: choseDecision("more rounds"), target: "repairTarget", actions: continueWork },
          { guard: choseDecision("hand off"), target: "handOff", actions: decide },
          { guard: choseDecision("archive"), target: "archive", actions: decide },
          { guard: choseDecision("discard"), target: "confirmDiscard", actions: decide },
          { target: "repairTarget", actions: continueWork },
        ],
      }, { suggestions: decisions }),
      confirmDiscard: human(discardPrompt, {
        submitted: [
          { guard: chose("confirm discard"), target: "remove", actions: ({ event }: { event: Event }) => { work.choice("confirmDiscard", event, confirmations); saved.discardConfirmed = true; } },
          { target: "stuck", actions: ({ event }: { event: Event }) => { work.choice("confirmDiscard", event, confirmations); } },
        ],
      }, { choices: confirmations }),
      archive: operation(archive, { archived: "remove", blocked: "failure" }),
      remove: operation(remove, { removed: "abandon", blocked: "failure" }),
      commit: operation(commit, { committed: "rebase", blocked: "failure" }),
      rebase: operation(stopped("rebase", rebase), { current: "deliver", rebased: "deliver", review: "verify", failed: "repairBudget", stuck: "stuck", blocked: "failure" }),
      deliver: operation(deliver, { delivered: "success", blocked: "failure" }),
      success: operation(() => conclude("completed"), { delivered: repository.output === "pr" ? "checkMerge" : "delivered", blocked: "blocked" }),
      checkMerge: operation(checkMerge, { merged: "cleanUp", waiting: "awaitMerge", decide: "mergeDecide" }),
      awaitMerge: wait({ every: "10m" }, { due: "checkMerge" }),
      cleanUp: operation(cleanUp, { merged: "merged", blocked: "mergeFailure" }),
      mergeDecide: human(() => mergePrompt(), {
        submitted: [
          { guard: chose("hand off"), target: "mergeHandOff", actions: mergeDecide },
          { target: "confirmMergeDiscard", actions: mergeDecide },
        ],
      }, { choices: mergeDecisions }),
      confirmMergeDiscard: human(() => mergePrompt(true), {
        submitted: [
          { guard: chose("confirm discard"), target: "dropLocal", actions: ({ event }: { event: Event }) => { work.choice("confirmMergeDiscard", event, confirmations); } },
          { target: "mergeDecide", actions: ({ event }: { event: Event }) => { work.choice("confirmMergeDiscard", event, confirmations); } },
        ],
      }, { choices: confirmations }),
      dropLocal: operation(dropLocal, { removed: "mergeAbandon", blocked: "mergeFailure" }),
      mergeHandOff: operation(() => settle("handedOff"), { handedOff: "handedOff" }),
      mergeAbandon: operation(() => settle("abandoned"), { abandoned: "abandoned" }),
      mergeFailure: operation(() => settle("blocked"), { blocked: "blocked" }),
      failure: operation(() => conclude("blocked"), { delivered: "delivered", blocked: "blocked" }),
      handOff: operation(() => conclude("handed-off"), { handedOff: "handedOff" }),
      abandon: operation(() => conclude("abandoned"), { abandoned: "abandoned" }),
      delivered: final(), merged: final(), blocked: final(), handedOff: final(), abandoned: final(),
    },
  });
}

type Assumption = { question: string; answer: string; options: string[]; why: string };
/** Refuse damaged saved answers before adopting or changing the candidate. */
function assumptionField(assumptions: unknown): string | undefined {
  if (!Array.isArray(assumptions) || assumptions.length < 1 || assumptions.length > 10) return "assumptions must be an array of 1–10 entries";
  for (const [index, assumption] of assumptions.entries()) {
    const field = `assumptions[${index}]`;
    if (assumption === null || typeof assumption !== "object" || Array.isArray(assumption)) return `${field} must be an object`;
    for (const key of ["question", "answer", "why"] as const) {
      if (typeof assumption[key] !== "string" || !assumption[key].trim()) return `${field}.${key} must be a non-empty string`;
    }
    if (!Array.isArray(assumption.options) || !assumption.options.length || assumption.options.some((option: unknown) => typeof option !== "string" || !option.trim())) return `${field}.options must be a non-empty array of non-empty strings`;
    if (!assumption.options.includes(assumption.answer)) return `${field}.answer must be one of its options`;
  }
  return undefined;
}

type FalsifyQuestion = { text: string; options: string[]; recommended: string; assumable: boolean; why: string };
/** Validate every question before using any recommended answer. */
function questionField(questions: unknown): string | undefined {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 10) return "questions must be an array of 1–10 entries";
  for (const [index, question] of questions.entries()) {
    const field = `questions[${index}]`;
    if (question === null || typeof question !== "object" || Array.isArray(question)) return `${field} must be an object`;
    if (typeof question.text !== "string" || !question.text.trim()) return `${field}.text must be a non-empty string`;
    if (!Array.isArray(question.options) || !question.options.length || question.options.some((option: unknown) => typeof option !== "string" || !option.trim())) return `${field}.options must be a non-empty array of non-empty strings`;
    if (typeof question.recommended !== "string" || !question.options.includes(question.recommended)) return `${field}.recommended must be one of its options`;
    if (typeof question.assumable !== "boolean") return `${field}.assumable must be a boolean`;
    if (typeof question.why !== "string" || !question.why.trim()) return `${field}.why must be a non-empty string`;
  }
  return undefined;
}

type ReviewReport = Event & {
  criteria: { text: string; met: boolean; evidence: string }[];
  findings: { severity: "blocker" | "discussion" | "minor"; text: string; where: string }[];
  newSinceLastRound: string;
};
/** Return the first malformed field, before any verdict is used. */
function reviewField(report: Event, acceptance: string[]): string | undefined {
  const entry = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!Array.isArray(report.criteria)) return "criteria must be an array";
  if (report.criteria.length !== acceptance.length) return "criteria count must match the acceptance list";
  for (const [index, criterion] of report.criteria.entries()) {
    if (!entry(criterion)) return `criteria[${index}] must be an object`;
    // Order and count are the contract; a reviewer that rewords a criterion is not malformed.
    if (typeof criterion.text !== "string" || !criterion.text.trim()) return `criteria[${index}].text must be a non-empty string`;
    if (typeof criterion.met !== "boolean") return `criteria[${index}].met must be a boolean`;
    if (typeof criterion.evidence !== "string") return `criteria[${index}].evidence must be a string`;
  }
  if (!Array.isArray(report.findings)) return "findings must be an array";
  for (const [index, finding] of report.findings.entries()) {
    if (!entry(finding)) return `findings[${index}] must be an object`;
    if (typeof finding.severity !== "string" || !["blocker", "discussion", "minor"].includes(finding.severity)) return `findings[${index}].severity must be blocker, discussion, or minor`;
    if (typeof finding.text !== "string") return `findings[${index}].text must be a string`;
    if (typeof finding.where !== "string") return `findings[${index}].where must be a string`;
  }
  if (typeof report.newSinceLastRound !== "string") return "newSinceLastRound must be a string";
  return undefined;
}

/** Extract the required level-two sections from a Markdown ticket, independently of their order or case. */
export function ticketSections(body: string) {
  const names = ["Goal", "Scope", "Acceptance", "Forbidden"] as const;
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  let fence = "";
  for (const line of body.split(/\r?\n/u)) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (delimiter && delimiter[0] === fence[0] && delimiter.length >= fence.length && line.trim() === delimiter) fence = "";
      continue;
    }
    if (delimiter) { fence = delimiter; continue; }
    const heading = /^\s{0,3}(#{1,2})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      const name = heading[2]!.replace(/\s+#+$/u, "").toLowerCase();
      current = undefined;
      if (heading[1] === "##" && names.some(expected => expected.toLowerCase() === name)) {
        current = sections.get(name) ?? [];
        sections.set(name, current);
      }
    } else current?.push(line);
  }
  const bullets = (name: string) => {
    const result: string[] = [];
    let indent: number | undefined;
    let continuing = false;
    for (const line of sections.get(name) ?? []) {
      // Thematic breaks and subheadings stay section text, never list entries or continuations.
      if (/^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line) || /^\s*#{3,6}(?:\s|$)/u.test(line)) {
        // The list is over: the next one may be indented differently and still counts.
        continuing = false; indent = undefined; continue;
      }
      const bullet = /^(\s*)[-*+]\s+(\S.*)$/u.exec(line);
      if (bullet && (indent === undefined || bullet[1]!.length <= indent)) {
        indent = bullet[1]!.length;
        result.push(flat(bullet[2]!));
        continuing = true;
      } else if (continuing && line.trim() && /^\s*/u.exec(line)![0].length > indent!) {
        result[result.length - 1] += ` ${flat(bullet ? bullet[2]! : line)}`;
      } else if (line.trim()) { continuing = false; indent = undefined; }
    }
    return result;
  };
  // A Scope bullet is the pattern itself, or the first backticked span when the bullet annotates one: "- `src/**` (the runtime)".
  const scope = bullets("scope").map(text => /`([^`]+)`/u.exec(text)?.[1]?.trim() || text);
  const acceptance = bullets("acceptance"); const forbidden = bullets("forbidden");
  return {
    goal: (sections.get("goal") ?? []).join("\n").trim(), scope, acceptance, forbidden,
    missing: names.filter(name => !sections.has(name.toLowerCase()) || (name !== "Goal" && !bullets(name.toLowerCase()).length)),
  };
}

function parseTicket(input: unknown, saved: TaskData) {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const data = object(value, "input", ["ticket", "repository", "worktreeRoot", "evidenceRoot", "maxRepairs", "maxReviewRounds", "resume", "stuck", "redGreen", "assume"]);
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
  if (data.redGreen !== undefined && typeof data.redGreen !== "boolean") throw new Error("redGreen must be a boolean");
  if (data.assume !== undefined && typeof data.assume !== "boolean") throw new Error("assume must be a boolean");
  const redGreen = data.redGreen !== false;

  const stuck = data.stuck === undefined ? "park" : data.stuck;
  if (stuck !== "ask" && stuck !== "park") throw new Error('stuck must be "ask" or "park"');

  const repo = object(data.repository, "repository", ["name", "path", "base", "setup", "checks", "output", "remote", "draft", "redCheck"]);
  const redCheck = repo.redCheck === undefined ? "tests" : text(repo.redCheck, "repository.redCheck");
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
    workspace: worktree, checks: repo.checks, maxRepairs: data.maxRepairs ?? 3, maxReviewRounds: data.maxReviewRounds,
  }, { checks: true, git: "clean", evidenceRoot }, saved);
  const checks = (repo.checks as { name: string }[]).map(c => c.name);
  if (redGreen && !checks.includes(redCheck)) throw new Error(`repository.redCheck names missing check: ${redCheck}`);
  const prefix = `ticket/${slug}`;
  const titled = titleSlug(title);
  return {
    ticket: { id, slug, title, summary: firstParagraph(ticket.body ?? ""), sections: ticketSections(ticket.body ?? "") }, prefix, branch: titled ? `${prefix}-${titled}` : prefix,
    worktree, evidenceRoot, work, resume: data.resume === true, redGreen, assume: data.assume === true, stuck,
    repository: { name, path, base, setup, output, remote, draft: repo.draft !== false, redCheck, checks },
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
const capped = (value: string, cap = Infinity) => {
  const text = flat(value);
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
};
function run(file: string, args: string[], cwd: string, timeout = 30_000) {
  const done = spawnSync(file, args, {
    cwd, encoding: "utf8", shell: false, timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_REPO: undefined },
  });
  return { ok: !done.error && done.status === 0, status: done.error ? null : done.status, stdout: (done.stdout ?? "").trim(), detail: done.error?.message ?? (done.stderr ?? "").trim() };
}
function git(cwd: string, ...args: string[]): string {
  const done = run("git", args, cwd);
  if (!done.ok) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${done.detail}`);
  return done.stdout;
}
