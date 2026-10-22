import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineEndings, type Event, type MachinePrimitives } from "@dna113p/machines";
import { evidenceHuman, evidenceLog, writeStuckEvidence, repositoryTurn, taskNow, taskStatus, writeHandoff, taskRun, taskData, type TaskData, parseCheck, object, text, jsonObject } from "./defaults/_machine-shop/task.ts";
import { brief, opening, excerpt, evidenceFacts, evidencePage, handoffPage, type EvidenceBlock } from "./defaults/_machine-shop/brief.ts";
import { outsideScope } from "./defaults/_machine-shop/scope.ts";

export const description = "Carry one local ticket for one Git repository from an isolated worktree through falsification, planning, plan review, implementation, checks, and review to a delivered branch, patch, or pull request; a stuck run sleeps on a Human question.";
export const agentRoles = {
  investigator: "Tries to falsify the ticket, then plans its implementation without editing",
  tester: "Writes failing tests for the ticket's acceptance criteria before implementation",
  implementer: "Implements the ticket and its tests in the worktree",
  reviewer: "Reviews evidence and the resulting change without editing",
  presenter: { description: "Explains a stopped run's question from its evidence; a small model is enough", optional: true },
};

export const endings = defineEndings({
  delivered: { kind: "succeeded" },
  handedOff: { kind: "cancelled" }, abandoned: { kind: "cancelled" }, refused: { kind: "failed" },
});

const publishTimeoutMs = 120_000;
// A sandboxed harness may be unable to start the project's checks at all. That is not a blocker: the checks are the workflow's to run.
const cannotRun = "Run the checks you can. If your environment cannot run them, as when a sandbox refuses to start processes, say which and why in your summary and still return completed: the workflow runs every required check itself after you return. Return blocked only for something a person must decide or supply.";
const decisions = ["continue", "hand off", "discard"] as const;
const scopeDecisions = ["include", "revert", "hand off", "discard"] as const;
const scopeDecisionOf = (value: string) => scopeDecisions.find(decision => decision === value.trim().replace(/[.,;:!?…]+$/u, "").trim().toLowerCase());
const decisionOf = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[.,;:!?…]+$/u, "").trim().toLowerCase();
  return decisions.find(decision => decision === normalized);
};
export default function ticketTask(p: MachinePrimitives, input: unknown) {
  const { machine, operation, agent, human, final } = p;
  type PlanningStage = "falsify" | "plan" | "planReview";
  type Origin = "prepare" | PlanningStage | "test" | "red" | "implement" | "gate" | "review" | "judge" | "commit" | "rebase" | "deliver";
  const saved = p.data({
    origin: "prepare" as Origin,
    agentRoute: "",
    previousEvidence: "",
    recheckBase: false,
    pushed: false,
    branch: "",
    baseCommit: "",
    commitHash: "",
    taken: "",
    untested: false,
    redelivered: false,
    firstApproved: null as { baseCommit: string; commit: string } | null,
    rebasedFrom: null as { baseCommit: string; commit: string } | null,
    rebaseSteps: 0,
    moved: null as { from: string; to: string; ref: string; patch: string; conflicts: string[]; settled: string[]; at?: "resume" | "delivery" } | null,
    moves: 0,
    created: false,
    adopted: false,
    removed: false,
    decision: "",
    questions: 0,
    stoppedIn: "",
    discardConfirmed: false,
    reviewSummary: "",
    reviewSummaryFault: "",
    standingReview: null as string | null,
    extraRound: "unused" as "unused" | "running" | "used",
    extraReviewRounds: 0,
    extraRoundFrom: 0,
    extraFeedback: [] as string[],
    reviews: [] as Event[],
    malformedReviews: [] as number[],
    // Keep evidence across rebases, but compare reports only within the current patch's reviews.
    reviewsFrom: 0,
    reviewNotes: [] as { text: string; where: string }[],
    prUrl: "",
    // The delivered commit a resume found at the head of its open pull request: the one force-push, on this run's own branch, leases it.
    lease: "",
    // Where prepare found the base published: the remote's URL and the pull request base branch there, its default branch by name when the base names none.
    // The push and the pull request go there, whatever the remote, the local refs, and gh's own configuration are by then.
    checked: "",
    checkedBase: "",
    patches: [] as string[],
    held: null as { action: "hold" | "complete"; summary: string } | null,
    repairing: "change" as PlanningStage | "test" | "change",
    scopeChecks: 0,
    scopeAdditions: [] as ScopeAddition[],
    pendingScope: null as ScopeMiss | null,
    provedRed: false,
    planningReport: { type: "sound" } as Event,
    planningReports: { falsify: 0, plan: 0, planReview: 0 } as Record<PlanningStage, number>,
    plan: "",
    planRevisions: 0,
    planRejectedAgain: false,
    questionsReturned: false,
    questionsFault: "",
    ownerQuestions: null as { text: string; where: string; options?: string[]; recommended?: string; why?: string }[] | null,
    wouldAssume: [] as FalsifyQuestion[],
    answers: [] as string[],
    assumptions: [] as Assumption[],
    assumptionsJson: "",
    passedStages: [] as string[],
    handoff: null as { page: string; path: string } | null,
    handoffFiles: null as { path: string; added: number | null; removed: number | null }[] | null,
    task: taskData(),
  });
  const { ticket, repository, prefix, worktree, evidenceRoot, resume, redGreen, assume, work, branch: named } = parseTicket(input, saved.task);
  const allowedScope = [...ticket.sections.scope, ...repository.companions];
  const scopeAdditionLines = () => saved.scopeAdditions.map(({ path, stage }) => `${path}: included by the ticket owner after ${stage}`);
  const scopeAdditionSection = () => saved.scopeAdditions.length ? ["## Scope additions", scopeAdditionLines().map(line => `- ${line}`).join("\n")] : [];
  // Owner additions are literal filenames, never patterns or directory prefixes.
  const outsideEffectiveScope = (paths: string[]) => outsideScope(paths.filter(path => !saved.scopeAdditions.some(addition => addition.path === path)), allowedScope);
  const scopePrompt = (heading = "Scope:") => [
    heading, ...ticket.sections.scope.map(text => `- ${text}`),
    ...scopeAdditionSection(),
    ...(repository.companions.length ? ["Also in scope for every ticket here:", ...repository.companions.map(text => `- ${text}`)] : []),
  ];
  let turn: ReturnType<typeof repositoryTurn> | undefined;
  let turnHeld = false;
  const lifetime = new AbortController();
  let waitingForTurn = false;
  let activeMeaning = "checking the ticket's required sections";
  const publishNow = (meaning: string) => taskNow(p.status, ticket.title, meaning, saved.handoff);
  const setNow = (meaning: string) => { activeMeaning = meaning; publishNow(meaning); };
  const releaseTurn = () => {
    turn?.release(); turnHeld = false;
    if (waitingForTurn) { waitingForTurn = false; publishNow(activeMeaning); }
  };
  const stopTurn = () => { lifetime.abort(); releaseTurn(); };
  const takeTurn = async () => {
    turn ??= repositoryTurn(repository.path, join(dirname(dirname(worktree)), ".machine-runs", "repository-turns"), basename(work.open()));
    await turn.acquire(lifetime.signal, note => {
      waitingForTurn = !!note;
      publishNow(note ? "waiting for the repository's turn" : activeMeaning);
    }, message => {
      appendFileSync(join(work.open(), "repository-turn.log"), message + "\n", { mode: 0o600 });
      console.log(message);
    });
    turnHeld = true;
  };
  // Keep the turn only on transitions that remain in the delivery stretch.
  const inTurn = (run: () => Event, keep: readonly string[]) => async () => {
    try {
      await takeTurn();
      lifetime.signal.throwIfAborted();
      const result = run();
      if (!keep.includes(result.type)) releaseTurn();
      return result;
    } catch (error) { releaseTurn(); throw error; }
  };
  // A continued run keeps its saved branch; resume may adopt the worktree's branch.
  saved.branch ||= named;
  const assumptionsPrompt = () => saved.assumptionsJson ? ["Assumptions:", saved.assumptionsJson] : [];
  // Answers remain in every later stage's prompt, including after a sleeping run continues.
  const prompt = (instruction: string, stage?: string) => [
    work.prompt(instruction, stage),
    ...(saved.previousEvidence ? [`Earlier run's evidence: ${saved.previousEvidence}`] : []),
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
    const outside = outsideEffectiveScope(changed);
    writeFileSync(join(work.open(), `scope-${++saved.scopeChecks}.json`), JSON.stringify({ stage, changed, outside }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (outside.length) {
      const files = diffFiles();
      saved.pendingScope = { stage: stage === "test" ? "red" : "gate", files: outside.map(path =>
        files?.find(file => file.path === path) ?? { path, added: null, removed: null }) };
      writeFileSync(join(work.open(), `scope-miss-${saved.scopeChecks}.json`), JSON.stringify(saved.pendingScope, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      work.block(`Paths outside the ticket Scope after ${stage}: ${outside.map(path => JSON.stringify(path)).join(", ")}. Scope: ${allowedScope.join(", ")}.`);
      return { type: "scopeMiss" };
    }
    saved.pendingScope = null;
    return { type: "passed" };
  }

  const scopeFile = () => join(git(worktree, "rev-parse", "--absolute-git-dir"), "ticket-task-scope.json");
  function saveScope() {
    writeFileSync(scopeFile(), JSON.stringify({ ticket: ticket.id, branch: saved.branch, additions: saved.scopeAdditions }, null, 2) + "\n", { mode: 0o600 });
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
    const current = base.stdout;
    saved.baseCommit = current;
    // A resumed run's base is the commit its branch is on, so the branch is read before the remote is asked about the base.
    if (resume) {
      const adoption = adopt();
      if (adoption.type === "blocked") return adoption;
      if (adoption.type === "redeliver") {
        saved.adopted = true;
        return adoption;
      }
    }
    const remote = repository.output === "pr" ? published() : undefined;
    if (repository.output === "pr" && !remote) return { type: "blocked" };
    if (repository.output === "pr" && !hostedRepository(saved.checked)) {
      return work.block(`Remote ${repository.remote} does not name a hosted owner/repository, so a pull request cannot be opened there; ${saved.branch} was not pushed.`);
    }
    const start = remote && run("git", ["merge-base", "--is-ancestor", current, remote], repository.path).ok ? remote : current;
    if (start !== current) {
      writeFileSync(join(work.open(), "base.json"), JSON.stringify({
        ref: repository.base ?? "HEAD", local: current, remote: repository.remote, branch: saved.checkedBase, tip: start,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
    if (resume) {
      saved.adopted = true;
      const conflicts = unmerged();
      if (conflicts.length) {
        // A separate resume may inherit an unresolved index from a handed-off move.
        const record = join(git(worktree, "rev-parse", "--absolute-git-dir"), "ticket-task-move.json");
        if (!existsSync(record)) {
          work.block(`Unmerged files: ${conflicts.join(", ")}. Cannot locate the saved candidate record ${record}; the worktree was left unchanged.`);
          return { type: "stuck" };
        }
        saved.moved = JSON.parse(readFileSync(record, "utf8"));
        saved.moved!.at = "resume";
        saved.moved!.conflicts = [...new Set([...saved.moved!.conflicts, ...conflicts])];
        return conflict();
      }
      if (saved.baseCommit !== start) return moveOnto(start);
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
    saved.baseCommit = start;
    if (!attempt("git", ["worktree", "add", "-b", saved.branch, worktree, saved.baseCommit], repository.path).ok) return { type: "blocked" };
    saved.created = true;
    return { type: "created" };
  }

  function setup(): Event {
    // Git keeps the record with the branch: it follows a rename and goes when the branch is deleted.
    if (!attempt("git", ["config", "--local", `branch.${saved.branch}.ticket`, ticket.slug], repository.path, undefined, undefined, true).ok) return stepFailure("setup");
    if (!repository.setup.every(command => work.check(command, "setup"))) return stepFailure("setup");
    if (pending() !== "") {
      return stepFailure("setup", "A setup command changed tracked or unignored files in the worktree; they would be committed with the ticket. Ignore its outputs in the repository.");
    }
    return { type: "prepared" };
  }

  /** Read the pull request base from the remote itself and make its commit available without moving local refs. */
  function remoteTip(): { tip: string; where: string } | undefined {
    const refuse = (why: string) => { work.block(why); return undefined; };
    // The remote's configured URL, not its name, keeps a separate pushurl from sending the commit elsewhere.
    saved.checked = run("git", ["config", "--get", `remote.${repository.remote}.url`], repository.path).stdout || repository.remote;
    const name = pullRequestBase();
    // A base that names no branch stands for the remote's default branch, which the remote names with the same answer.
    const ref = name ? `refs/heads/${name}` : "HEAD";
    const listed = attempt("git", ["ls-remote", "--symref", saved.checked, ref], repository.path, publishTimeoutMs,
      `Remote ${repository.remote} could not be reached to check that the base is published; nothing was changed`);
    if (!listed.ok) return undefined;
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
        `The tip of ${where} could not be fetched to check that the base is published; nothing was changed`).ok) return undefined;
    return { tip, where };
  }

  /** The push must carry no unpublished base commits. Return the remote tip that proved the base was published. */
  function published(commit = saved.baseCommit): string | undefined {
    const remote = remoteTip();
    if (!remote) return undefined;
    const { tip, where } = remote;
    if (run("git", ["merge-base", "--is-ancestor", commit, tip], repository.path).ok) return tip;
    const ahead = git(repository.path, "rev-list", "--count", `${tip}..${commit}`);
    work.block(`Base ${repository.base ?? "HEAD"} has ${ahead} unpublished local commit${ahead === "1" ? " that is" : "s that are"} not in ${where}, `
      + `and the pull request would carry them. The base must be pushed first; nothing was changed. Checked commit: ${commit}.`);
    return undefined;
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
    // Validate the candidate on its own base before prepare moves it onto the current tip.
    if (!tip || !run("git", ["merge-base", "--is-ancestor", tip, saved.baseCommit], repository.path).ok) {
      if (!tip || !run("git", ["merge-base", tip, saved.baseCommit], repository.path).ok) {
        return work.block(`Cannot resume: ${saved.branch} shares no history with the base commit ${saved.baseCommit}; nothing was changed.`);
      }
      let onRemote = false;
      if (repository.output === "pr") {
        const remote = remoteTip();
        if (!remote) return { type: "blocked" };
        onRemote = run("git", ["merge-base", "--is-ancestor", saved.baseCommit, remote.tip], repository.path).ok
          && run("git", ["merge-base", "--is-ancestor", tip, remote.tip], repository.path).ok;
      }
      if (!onRemote) {
        const own = git(repository.path, "rev-list", "--count", `${saved.baseCommit}..${tip}`);
        return work.block(`Cannot resume: ${saved.branch} holds ${own} commit${own === "1" ? " that is" : "s that are"} not in the base commit ${saved.baseCommit}, `
          + "so something was committed on it or the base moved back; only an uncommitted candidate is resumed, and nothing was changed.");
      }
    }
    saved.baseCommit = tip;
    try {
      if (lstatSync(scopeFile(), { throwIfNoEntry: false })) {
        const record = JSON.parse(readFileSync(scopeFile(), "utf8"));
        if (record.ticket !== ticket.id || record.branch !== saved.branch || !Array.isArray(record.additions)
          || !record.additions.every(scopeAddition) || new Set(record.additions.map((item: ScopeAddition) => item.path)).size !== record.additions.length) {
          return work.block(`Cannot resume: invalid scope additions in ${scopeFile()}; nothing was changed.`);
        }
        saved.scopeAdditions = record.additions;
      }
    } catch (error) { return work.block(`Cannot resume: ${scopeFile()}: ${String(error)}; nothing was changed.`); }
    // Legacy clean worktrees start afresh. A saved origin also carries the assumptions its plan used.
    if (pending() !== "" || existsSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), "ticket-task-resume.json"))) {
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

  const rawGit = (...args: string[]) => execFileSync("git", args, {
    cwd: worktree, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const unmerged = () => rawGit("diff", "--name-only", "--diff-filter=U", "-z").split("\0").filter(Boolean);
  const marked = (path: string) => {
    const file = join(worktree, path);
    return existsSync(file) && lstatSync(file).isFile() && /^(?:<<<<<<< |\|\|\|\|\|\|\| |>>>>>>> )/mu.test(readFileSync(file, "utf8"));
  };
  const markerlessPrompt = () => saved.moved!.conflicts.filter(path => !marked(path)).map(path => {
    if (!existsSync(join(worktree, path))) return `${JSON.stringify(path)}: Git left it deleted; leaving it so removes the file.`;
    const hash = git(worktree, "hash-object", "--", path);
    const matches = (ref: string) => {
      const blob = run("git", ["rev-parse", "--verify", `${ref}:${path}`], worktree);
      return blob.ok && blob.stdout === hash;
    };
    const version = matches("HEAD") ? "the current base's version"
      : matches(saved.moved!.ref) ? "the saved candidate's version" : "a version from neither side";
    return `${JSON.stringify(path)}: No conflict markers; the worktree holds ${version}. Leaving it alone keeps that version.`;
  });
  const moveRecord = () => join(git(worktree, "rev-parse", "--absolute-git-dir"), "ticket-task-move.json");
  const movedPrompt = () => saved.moved ? [
    `The ${saved.moved.at === "delivery" ? "delivery" : "resume"} move from ${saved.moved.from} onto base ${saved.moved.to} ${saved.baseCommit === saved.moved.to ? "was applied" : "was restored on its old base"}. Saved candidate: ${saved.moved.ref} (${saved.moved.patch}).`,
    ...(saved.moved.settled.length ? [`Settled conflicts: ${saved.moved.settled.map(path => JSON.stringify(path)).join(", ")}. Check that both sides' intent survives.`] : []),
  ] : [];
  function conflict(): Event {
    const moved = saved.moved!;
    const diff = join(work.open(), "resume-conflicts.diff");
    const sides = moved.conflicts.map(path => `File: ${JSON.stringify(path)}\nCurrent base changes:\n`
      + rawGit("diff", "--binary", "--no-ext-diff", "--no-textconv", moved.from, moved.to, "--", path)
      + `\nSaved candidate changes:\n` + rawGit("diff", "--binary", "--no-ext-diff", "--no-textconv", moved.from, moved.ref, "--", path)).join("\n");
    writeFileSync(diff, sides, { mode: 0o600 });
    work.block(`Saved candidate: ${moved.ref} (${moved.patch}). Conflicts: ${moved.conflicts.map(path => JSON.stringify(path)).join(", ")}. `
      + `Moved from ${moved.from} to ${moved.to}. Both sides: ${diff}\n${sides.slice(0, 12000)}`);
    return { type: "conflicted" };
  }

  /** Preserve the candidate off-branch, then apply it to the current base before fresh checks and review. */
  function moveOnto(tip: string, at: "resume" | "delivery" = "resume"): Event {
    if (repository.output === "pr" && !published(tip)) return { type: "stuck" };
    const original = saved.baseCommit;
    let snapshot = "";
    const stop = (reason: string): Event => { work.block(reason); return { type: "stuck" }; };
    const restore = () => {
      git(worktree, "symbolic-ref", "HEAD", `refs/heads/${saved.branch}`);
      git(worktree, "reset", "--hard", snapshot || original);
      // Clean under the saved candidate's rules before its additions become untracked again.
      git(worktree, "clean", "-f", "-d", "-q", "-e", "/.machine-runs");
      undo(original);
    };
    if (pending() !== "") {
      git(worktree, "add", "--all");
      git(worktree, "reset", "--quiet", "--", ".machine-runs");
      const tree = git(worktree, "write-tree");
      // commit-tree creates only a recovery object: no hooks, branch movement, or approved ticket commit.
      snapshot = git(worktree, "commit-tree", tree, "-p", original, "-m", ticket.title, "-m", `Ticket: ${ticket.id}`);
      const ref = `refs/machine-shop/saved/${ticket.slug}/${snapshot}`;
      git(worktree, "update-ref", ref, snapshot);
      // Each move in a run saves its own patch; the first keeps the name earlier evidence readers know.
      const patch = join(work.open(), ++saved.moves === 1 ? "saved-candidate.patch" : `saved-candidate-${saved.moves}.patch`);
      writeFileSync(patch, rawGit("diff", "--binary", "--no-ext-diff", "--no-textconv", original, snapshot), { flag: "wx", mode: 0o600 });
      saved.moved = { from: original, to: tip, ref, patch, conflicts: [], settled: [], at };
    }
    try {
      git(worktree, "reset", "--quiet", "--hard", tip);
      if (snapshot) {
        const added = rawGit("diff-tree", "-r", "--no-renames", "--diff-filter=A", "--name-only", "-z", original, snapshot);
        const paths = join(work.open(), "resume-added.paths");
        writeFileSync(paths, added, { mode: 0o600 });
        const fd = openSync(paths, "r");
        try {
          const ignored = spawnSync("git", ["check-ignore", "--no-index", "-v", "-z", "--stdin"], {
            cwd: worktree, stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
          });
          if (ignored.error || (ignored.status !== 0 && ignored.status !== 1)) throw new Error(`Cannot check ignore rules: ${ignored.error?.message ?? ignored.stderr}`);
          const entries = ignored.stdout.split("\0");
          const dropped: string[] = [];
          for (let index = 0; index + 3 < entries.length; index += 4) {
            if (!entries[index + 2]!.startsWith("!")) dropped.push(`${JSON.stringify(entries[index + 3])} (rule in ${JSON.stringify(entries[index])}:${entries[index + 1]})`);
          }
          if (dropped.length) {
            restore();
            return stop(`Ignore rules on base ${tip} would drop added files: ${dropped.join(", ")}. The candidate was restored uncommitted on ${original}.`);
          }
        } finally { closeSync(fd); }
      }
      for (const command of repository.setup) {
        const passed = work.check(command, "setup");
        const moved = git(worktree, "rev-parse", "HEAD") !== tip
          || run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}`;
        if (!passed || moved || pending() !== "") {
          restore();
          work.reopen(true);
          return stop(`setup: ${command.name} ${moved ? "moved HEAD or the ticket branch" : !passed ? "failed" : "changed tracked or unignored files"} on base ${tip}; the worktree was restored on ${original}.`);
        }
      }
      if (!snapshot) { saved.baseCommit = tip; return { type: "prepared" }; }
      const applied = run("git", ["cherry-pick", "--no-commit", snapshot], worktree);
      const conflicts = unmerged();
      if (conflicts.length) {
        saved.baseCommit = tip;
        saved.moved!.conflicts = conflicts;
        writeFileSync(moveRecord(), JSON.stringify(saved.moved) + "\n", { mode: 0o600 });
        return conflict();
      }
      if (!applied.ok) throw new Error(`Cannot re-apply the saved candidate: ${applied.detail}`);
      if (run("git", ["diff", "--cached", "--quiet", "HEAD"], worktree).ok) {
        restore();
        return stop(`Base ${tip} already holds this change; the candidate was restored uncommitted on ${original}.`);
      }
      git(worktree, "reset", "--quiet");
      saved.baseCommit = tip;
      return { type: "resumed" };
    } catch (error) {
      restore();
      return stop(`Move onto ${tip} failed: ${String(error)}. The candidate was restored uncommitted on ${original}.`);
    }
  }

  /** A claimed resolution must clear both the unmerged index and markers before scope, checks, and review. */
  function unsettled(): Event | undefined {
    const moved = saved.moved;
    if (!moved?.conflicts.length) return undefined;
    const unmergedPaths = new Set(unmerged());
    for (const path of moved.conflicts) {
      if (unmergedPaths.has(path) && !marked(path)) git(worktree, "add", "--all", "--", `:(literal)${path}`);
    }
    const remaining = [...new Set([...unmerged(), ...moved.conflicts.filter(marked)])];
    if (remaining.length) {
      work.block(`Saved candidate: ${moved.ref} (${moved.patch}). Unsettled conflicts: ${remaining.map(path => JSON.stringify(path)).join(", ")}. Remove every conflict marker in each, keeping both sides' intent, without committing.`);
      return { type: "failed" };
    }
    git(worktree, "reset", "--quiet");
    moved.settled = moved.conflicts;
    moved.conflicts = [];
    rmSync(moveRecord(), { force: true });
    return undefined;
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
    let pullRequest = "";
    if (repository.output === "pr") {
      const found = deliveredPullRequest(name, tip, refuse);
      if (typeof found !== "string") return found;
      pullRequest = found;
    }
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
    // Delivery updates the pull request found open for the delivered commit: no second one is opened.
    if (pullRequest) { saved.prUrl = pullRequest; saved.lease = tip; }
    return { type: "redeliver" };
  }

  /**
   * In pr mode a delivered commit is taken up only through its one open pull request on the base prepare would check, whose head on the
   * host is still the delivered commit: the URL of that pull request, or the refusal. Nothing is changed either way.
   */
  function deliveredPullRequest(name: string, delivered: string, refuse: (why: string) => Event): string | Event {
    // The base is read from the remote itself, as prepare reads it, and the host is asked in the repository found there.
    if (!remoteTip()) return { type: "blocked" };
    const hosted = hostedRepository(saved.checked);
    if (!hosted) return refuse(`remote ${repository.remote} does not name a hosted owner/repository, so its pull request cannot be found`);
    // Every pull request in any state counts: a branch name the host lists more than once is not one pull request to update.
    const listed = attempt("gh", ["pr", "list", "--repo", hosted, "--head", name, "--state", "all", "--limit", "10",
      "--json", "number,url,state,baseRefName,headRefOid"], repository.path, publishTimeoutMs,
    "Cannot resume: the host could not be reached to find the delivered pull request; nothing was changed");
    if (!listed.ok) return { type: "blocked" };
    let found: unknown;
    try { found = JSON.parse(listed.stdout); } catch { found = undefined; }
    const shaped = (one: unknown): one is { url: string; state: string; baseRefName: string; headRefOid: string } => !!one && typeof one === "object"
      && ["url", "state", "baseRefName", "headRefOid"].every(key => typeof (one as Record<string, unknown>)[key] === "string");
    if (!Array.isArray(found) || !found.every(shaped)) return refuse(`the host's list of pull requests for ${name} could not be read`);
    if (!found.length) return refuse(`the host lists no pull request for ${name} in ${hosted}`);
    if (found.length > 1) return refuse(`the host lists more than one pull request for ${name} in ${hosted}: ${found.map(one => one.url).join(", ")}`);
    const [one] = found as [{ url: string; state: string; baseRefName: string; headRefOid: string }];
    if (one.state === "MERGED") return refuse(`pull request ${one.url} was merged, so there is nothing to rebase`);
    if (one.state !== "OPEN") return refuse(`pull request ${one.url} is ${one.state === "CLOSED" ? "closed" : `not open but ${one.state}`}`);
    if (one.baseRefName !== saved.checkedBase) return refuse(`pull request ${one.url} is based on ${one.baseRefName}, not on the run's base ${saved.checkedBase}`);
    if (one.headRefOid !== delivered) {
      return refuse(`the head of pull request ${one.url} on the host is ${one.headRefOid}, not the delivered commit ${delivered}: someone pushed to it, and that is never overwritten`);
    }
    return one.url;
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
      return stepFailure("commit", `An Agent committed or moved HEAD or ${saved.branch} itself; only this workflow commits. Nothing was delivered.`);
    }
    if (!work.accept()) return stepFailure("commit");
    const index = git(worktree, "write-tree");
    // Unstaging afterwards also drops run evidence an Agent staged by force; an exclude pathspec fails outright on an ignored .machine-runs.
    git(worktree, "add", "--all");
    git(worktree, "reset", "--quiet", "--", ".machine-runs");
    if (run("git", ["diff", "--cached", "--quiet"], worktree).ok) return stepFailure("commit", "Nothing to commit: the approved candidate does not differ from its base commit.");
    const tree = git(worktree, "write-tree");
    if (!attempt("git", ["commit", "--quiet", "-m", ticket.title, "-m", `Ticket: ${ticket.id}`], worktree, undefined, undefined, true).ok) {
      // Restore the pre-commit index so accept() can compare the same verified candidate on retry.
      git(worktree, "read-tree", index);
      return stepFailure("commit");
    }
    // Commit hooks run, but only the approved tree under the ticket's own message may be delivered.
    const [origin, subject, ...body] = git(worktree, "log", "-1", "--no-show-signature", "--format=%T %P%n%s%n%b").split("\n");
    if (origin !== `${tree} ${saved.baseCommit}` || pending() !== "" || subject !== ticket.title || !body.some(line => flat(line) === flat(`Ticket: ${ticket.id}`))) {
      return stepFailure("commit", `A commit hook or Git configuration changed the approved candidate or its commit message; ${saved.branch} holds that unapproved commit and nothing was delivered.`);
    }
    const head = git(worktree, "rev-parse", "HEAD");
    // A hook can also detach HEAD or reset the branch; the ticket branch itself must hold the approved commit.
    if (run("git", ["symbolic-ref", "--quiet", "HEAD"], worktree).stdout !== `refs/heads/${saved.branch}` || git(repository.path, "rev-parse", `refs/heads/${saved.branch}`) !== head) {
      return stepFailure("commit", `A commit hook or Git configuration moved HEAD or ${saved.branch} away from the approved commit; nothing was delivered.`);
    }
    saved.commitHash = head;
    saved.firstApproved ??= { baseCommit: saved.baseCommit, commit: head };
    passed("commit");
    return { type: "committed" };
  }

  /** Before publication, replay failures return an uncommitted candidate on the ticket's own branch. */
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
    let tip = resolved.stdout;
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
    const readRemoteTip = () => {
      const ref = `refs/heads/${saved.checkedBase}`;
      const listed = step(["ls-remote", saved.checked, ref], repository.path, publishTimeoutMs);
      const remote = listed.stdout.split("\n").map(line => line.split("\t"))
        .find(([id, at]) => at === ref && /^[0-9a-f]{40,64}$/u.test(id ?? ""))?.[0];
      const available = listed.ok && remote && (run("git", ["cat-file", "-e", `${remote}^{commit}`], repository.path).ok
        || step(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", saved.checked, remote], repository.path, publishTimeoutMs).ok);
      return available ? remote : undefined;
    };
    const unpublished = (commit: string) => {
      undo(original);
      return stop(`Base ${commit} cannot be shown to be published on ${saved.checkedBase} at ${repository.remote}; the base must be pushed first. Inspect any rebase logs in ${work.open()}.`);
    };
    let remote: string | undefined;
    // A run started from a published tip may still have a local base behind it. Compare with the recorded remote in that case.
    if (repository.output === "pr" && resolved.ok && tip !== original
      && run("git", ["merge-base", "--is-ancestor", tip, original], repository.path).ok) {
      remote = readRemoteTip();
      if (!remote) return unpublished(original);
      tip = remote;
    }
    if (!resolved.ok || tip === original) {
      if (saved.untested) {
        if (!resolved.ok) return withdraw("the current base no longer resolves");
        setNow(`running ${repository.checks.join(", ")}`);
        if (work.checks().type !== "passed" || !work.accept()) {
          undo(original); work.reopen(true); saved.repairing = "change";
          saved.reviewsFrom = saved.reviews.length; saved.taken = "";
          return { type: "failed" };
        }
        saved.untested = false;
        saved.redelivered = true;
      }
      return { type: "current" };
    }
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
      return stepFailure("rebase", `Base ${original} was rewritten or moved back to ${tip}; the ticket must be delivered by hand.`);
    }
    if (repository.output === "pr") {
      remote ??= readRemoteTip();
      if (!remote || !run("git", ["merge-base", "--is-ancestor", tip, remote], repository.path).ok) return unpublished(tip);
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
      if (conflicts) {
        // Every conflict is moved onto the tip; replay decides whether the repair budget lets the implementer settle it.
        saved.reviewsFrom = saved.reviews.length;
        saved.rebasedFrom ??= saved.firstApproved;
        const moved = moveOnto(tip, "delivery");
        if (moved.type === "conflicted" || moved.type === "resumed") {
          work.block(`Replay onto ${tip} conflicted in ${conflicts.split("\n").join(", ")}; the run moved the approved candidate onto ${tip} itself${saved.moves > 1 ? `, its move ${saved.moves} of this run` : ""}.`
            + (moved.type === "conflicted" ? ` ${work.status().reason}` : ""));
        }
        return moved;
      }
      return stop(`Replay onto ${tip} failed (Git or a hook refused it). `
        + `The approved candidate is uncommitted on ${original}; a resumed run moves it onto the current base and sends conflicts to the implementer to settle. Inspect rebase logs in ${work.open()}.`);
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
        return stop(`${reason} Undo onto ${tip} was needed because ${why}. The approved candidate is uncommitted on its original base ${original}; a resumed run checks the current tip's ignore rules before re-applying and stops again until the candidate or ignore rules are reconciled.`);
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
    setNow(`running ${repository.checks.join(", ")}`);
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
      const made = attempt("git", ["format-patch", "--output-directory", directory, `${saved.baseCommit}..HEAD`], worktree, undefined, undefined, true);
      if (!made.ok) return stepFailure("deliver");
      saved.patches = made.stdout.split("\n").filter(Boolean);
    }
    if (repository.output === "pr") {
      // gh must open the pull request in the repository the push went to, whatever GH_REPO or other remotes say.
      const hosted = hostedRepository(saved.checked);
      if (!hosted) throw new Error("Prepared pull request remote no longer names a hosted repository");
      // The only ref ever pushed is this run's own branch at the approved commit, whatever push.followTags says, and without force
      // except when updating a delivered pull request: then only with a lease on the delivered commit, so a push someone else made is never overwritten.
      // An updated pull request whose commit did not change is not pushed at all.
      // It goes to the URL prepare checked, read once: a remote reconfigured since then, as an Agent can do, is not asked again.
      if (saved.commitHash !== saved.lease) {
        const lease = saved.lease ? [`--force-with-lease=refs/heads/${saved.branch}:${saved.lease}`] : [];
        const sent = attempt("git", ["push", "--no-follow-tags", ...lease, saved.checked, `${saved.commitHash}:refs/heads/${saved.branch}`], worktree, publishTimeoutMs, undefined, true);
        if (!sent.ok) {
          if (saved.lease && /\(stale info\)/u.test(sent.detail)) {
            return stepFailure("deliver", `The branch of pull request ${saved.prUrl} moved on the host after resume found the delivered commit ${saved.lease} at its head, `
              + `so the push with a lease on that commit was refused and nothing was overwritten; ${saved.branch} holds ${saved.commitHash} locally. Inspect ${join(directory, "git-push.log")}.`);
          }
          return stepFailure("deliver", undefined, "unreachable");
        }
        saved.pushed = true;
      }
      if (!saved.prUrl) {
        const body = join(directory, "pull-request.md");
        writeFileSync(body, [
          ticket.title,
          ...(ticket.summary ? ["## Summary", ticket.summary] : []),
          ...(saved.assumptions.length ? ["## Assumptions", saved.assumptions.map(({ question, answer, why }) => `- ${flat(question)} Assumed: ${flat(answer)} (${flat(why)})`).join("\n")] : []),
          ...scopeAdditionSection(),
          "## Checks", repository.checks.map(name => `- ${name}: passed${(saved.task.flaky ?? []).includes(name) ? " (flaky: failed once, passed when run again alone)" : ""}`).join("\n"),
          // The helper has already taken the summary out of a JSON report; one that is still an object is evidence, not text for a reader.
          "## Review", jsonObject(saved.reviewSummary) ? "The reviewer approved this change without a written summary; its report is kept with the run evidence." : saved.reviewSummary,
          ...(saved.reviewNotes.length ? ["## Review notes", saved.reviewNotes.map(note => `- ${flat(note.text)}${flat(note.where) ? ` (${flat(note.where)})` : ""}`).join("\n")] : []),
          `Ticket: ${ticket.id}`,
        ].join("\n\n") + "\n", { mode: 0o600 });
        // The base is always named, and is the one prepare compared with the remote, not one read again from refs or configuration that may have changed since.
        const opened = attempt("gh", ["pr", "create", "--repo", hosted, ...(repository.draft ? ["--draft"] : []), "--base", saved.checkedBase,
          "--head", saved.branch, "--title", ticket.title, "--body-file", body], worktree, publishTimeoutMs, undefined, true);
        if (!opened.ok) return stepFailure("deliver", undefined, "unreachable");
        saved.prUrl = opened.stdout.split(/\s+/u).findLast(word => /^https?:\/\/\S+$/u.test(word)) ?? "";
        if (!saved.prUrl) return stepFailure("deliver", `gh pr create printed no pull request URL; inspect ${saved.branch} on ${repository.remote}.`);
      }
    }
    if (!attempt("git", ["config", "--local", `branch.${saved.branch}.ticketDelivered`, saved.commitHash], repository.path, undefined, undefined, true).ok) return stepFailure("deliver");
    passed("deliver");
    // The next state's status lifecycle publishes this pair, as it does on continuation.
    composeHandoff("Delivered the checked changes.", "");
    return { type: "delivered" };
  }


  /** Presentation reads evidence only; a missing candidate or Git failure must not prevent the question. */
  function diffFiles() {
    try {
      const cwd = saved.removed ? repository.path : worktree;
      if (!saved.baseCommit || (saved.removed && !saved.commitHash)) return undefined;
      const diff = git(cwd, "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
        saved.baseCommit, ...(saved.removed ? [saved.commitHash] : []), "--", ".", ":(exclude).machine-runs");
      const count = (value: string) => value === "-" ? null : Number(value);
      const files = diff.split("\0").filter(Boolean).map(entry => {
        const [added, removed, ...path] = entry.split("\t");
        return { path: path.join("\t"), added: count(added!), removed: count(removed!) };
      });
      if (!saved.removed) {
        const untracked = git(cwd, "ls-files", "--others", "--exclude-standard", "-z", "--", ".", ":(exclude).machine-runs");
        for (const path of untracked.split("\0").filter(Boolean)) {
          // Git counts text, binary files and symlinks consistently with the tracked diff.
          const result = run("git", ["diff", "--no-index", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--", "/dev/null", path], cwd);
          if (result.status !== 0 && result.status !== 1) return undefined;
          const [added = "0", removed = "0"] = result.stdout.split("\t");
          files.push({ path, added: count(added), removed: count(removed) });
        }
      }
      return files;
    } catch { return undefined; }
  }
  function runFacts() {
    const { reason, ...rounds } = work.status();
    const review = saved.reviews.slice(saved.reviewsFrom).at(-1);
    // Keep the latest attempt per phase and name, in execution order. A red
    // proof's expected failure and setup success are not green verification.
    const latest = new Map<string, (typeof saved.task.evidence)[number]>();
    for (const check of saved.task.evidence) {
      const key = JSON.stringify([check.phase, check.name]);
      latest.delete(key);
      latest.set(key, check);
    }
    const checks = [...latest.values()]
      .map(({ name, phase, exitCode, passed, log, flaky }) => ({ name, phase, exitCode, passed, log, flaky,
        ...(!passed ? { tail: evidenceLog(log) } : {}),
      }));
    return {
      repository: { name: repository.name, path: repository.path }, ticket: { id: ticket.id, title: ticket.title },
      plan: saved.plan, planningReport: saved.planningReport, questions: saved.ownerQuestions, wouldAssume: saved.wouldAssume,
      moved: saved.moved, scopeMiss: saved.pendingScope, scopeAdditions: saved.scopeAdditions,
      candidate: { worktreeRemoved: saved.removed, pushed: saved.pushed, baseCommit: saved.baseCommit, commit: saved.commitHash },
      stage: saved.stoppedIn,
      reason,
      rounds: { ...rounds, extraRound: saved.extraRound, extraReviewRounds: saved.extraReviewRounds },
      checks, lastChecksPassed: saved.task.lastChecksPassed,
      review: review ? { verdict: review.type, criteria: review.criteria, summary: review.summary, findings: review.findings, newSinceLastRound: review.newSinceLastRound } : null,
      recentReports: saved.task.reports.slice(-6),
      reports: {
        sentBack: saved.task.reportFaults > 0 || saved.questionsReturned,
        reportRecovery: saved.task.reportRecovery, malformedReviews: saved.malformedReviews,
        reviewSummaryFault: saved.reviewSummaryFault, planningReports: saved.planningReports,
        questionsReturned: saved.questionsReturned, questionsFault: saved.questionsFault,
      },
      files: snapshotFiles() ?? undefined, evidenceDirectory: saved.task.directory, worktree, branch: saved.branch, prUrl: saved.prUrl,
      questionFile: saved.questions ? join(saved.task.directory, `question-${saved.questions}.txt`) : undefined,
    };
  }
  /** Keep strings literal in terminal evidence, including multi-line questions and log excerpts. */
  function evidenceText(value: unknown): string {
    if (value === undefined || value === null) return "None recorded.";
    if (typeof value !== "object") return String(value);
    if (Array.isArray(value)) return value.map(item => evidenceText(item)).join("\n\n");
    return Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${key}: ${evidenceText(item)}`).join("\n");
  }
  function snapshotFiles() {
    // Keep the last readable candidate before discard or delivery removes it.
    // After removal the saved base and commit can still refresh a delivered diff.
    if (saved.removed && saved.handoffFiles !== null) return saved.handoffFiles;
    const files = diffFiles();
    if (files !== undefined) saved.handoffFiles = files;
    return saved.handoffFiles;
  }
  function roundsText(rounds: ReturnType<typeof runFacts>["rounds"]): string {
    const { repairs, totalRepairs, maxRepairs, reviewRounds, totalReviewRounds, maxReviewRounds, extraRound, extraReviewRounds } = rounds;
    return [
      `Repair rounds: ${repairs} of ${maxRepairs}${totalRepairs !== repairs ? ` (${totalRepairs} in all)` : ""}.`,
      `Review rounds: ${reviewRounds} of ${maxReviewRounds}${totalReviewRounds !== reviewRounds ? ` (${totalReviewRounds} in all)` : ""}.`,
      ...(extraRound !== "unused" ? [`The one extra review round was used and ${extraRound === "running" ? "is still in progress" : "has ended"}; review retries: ${extraReviewRounds} of ${maxReviewRounds}.`] : []),
    ].join(" ");
  }
  function evidenceBlocks(facts: ReturnType<typeof runFacts>) {
    const files = facts.files;
    const diffStat = files === undefined ? "Diff unavailable."
      : `${files.length} files changed, ${files.reduce((sum, file) => sum + (file.added ?? 0), 0)} insertions, ${files.reduce((sum, file) => sum + (file.removed ?? 0), 0)} deletions; binary counts are shown as binary.`;
    const blocks: EvidenceBlock[] = [
      { title: "Rounds", text: roundsText(facts.rounds) },
      ...(saved.pendingScope ? [{ title: "Scope decision", text: scopeQuestion() + "\n" + scopeChanges() }] : []),
      ...(saved.scopeAdditions.length ? [{ title: "Scope additions", text: scopeAdditionLines().join("\n") }] : []),
      ...(saved.ownerQuestions ? [{ title: "Open questions and options", text: questionLines() + wouldAssumeLines() }] : []),
      ...(saved.plan ? [{ title: "Plan", text: saved.plan }] : []),
      ...(["falsify", "plan", "planReview"].includes(saved.repairing)
        ? [{ title: "Planning report and objection", text: evidenceText(saved.planningReport) }] : []),
      { title: "Changed files", text: diffStat, ...(files === undefined ? {} : { table: {
        headings: ["File", "Added", "Removed"], rows: files.map(file => [file.path, String(file.added ?? "binary"), String(file.removed ?? "binary")]),
      } }) },
      ...facts.checks.filter(check => !check.passed).map(({ tail, ...check }) => ({
        title: `Failing gate: ${check.name}`, text: evidenceText(check), tail,
      })),
      { title: "Passing checks", text: evidenceText(facts.checks.filter(check => check.passed)) },
      ...(facts.review ? [{ title: "Review", text: evidenceText(facts.review) }, {
        title: "Unmet criteria and open findings", text: evidenceText({
          unmet: Array.isArray(facts.review.criteria) ? facts.review.criteria.filter(item => item?.met === false) : facts.review.criteria,
          findings: facts.review.findings,
        }),
      }] : []),
      ...(saved.moved ? [{ title: "Replay conflicts and saved candidate", text: evidenceText(saved.moved) }] : []),
      { title: "Candidate", text: evidenceText(facts.candidate) },
      { title: "Agent summaries", text: evidenceText(facts.recentReports) },
      { title: "Reports and evidence", text: evidenceText(facts.reports) + `\nEvidence: ${facts.evidenceDirectory}\n${facts.prUrl ? `Pull request: ${facts.prUrl}\n` : ""}${facts.questionFile ?? ""}` },
    ];
    return { blocks, diffStat };
  }

  function composeHandoff(outcome: string, needs: string, facts = runFacts()) {
    const { blocks } = evidenceBlocks(facts);
    const review = facts.review;
    const reviewBlocks: EvidenceBlock[] = review ? [
      { title: `Verdict: ${review.verdict}`, text: evidenceText(review.summary) },
      { title: "Acceptance criteria", text: Array.isArray(review.criteria) ? review.criteria.map(item =>
        `${item?.met === true ? "Met" : "Not met"}: ${evidenceText(item?.text)}\n${evidenceText(item?.evidence)}`).join("\n\n") : evidenceText(review.criteria) },
      ...["blocker", "discussion", "minor"].map(severity => ({ title: `${severity} findings`,
        text: Array.isArray(review.findings) ? evidenceText(review.findings.filter(item => item?.severity === severity)) || "None." : evidenceText(review.findings) })),
      { title: "Changes since previous review", text: evidenceText(review.newSinceLastRound) },
    ] : [];
    const verification = (check: (typeof facts.checks)[number]) => check.phase === "verify" || check.phase === "reverify";
    const checks = new Map(facts.checks.filter(verification).map(check => [check.name, check]));
    const gate = (name: string, check?: (typeof facts.checks)[number]) => ({
      name, outcome: !check ? "skipped" as const : check.passed ? "passed" as const : "failed" as const, tail: check?.tail,
    });
    const gates = [
      ...(checks.size ? [...new Set([...repository.checks, ...checks.keys()])].map(name => gate(name, checks.get(name))) : []),
      ...facts.checks.filter(check => !verification(check))
        .map(check => gate(`${check.phase === "red" ? "red proof" : check.phase}: ${check.name}`, check)),
    ];
    const stageWords: Record<string, string> = {
      falsify: "checked the ticket", plan: "planned", planReview: "had the plan reviewed",
      red: "proved the tests fail first", change: "implemented the change", verify: "passed the gates",
      review: "passed review", commit: "committed", deliver: "delivered",
    };
    const page = handoffPage({
      title: ticket.title, breadcrumb: `${repository.name}: ${repository.path} · Ticket: ${ticket.id} · Branch: ${saved.branch}${saved.prUrl ? ` · Pull request: ${saved.prUrl}` : saved.patches.length ? ` · Patch: ${saved.patches.join(", ")}` : ""}`,
      outcome, done: saved.passedStages.map(stage => stageWords[stage] ?? stage), decided: saved.assumptions.length ? evidenceText(saved.assumptions) : "No assumptions taken.",
      needs: needs || "Nothing needed.", files: facts.files ?? null, gates, review: reviewBlocks,
      evidence: [{ title: "Stage and candidate location", text: `${facts.stage}\nWorktree: ${worktree}` },
        ...(saved.held ? [{ title: "Ending", text: saved.held.summary }] : []),
        // Keep the question's gate metadata as well as its other evidence. The table,
        // diagnostic tails and structured review already have dedicated sections above.
        ...blocks.filter(block => !["Changed files", "Review", "Unmet criteria and open findings"].includes(block.title))
          .map(({ tail: _tail, ...block }) => block)],
    });
    saved.handoff = writeHandoff(work.open(), page);
  }
  function publishHandoff(outcome: string, needs: string, facts = runFacts()) {
    composeHandoff(outcome, needs, facts);
    publishNow(activeMeaning);
  }
  function questionEvidence() {
    const choices = saved.pendingScope ? scopeDecisions : decisions;
    const facts = runFacts();
    const options = stuckOptions();
    const short = (value: string) => excerpt(value.replace(/\s+/gu, " ").trim(), 160).replace(/\s+/gu, " ");
    const effects = Object.fromEntries(choices.map(name => {
      // Long branch/worktree names belong in the breadcrumb, not in the 160-character effect.
      const does = options.find(option => option.name === name)!.does;
      return [name, short(does)];
    }));
    const recommended = saved.pendingScope ? "" : "hand off";
    const headline = short(`${ticket.id}: Decision needed at ${facts.stage}`);
    const reason = saved.pendingScope ? "" : "Keep the work available while a person or another workflow resolves this stop.";
    const breadcrumb = `${repository.name}: ${repository.path}\nTicket: ${ticket.id} — ${ticket.title}\nBranch: ${saved.branch}\nWorktree: ${worktree}`;
    const stopped = `Stopped in ${facts.stage}: ${facts.reason}`;
    const { blocks, diffStat } = evidenceBlocks(facts);
    const page = evidencePage({ headline, stopped, breadcrumb, blocks, effects, recommended });
    const selected = { ...facts, diffStat, effects, ...(recommended ? { recommended } : {}) };
    writeStuckEvidence(work.open(), `# ${headline}\n\n${breadcrumb}\n\n${stopped}\n\n${evidenceText(selected)}`, page);
    publishHandoff(`Stopped in ${facts.stage}; a decision is needed.`, facts.reason, facts);
    return { presentation: { headline, page, effects, recommended, reason,
      discards: choices.filter(choice => choice === "discard"),
    }, facts: evidenceFacts(selected) };
  }
  const standing = () => {
    const { repairs, totalRepairs, maxRepairs, reviewRounds, totalReviewRounds, maxReviewRounds } = work.status();
    const latest = saved.reviews.slice(saved.extraRoundFrom).findLast(event => event.type !== "blocked" && !reviewField(event, ticket.sections.acceptance)) as ReviewReport | undefined;
    return [
      `Ticket ${ticket.id}. Stopped in ${saved.stoppedIn}.`,
      `Repair rounds used: ${repairs} of ${maxRepairs}${totalRepairs > repairs ? ` in this budget, ${totalRepairs} in all` : ""}.`,
      `Review rounds used: ${reviewRounds} of ${maxReviewRounds}${totalReviewRounds > reviewRounds ? ` in this budget, ${totalReviewRounds} in all` : ""}.`,
      ...(saved.extraRound !== "unused" ? [`The one extra review round was used; review retries: ${saved.extraReviewRounds} of ${maxReviewRounds}. ${latest ? `Reviewer newSinceLastRound: ${capped(latest.newSinceLastRound, 600)}` : "No review has finished in the extra round yet."}`] : []),
    ].join("\n");
  };
  const locations = () => [`Worktree: ${worktree}`, `Branch: ${saved.branch}`, `Evidence: ${work.open()}`,
    ...(saved.previousEvidence ? [`Earlier run's evidence: ${saved.previousEvidence}`] : []),
    ...(saved.moved ? [`Saved candidate: ${saved.moved.ref} (${saved.moved.patch})`] : []),
    ...(saved.moved?.conflicts.length ? [`Unsettled conflicts: ${saved.moved.conflicts.map(path => JSON.stringify(path)).join(", ")}`] : [])];
  const scopeQuestion = () => `May this ticket's scope include ${saved.pendingScope!.files.map(file => JSON.stringify(file.path)).join(", ")}?`;
  const scopeChanges = () => `Stage: ${saved.pendingScope!.stage}.\n` + saved.pendingScope!.files.map(file =>
    `${JSON.stringify(file.path)}: added ${file.added ?? "binary/unavailable"} lines, removed ${file.removed ?? "binary/unavailable"} lines.`).join("\n");
  const stuckOptions = () => [
    ...(saved.pendingScope ? [
      { name: "include", does: `include these exact paths for this run and return to ${saved.pendingScope.stage} without another editing Agent call.` },
      { name: "revert", does: `return to ${destination()} once to revert these paths; count one repair round.` },
    ] : [{ name: "continue", does: `return to ${destination()} with the owner's answer and fresh budgets.` }]),
    { name: "hand off", does: "stop here and keep the worktree and branch exactly as they are for another workflow or a person.", ...(!saved.pendingScope ? { recommended: true } : {}) },
    { name: "discard", does: "remove the worktree and delete the branch without saving the candidate; Drip confirms this choice." },
    { name: "any other reply", does: "answer the question and continue with this answer as standing feedback." },
  ];
  const stuckPrompt = () => {
    const rejectedPlan = saved.stoppedIn === "planReview" && saved.planRejectedAgain;
    return brief({
      decision: saved.pendingScope ? scopeQuestion() : rejectedPlan ? `${ticket.id}'s plan was rejected again in plan review: send it back to planning?` : asking().first,
      standing: standing(),
      needs: saved.pendingScope ? [
        // The shared brief caps and flattens its headline. Keep the exact question when that would cut or alter a filename.
        ...(scopeQuestion().length > 100 || /\s{2,}/u.test(scopeQuestion()) ? [scopeQuestion()] : []),
        scopeChanges(), work.status().reason,
      ].join("\n") : rejectedPlan ? capped(flat(work.status().reason), 600) : asking().rest || undefined,
      evidence: locations(), options: stuckOptions(),
    });
  };
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
  function asking(reason = work.status().reason): { first: string; rest: string } {
    if (saved.ownerQuestions) return {
      first: `Answer ${questionCount()} ${saved.stoppedIn === "falsify" ? "before any code is written" : "the reviewer raised"}.`,
      rest: `${questionLines(600)}${wouldAssumeLines(600)}`,
    };
    const why = flat(reason);
    const budget = /^(Repair|Review) budget exhausted \(\d+\)\. /u.exec(why);
    if (budget) {
      const { repairs, maxRepairs, reviewRounds, maxReviewRounds } = work.status();
      let first = `${budget[1]} budget used up (${budget[1] === "Repair" ? `${repairs} of ${maxRepairs}` : `${reviewRounds} of ${maxReviewRounds}`})`;
      const conflicts = saved.moved?.conflicts ?? [];
      if (conflicts.length) {
        first += ` with ${conflicts.length} unsettled conflict${conflicts.length === 1 ? "" : "s"}`;
        const paths = ` in ${conflicts.join(", ")}`;
        if (first.length + paths.length + 1 < 100) first += paths;
      }
      return { first: `${first}.`, rest: capped(why.slice(budget[0].length), 600) };
    }
    const split = opening(why);
    return { first: split.first, rest: capped(split.rest, 600) };
  }
  function summaryReason(reason: string, split = opening(flat(reason))): string {
    return [split.first, capped(split.rest, 600)].filter(Boolean).map(part => part.replace(/[^.!?…]$/u, "$&.")).join(" ");
  }
  const passed = (stage: string) => { if (!saved.passedStages.includes(stage)) saved.passedStages.push(stage); };
  const stopped = (state: string, run: () => Event) => () => {
    saved.stoppedIn = state;
    const result = run();
    if (["sound", "assumed", "planned", "approved"].includes(result.type)) passed(state.replace(/Result$/u, ""));
    return result;
  };

  /** Removes this run's own worktree and branch, and nothing else, after the person chooses discard. */
  function remove(): Event {
    if (!saved.discardConfirmed) throw new Error("The worktree and branch are removed only after discard");
    snapshotFiles();
    work.retire();
    if (!attempt("git", ["worktree", "remove", "--force", worktree], repository.path).ok) throw new Error(work.status().reason);
    saved.removed = true;
    if (!attempt("git", ["branch", "-D", saved.branch], repository.path).ok) throw new Error(work.status().reason);
    return { type: "removed" };
  }

  function conclude(wanted: "completed" | "refused" | "handed-off" | "abandoned"): Event {
    snapshotFiles();
    const result = `${saved.branch} at ${saved.commitHash}${saved.prUrl ? `, pull request ${saved.prUrl}` : ""}${saved.patches.length ? `, patch ${saved.patches.join(", ")}` : ""}`;
    // Delivery succeeds even when its worktree must be kept for manual cleanup.
    if (wanted === "completed") {
      saved.removed = attempt("git", ["worktree", "remove", worktree], repository.path, undefined,
        `The worktree could not be removed after delivering ${result}`).ok;
    }
    // A kept worktree the helper cannot fingerprint any more, as with a nested repository, still gets its ending recorded.
    work.retire();
    // The helper's receipt knows completed and blocked; delivery.json carries what a Human decided.
    const finished = work.finish(wanted === "completed" ? "completed" : "blocked").type === "completed";
    const outcome = finished ? "delivered" : wanted === "completed" ? "refused" : wanted;
    const directory = work.open();
    const reason = finished ? "" : String(work.output()?.reason);
    writeFileSync(join(directory, "delivery.json"), JSON.stringify({
      schemaVersion: 1, outcome, ...(finished ? {} : { reason }), ...(saved.decision ? { decision: saved.decision } : {}),
      ticket: ticket.id, repository: { name: repository.name, path: repository.path }, branch: saved.branch,
      baseCommit: saved.baseCommit || null, commit: saved.commitHash || null, output: repository.output,
      ...(saved.rebasedFrom ? { rebasedFrom: saved.rebasedFrom } : {}),
      ...(finished && saved.redelivered ? { redelivered: true } : {}),
      // A first delivery opens its pull request; a resumed one updates the one it found, or leaves it as it was when the commit did not change.
      ...(finished && saved.lease ? { pullRequest: saved.pushed ? "updated" : "unchanged" } : {}),
      ...(saved.assumptions.length ? { assumptions: saved.assumptions } : {}),
      ...(saved.scopeAdditions.length ? { scopeAdditions: saved.scopeAdditions } : {}),
      ...(saved.prUrl ? { prUrl: saved.prUrl } : {}), ...(saved.patches.length ? { patches: saved.patches } : {}),
      worktree, ...(saved.adopted ? { resumed: true } : {}), worktreeCreated: saved.created, worktreeRemoved: saved.removed, reviewNotes: saved.reviewNotes,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const reasonBrief = flat(reason).replace(/^(.{600}).+$/u, "$1…").replace(/[^.!?…]$/u, "$&.");
    saved.held = { action: "hold", summary: [
      { delivered: `Delivered ${result}.`, refused: `Refused: ${reasonBrief}`, "handed-off": `Handed off: ${summaryReason(reason, asking(reason))}`, abandoned: `Abandoned: ${reasonBrief}` }[outcome],
      ...(finished && saved.taken ? [saved.redelivered ? "The base has not moved, so the same commit was delivered again unchanged."
        : `The delivered commit ${saved.taken} was replayed onto the new base ${saved.baseCommit}.`] : []),
      ...(finished && saved.lease ? [saved.pushed ? `The same pull request ${saved.prUrl} was updated in place.`
        : `The same pull request ${saved.prUrl} was left as it was; nothing was pushed.`] : []),
      ...(saved.decision ? [`Decision: ${saved.decision}.`] : []),
      ...(outcome === "abandoned" ? [`Worktree and ${saved.branch} removed without saving the candidate.`] : []),
      ...(outcome === "handed-off" ? [`Branch: ${saved.branch}.`] : []),
      ...((saved.created || saved.adopted) && !saved.removed ? [`Worktree kept at ${worktree}${finished ? `; it could not be removed: inspect ${directory}/git-worktree.log.` : "."}`] : []),
      `Evidence: ${directory}`,
    ].join(" ") };
    if (finished && repository.output === "branch" && saved.scopeAdditions.length) {
      const summary = join(directory, "branch-summary.md");
      writeFileSync(summary, [ticket.title, saved.held.summary, ...scopeAdditionSection()].join("\n\n") + "\n", { mode: 0o600 });
      saved.held.summary = saved.held.summary.replace(`Evidence: ${directory}`, `Summary: ${summary}. Evidence: ${directory}`);
    }
    publishHandoff({ delivered: "Delivered the checked changes.", refused: "Refused the ticket.", "handed-off": "Handed off the ticket.", abandoned: "Abandoned the ticket." }[outcome], reason);
    return { type: outcome === "handed-off" ? "handedOff" : outcome === "delivered" && !saved.removed ? "kept" : outcome };
  }

  function reportFault(stage: string, result: { type: "sendBack" | "invalid"; fault: string; path: string }): Event {
    if (result.type === "sendBack") {
      taskStatus(p.status, { note: `The ${stage} report was sent back with its validation fault.` }, saved.handoff);
      return { type: "reask" };
    }
    return work.block(`The ${stage} report was malformed twice: ${result.fault}. The report is kept in ${result.path}.`);
  }
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
    const event = saved.planningReport;
    const allowance = { returned: saved.questionsReturned, feedback: saved.questionsFault };
    const result = work.sendBack("falsify", event, () => {
      if ("refusal" in kept) throw new Error(kept.refusal);
      const fault = event.type === "sound" ? undefined : questionField(event.questions);
      if (fault) throw new Error(fault);
      return event;
    }, allowance);
    saved.questionsReturned = allowance.returned;
    saved.questionsFault = allowance.feedback;
    if (result.type === "sendBack") return reportFault("falsify", result);
    if (result.type === "invalid") return work.block("refusal" in kept ? result.fault
      : `The falsify report was malformed twice: ${result.fault}. The report is kept in ${join(work.open(), `falsify-${saved.planningReports.falsify}.json`)}.`);
    if (event.type === "sound") {
      saved.questionsFault = "";
      work.block("");
      return { type: "sound" };
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
  function planningShape(stage: PlanningStage, kept: { summary: string } | { refusal: string }) {
    const result = work.sendBack(stage, saved.planningReport, () => {
      if ("refusal" in kept) throw new Error(kept.refusal);
      return kept.summary;
    });
    if (result.type === "valid") work.resetReport(stage);
    return result;
  }
  function planResult(): Event {
    const kept = keep("plan");
    if (work.unchanged().type === "changed") return { type: "blocked" };
    const result = planningShape("plan", kept);
    if (result.type !== "valid") return reportFault("plan", result);
    saved.plan = result.report;
    return { type: "planned" };
  }
  function planReviewResult(): Event {
    saved.planRejectedAgain = false;
    const kept = keep("planReview");
    if (work.unchanged().type === "changed") return { type: "blocked" };
    const result = planningShape("planReview", kept);
    if (result.type !== "valid") return reportFault("planReview", result);
    if (saved.planningReport.type === "approved") {
      saved.repairing = "change";
      work.block("");
      return { type: "approved" };
    }
    if (saved.planningReport.type === "tooBroad") {
      saved.repairing = "plan";
      return work.block(`Plan review found the ticket too broad for one run. Suggested split:\n${result.report}`);
    }
    if (saved.planRevisions++ === 0) return { type: "revise" };
    saved.repairing = "plan";
    saved.planRejectedAgain = true;
    return work.block(result.report);
  }
  const recordReview = ({ event }: { event: Event }) => {
    saved.reviewSummaryFault = "";
    try { saved.reviewSummary = work.capture("review", event); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Agent review must return a non-empty summary")) throw error;
      saved.reviewSummary = "";
      saved.reviewSummaryFault = error.message;
    }
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
  function validateReview(event: Event): Event {
    recordReview({ event });
    // Keep the helper's read-only guard, but judge the report here instead of trusting its event type.
    if (work.unchanged().type === "changed") return stopAt("review");
    const result = work.sendBack("review", event, () => {
      if (saved.reviewSummaryFault) throw new Error(saved.reviewSummaryFault);
      const fault = event.type === "blocked" ? undefined : reviewField(event, ticket.sections.acceptance);
      if (fault) throw new Error(fault);
      return event as ReviewReport;
    });
    if (result.type !== "valid") saved.malformedReviews.push(saved.reviews.length - 1);
    if (result.type === "sendBack") return reportFault("review", result);
    if (result.type === "valid") work.resetReport("review");
    if (result.type === "invalid") { saved.standingReview = reviewFeedback(event); reportFault("review", result); return stopAt("review"); }
    return { type: "valid" };
  }
  function reviewFeedback(event: Event): string {
    // Even a malformed report can contain useful findings. Keep them apart from the Machine's stop reason.
    return [
      saved.reviewSummary,
      ...(Array.isArray(event.criteria) ? event.criteria.flatMap((criterion, index) => criterion?.met === false && ticket.sections.acceptance[index]
        ? [`Unmet criterion: ${ticket.sections.acceptance[index]}${typeof criterion.evidence === "string" ? ` (${criterion.evidence})` : ""}`] : []) : []),
      ...(Array.isArray(event.findings) ? event.findings.flatMap(finding => (finding?.severity === "blocker" || finding?.severity === "discussion") && typeof finding.text === "string"
        ? [`${finding.severity === "blocker" ? "Blocker" : "Discussion"}: ${finding.text}${typeof finding.where === "string" ? ` (${finding.where})` : ""}`] : []) : []),
    ].join("\n");
  }
  function reviewResult(): Event {
    if (work.unchanged().type === "changed") return { type: "blocked" };
    const event = saved.reviews.at(-1)!;
    if (event.type === "blocked") return work.block(saved.reviewSummary);
    const feedback = reviewFeedback(event);
    const stop = (reason: string) => { saved.standingReview = feedback; return work.block(reason); };
    const report = event as ReviewReport;
    const unmet = report.criteria.flatMap((criterion, index) => criterion.met ? [] : [ticket.sections.acceptance[index]!]);
    const blockers = report.findings.filter(finding => finding.severity === "blocker");
    const discussions = report.findings.filter(finding => finding.severity === "discussion");
    const previous = saved.reviews.slice(saved.reviewsFrom, -1).findLast((_report, index) =>
      !saved.malformedReviews.includes(saved.reviewsFrom + index));
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
  function fixable(event: Event | undefined): event is ReviewReport {
    if (!event || event.type !== "revise" || reviewField(event, ticket.sections.acceptance)) return false;
    const { findings } = event as ReviewReport;
    return findings.some(finding => finding.severity === "blocker")
      && !findings.some(finding => finding.severity === "discussion")
      && findings.every(finding => {
        const path = finding.where.replace(/^\.\//u, "").replace(/:\d+(-\d+)?$/u, "");
        return !!path.trim() && outsideEffectiveScope([path]).length === 0;
      });
  }
  function reviewBudget(): Event {
    const { reviewRounds, maxReviewRounds } = work.status();
    // The helper's spent counter stays intact; only this extra review budget restarts, never repairs.
    if (saved.extraRound === "running") {
      if (saved.extraReviewRounds < maxReviewRounds) {
        saved.extraReviewRounds++;
        return { type: "retry" };
      }
    } else if (saved.extraRound === "unused" && reviewRounds >= maxReviewRounds) {
      const last = saved.reviews.at(-1);
      if (fixable(last)) {
        saved.extraRound = "running";
        saved.extraRoundFrom = saved.reviews.length;
        saved.extraFeedback = last.findings.filter(finding => finding.severity === "blocker")
          .map(finding => `Blocker: ${finding.text} (${finding.where})`);
        return { type: "retry" };
      }
    }
    return work.reviewRound();
  }
  /** Git failures retain their evidence; the containing Operation chooses the origin. */
  function stepFailure(step: "setup" | "commit" | "rebase" | "deliver", reason?: string, type = "failed"): Event {
    if (reason !== undefined) work.block(reason);
    return { type: step === "rebase" ? "handBack" : type };
  }

  const resumeFile = () => join(git(worktree, "rev-parse", "--absolute-git-dir"), "ticket-task-resume.json");
  const destination = (answer = ""): Origin => {
    if (saved.pendingScope && scopeDecisionOf(answer) === "include") return saved.pendingScope.stage;
    switch (saved.origin) {
      case "falsify": return /scope\s+(?:has\s+)?chang(?:e|ed|es|ing)/iu.test(answer) ? "falsify" : saved.ownerQuestions ? "plan" : "falsify";
      case "planReview": return "plan";
      case "red": case "test": return "test";
      case "gate": case "judge": case "review": case "implement": return "implement";
      case "commit": return "gate";
      case "deliver": return "rebase";
      default: return saved.origin;
    }
  };
  function rememberStop(origin = saved.pendingScope?.stage ?? (saved.origin === "falsify" && saved.ownerQuestions ? "falsify" : destination())) {
    if (!(saved.created || saved.adopted) || saved.removed || !existsSync(worktree)) return;
    // A destination is only valid after the owner answers. A separate run must
    // recover unanswered questions, not mistake a hand-off for that answer.
    const pendingFalsify = saved.origin === "falsify" && saved.ownerQuestions ? [
      ...saved.ownerQuestions.map(({ text, options, recommended, why }) => ({ text, options, recommended, why, assumable: false })),
      ...saved.wouldAssume,
    ] : undefined;
    writeFileSync(resumeFile(), JSON.stringify({ ticket: ticket.id, branch: saved.branch, origin,
      pendingScope: saved.pendingScope, pendingFalsify, answers: saved.answers, plan: saved.plan, reason: work.status().reason, evidence: work.open() }) + "\n", { mode: 0o600 });
  }
  function stopAt(origin: Origin): Event {
    releaseTurn();
    saved.origin = origin; saved.stoppedIn = origin;
    writeFileSync(join(work.open(), `question-${++saved.questions}.txt`), stuckPrompt() + "\n", { flag: "wx", mode: 0o600 });
    rememberStop();
    return { type: "stuck" };
  }
  function continueWork({ event }: { event: Event }) {
    const reply = work.choice("stuck", event);
    const next = destination(reply);
    saved.decision = (saved.pendingScope ? scopeDecisionOf(reply) : decisionOf(reply)) ?? reply;
    saved.answers.push(reply);
    if (saved.pendingScope) {
      const miss = saved.pendingScope;
      if (scopeDecisionOf(reply) === "include") {
        for (const { path } of miss.files) if (!saved.scopeAdditions.some(item => item.path === path)) saved.scopeAdditions.push({ path, stage: miss.stage });
        saveScope();
        saved.pendingScope = null;
        work.block("");
        rememberStop(next);
        return;
      }
      if (scopeDecisionOf(reply) === "revert") {
        // The owner authorizes this one pass even when the automatic repair budget is zero or spent.
        saved.task.repairs++;
        work.block(`Revert ${miss.files.map(file => JSON.stringify(file.path)).join(", ")}: the ticket owner declined to include these paths in scope after ${miss.stage}.`);
      }
      saved.pendingScope = null;
      if (scopeDecisionOf(reply) === "revert") {
        work.resetReport(next === "test" ? "test" : "change");
        rememberStop(next);
        return;
      }
    }
    if (saved.origin === "falsify" && saved.ownerQuestions && destination(reply) === "plan") {
      saved.assumptions = saved.ownerQuestions.map(question => ({ question: question.text, answer: reply,
        options: [...new Set([...(question.options ?? []), reply])], why: "The ticket owner supplied this answer." }));
      saved.assumptionsJson = JSON.stringify(saved.assumptions, null, 2) + "\n";
      writeFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), "ticket-task-assumptions.json"), saved.assumptionsJson, { mode: 0o600 });
      writeFileSync(join(work.open(), "assumptions.json"), saved.assumptionsJson, { mode: 0o600 });
    }
    work.renew();
    for (const stage of ["plan", "planReview", "test", "change", "review"]) work.resetReport(stage);
    if (saved.extraRound === "running") saved.extraRound = "used";
    saved.ownerQuestions = null; saved.wouldAssume = [];
    if (saved.standingReview !== null) work.block(saved.standingReview);
    saved.standingReview = null;
    if (["rebase", "deliver"].includes(saved.origin)) saved.recheckBase = true;
    rememberStop(next);
  }
  function endDecision({ event }: { event: Event }) {
    saved.decision = decisionOf(work.choice("stuck", event))!;
    if (saved.decision === "discard") { saved.discardConfirmed = true; remove(); conclude("abandoned"); }
    else { rememberStop(); conclude("handed-off"); }
  }

  /** Validation and its single send-back belong to the Agent state, before it can leave. */
  function checkedAgent(instruction: () => string, outcomes: readonly string[], using: string,
    validate: (event: Event) => Event, routes: Record<string, string>) {
    const on = Object.fromEntries(outcomes.map(outcome => [outcome, { actions: ({ event }: { event: Event }) => {
      saved.agentRoute = validate(event).type;
    } }]));
    const state = agent(instruction, on, { using, cwd: worktree });
    return { ...state, always: Object.entries(routes).map(([outcome, target]) => ({
      guard: () => saved.agentRoute === outcome, target, reenter: true,
      actions: () => { saved.agentRoute = ""; },
    })) };
  }
  function planning(stage: PlanningStage, event: Event, validate: () => Event): Event {
    saved.planningReport = event;
    const result = stopped(stage, validate)();
    return result.type === "blocked" ? stopAt(stage) : result;
  }
  function editing(stage: "test" | "change", event: Event): Event {
    work.receive(event);
    const result = work.reported(stage, result => reportFault(stage, result));
    if (result.type === "completed") passed(stage);
    return result.type === "blocked" ? stopAt(stage === "change" ? "implement" : "test") : result;
  }
  function prepareRun(): Event {
    if (shape().type === "blocked") return conclude("refused");
    const result = saved.created || saved.adopted ? { type: "created" } : prepare();
    if (result.type === "blocked") return conclude("refused");
    if (result.type === "redeliver") return { type: "rebase" };
    if (result.type === "stuck") return stopAt("prepare");
    if (result.type === "created" && setup().type !== "prepared") return stopAt("prepare");
    if (resume && saved.adopted && existsSync(resumeFile())) {
      const record = JSON.parse(readFileSync(resumeFile(), "utf8"));
      const origins: Origin[] = ["prepare", "falsify", "plan", "planReview", "test", "red", "implement", "gate", "rebase"];
      if (record.ticket !== ticket.id || record.branch !== saved.branch || !origins.includes(record.origin)
        || !Array.isArray(record.answers) || record.answers.some((answer: unknown) => typeof answer !== "string")
        || (record.pendingScope != null && (!scopeMiss(record.pendingScope) || record.pendingScope.stage !== record.origin))
        || typeof record.plan !== "string" || typeof record.reason !== "string" || typeof record.evidence !== "string"
        || (record.pendingFalsify !== undefined && (record.origin !== "falsify" || questionField(record.pendingFalsify)
          || !record.pendingFalsify.some((question: FalsifyQuestion) => !question.assumable)))) {
        work.block(`Cannot resume: invalid saved origin in ${resumeFile()}; nothing was changed.`);
        return conclude("refused");
      }
      saved.answers = record.answers; saved.plan = record.plan; saved.previousEvidence = record.evidence; work.block(record.reason);
      if (record.pendingScope) {
        saved.pendingScope = record.pendingScope;
        work.seal();
        return stopAt(record.pendingScope.stage);
      }
      if (record.pendingFalsify) {
        const questions = record.pendingFalsify as FalsifyQuestion[];
        saved.ownerQuestions = questions.filter(question => !question.assumable)
          .map(({ text, options, recommended, why }) => ({ text, where: "", options, recommended, why }));
        saved.wouldAssume = questions.filter(question => question.assumable);
        work.seal();
        return stopAt("falsify");
      }
      if (result.type === "conflicted") return { type: "implement" };
      if (record.origin === "prepare" && setup().type !== "prepared") return stopAt("prepare");
      work.seal();
      return { type: record.origin === "prepare" ? "falsify" : record.origin };
    }
    if (result.type === "conflicted") return { type: "implement" };
    if (result.type === "resumed") return { type: "gate" };
    work.start();
    return { type: "falsify" };
  }
  function gate(): Event {
    saved.repairing = "change";
    const scopeResult = unsettled() ?? scope("change");
    if (scopeResult.type === "scopeMiss") return stopAt("gate");
    const result = scopeResult.type === "passed" ? work.checks() : scopeResult;
    if (result.type === "passed") { passed("verify"); work.seal(); return { type: "passed" }; }
    return work.repair().type === "retry" ? { type: "retry" } : stopAt("gate");
  }
  function replay(): Event {
    // Publishing makes the commit immutable: retry PR creation or recording on
    // that same commit, even if the base advanced while the owner was away.
    // A failed gate must keep it too; undo/rebase would require a force push.
    if (saved.pushed) {
      if (git(worktree, "rev-parse", "HEAD") !== saved.commitHash || pending() !== "") {
        work.block("The published candidate changed locally; restore the pushed commit and clean worktree before continuing delivery.");
        return stopAt("rebase");
      }
      if (work.checks("reverify").type !== "passed") return stopAt("rebase");
      saved.recheckBase = false;
      return { type: "deliver" };
    }
    // A conflict or failed setup left an uncommitted candidate. It must pass the normal checks and review again.
    if (!saved.commitHash) return { type: "implement" };
    const result = rebase();
    if (["current", "rebased"].includes(result.type)) {
      // A successful replay already ran every gate. An unchanged base still needs fresh gates after an owner answer.
      if (saved.recheckBase && result.type === "current") {
        if (work.checks("reverify").type !== "passed") { undo(saved.baseCommit); return stopAt("rebase"); }
      }
      saved.recheckBase = false;
      return { type: "deliver" };
    }
    if (result.type === "review" || result.type === "resumed") return { type: "gate" };
    // The moved candidate waits uncommitted on the tip with its conflicts; settling them is one repair round, then gates and review run again.
    if (result.type === "conflicted") return work.repair().type === "retry" ? { type: "implement" } : stopAt("rebase");
    if (result.type === "blocked") return conclude("refused");
    if (result.type === "failed" && work.repair().type === "retry") return { type: "implement" };
    return stopAt("rebase");
  }
  const definition = {
    entry: ({ self }) => { self.subscribe({ error: stopTurn }); },
    // An invoked lifecycle actor also starts on checkpoint continuation, when entry actions do not.
    invoke: { src: {
      getInitialSnapshot: () => ({ status: "active" as const, output: undefined, error: undefined }),
      transition: snapshot => snapshot,
      getPersistedSnapshot: snapshot => snapshot,
      restoreSnapshot: () => ({ status: "active" as const, output: undefined, error: undefined }),
      start: (_snapshot, { self }) => { self.subscribe({ complete: stopTurn, error: stopTurn }); },
    } },
    initial: "prepare", output: ({ event }) => {
      // The done-state event names the final state; keep the declared ending untouched.
      const ending = event.type.slice(event.type.lastIndexOf(".") + 1) as keyof typeof endings;
      publishState(ending);
      return saved.held ?? undefined;
    },
    states: {
      prepare: operation(prepareRun, { falsify: "falsify", plan: "plan", planReview: "planReview", test: "test", red: "red", implement: "implement", gate: "gate", rebase: "rebase", stuck: "stuck", refused: "refused" }),
      falsify: checkedAgent(() => prompt([
        "Try to falsify this ticket before anyone implements it: look for evidence that it is wrong, already done, impossible in this repository, or underspecified. Do not edit any file. Read the relevant code and check the request, scope, and acceptance criteria. Return sound with a one-paragraph summary if the ticket survives, or questions with a questions array of 1–10 entries shaped as { text, options: string[], recommended: string, assumable: boolean, why }, giving the exact questions a person could answer. text and why must be non-empty strings; options must be a non-empty array of non-empty strings; recommended must copy one of those options exactly. Mark assumable true only when the recommended answer is what a careful maintainer of this repository would do without asking, and a wrong guess costs at most a review comment: for example naming, placement within the Scope, the shape of a test, which existing helper to reuse, the wording of documentation, or where in the Scope a new file goes. A product decision, a change to behaviour a user sees, a path outside the Scope and companions, or anything irreversible such as deleting, publishing, migrating data, or changing a protocol is never assumable. You mark the assumable flag; the workflow decides what to do with it. A path covered by a companion is already in scope and is never a question.",
        ...scopePrompt(),
        ...(saved.questionsFault ? [saved.questionsFault] : []),
        "Put the questions in the report's questions field, not in the summary or message.",
      ].join("\n")), ["sound", "questions"], "investigator", event => planning("falsify", event, falsifyResult), { sound: "plan", assumed: "plan", reask: "falsify", stuck: "stuck" }),
      plan: checkedAgent(() => prompt([
        "Plan the implementation of this sound ticket. Do not edit any file. Cover the acceptance criteria, tests, permitted paths, and required checks. Address any plan review feedback in the stage reports. Return planned with the complete plan as the summary. Keep it concise: name the files and the tests, and do not restate the ticket.",
        ...scopePrompt(),
        ...assumptionsPrompt(),
      ].join("\n"), "plan"), ["planned"], "investigator", event => planning("plan", event, planResult), { planned: "planReview", reask: "plan", stuck: "stuck" }),
      planReview: checkedAgent(() => prompt([
        "Review the plan against the ticket, relevant code, scope, acceptance criteria, and tests. Do not edit any file. Return approved with a summary if it is ready to implement, or revise with a summary of what must change. Prefer concise plans: send back as revise a plan that restates the ticket or carries detail the implementer does not need. Return tooBroad if the ticket is too broad for one run, with a summary suggesting a split into smaller tickets, one per line. Only one revision of the plan is allowed.",
        ...scopePrompt(),
        ...assumptionsPrompt(),
        "Plan:", saved.plan,
      ].join("\n"), "planReview"), ["approved", "revise", "tooBroad"], "reviewer", event => planning("planReview", event, planReviewResult), { approved: redGreen ? "test" : "implement", revise: "plan", reask: "planReview", stuck: "stuck" }),
      test: checkedAgent(() => {
        saved.repairing = "test";
        return prompt([
          "Write only tests that encode the acceptance criteria below, one or more per criterion, inside the Scope paths below. Do not implement anything and do not change non-test files. The tests must fail now and pass once the ticket is implemented. Leave changes uncommitted.",
          ...assumptionsPrompt(),
          ...(saved.plan ? ["Plan:", saved.plan] : []),
          "Acceptance criteria:", ...ticket.sections.acceptance.map(text => `- ${text}`),
          ...scopePrompt(),
          cannotRun,
        ].join("\n"), "test");
      }, ["completed", "blocked"], "tester", event => editing("test", event), { completed: "red", reask: "test", stuck: "stuck" }),
      implement: checkedAgent(() => {
        saved.repairing = "change";
        return prompt([
          "Implement the ticket and its tests. Keep the change focused. Do not weaken checks or expand scope. Leave your changes uncommitted; the workflow commits and delivers them.",
          ...(saved.extraRound !== "unused" ? ["Blockers the reviewer found when the review budget was spent; fix each and add the regression test it asked for:", ...saved.extraFeedback] : []),
          ...movedPrompt(),
          ...(saved.moved?.conflicts.length ? [
            `Settle conflicts in ${saved.moved.conflicts.map(path => JSON.stringify(path)).join(", ")}, keeping both sides' intent. Both sides are in ${join(work.open(), "resume-conflicts.diff")}. Remove every conflict marker; do not commit; the workflow stages settled files.`,
            ...markerlessPrompt(),
          ] : []),
          ...assumptionsPrompt(),
          ...(saved.plan ? ["Plan:", saved.plan] : []),
          ...(redGreen ? ["The tester's tests in the stage reports are the contract; make them pass without weakening or deleting them. If a test is wrong, say so in the summary rather than changing its intent."] : []),
          "Acceptance criteria:", ...ticket.sections.acceptance.map(text => `- ${text}`),
          ...scopePrompt("Scope (the only paths you may change; the workflow checks them):"),
          "Forbidden:", ...ticket.sections.forbidden.map(text => `- ${text}`),
          "Resolve discussion findings or explain why they need the ticket owner in your summary.",
          cannotRun,
        ].join("\n"), "change");
      }, ["completed", "blocked"], "implementer", event => editing("change", event), { completed: "gate", reask: "implement", stuck: "stuck" }),
      review: checkedAgent(() => prompt([
        "Review the current diff and verification evidence. Do not edit any file. Check acceptance criteria, regressions, scope, and whether tests actually establish the intended behavior.",
        ...scopePrompt(),
        ...movedPrompt(),
        ...assumptionsPrompt(),
        ...(saved.assumptions.length ? ["An assumption you disagree with is a discussion finding for the ticket owner."] : []),
        ...(saved.provedRed ? ["The tests were written before the implementation and the Machine saw them fail; check that the implementation makes them pass for the right reason and that no test was weakened."] : []),
        "Acceptance criteria:", ...ticket.sections.acceptance.map((text, index) => `${index + 1}. ${text}`),
        "Return one criteria entry per acceptance criterion, in order, with its text exactly as given, a boolean met, and evidence as a file:line or command.",
        "Tag findings: blocker = must change before delivery; discussion = a question only the ticket owner can settle; minor = worth noting, not worth a round.",
        "On a second or later review, say what is new versus the previous report in newSinceLastRound, or none if nothing is new. Read previous review-<n>.json reports alongside the stage reports in the evidence directory.",
        "For blocked, only the summary is required. For approved or revise, include the full structured report below.",
        'End with one line: MACHINES_EVENT {"type":"approved"|"revise"|"blocked","summary":"<one paragraph>","criteria":[{"text":"<criterion as given>","met":true|false,"evidence":"<file:line or command>"}],"findings":[{"severity":"blocker"|"discussion"|"minor","text":"<finding>","where":"<file:line>"}],"newSinceLastRound":"none"|"<what changed in this round\'s findings>"}',
      ].join("\n"), "review"), ["approved", "revise", "blocked"], "reviewer", validateReview, { valid: "judge", reask: "review", stuck: "stuck" }),
      red: operation(() => {
        saved.repairing = "test";
        const result = scope("test").type === "passed" ? work.redCheck(repository.redCheck) : { type: "failed" };
        saved.provedRed = result.type === "passed";
        if (saved.provedRed) { passed("red"); return result; }
        return stopAt("red");
      }, { passed: "implement", stuck: "stuck" }),
      gate: operation(gate, { passed: "review", retry: "implement", stuck: "stuck" }),
      judge: operation(() => {
        const result = reviewResult();
        if (result.type === "approved") { passed("review"); return result; }
        if (result.type === "revise" && reviewBudget().type === "retry") return { type: "retry" };
        return stopAt("judge");
      }, { approved: "commit", retry: "implement", stuck: "stuck" }),
      commit: operation(inTurn(() => {
        const result = commit();
        return result.type === "committed" ? result : stopAt("commit");
      }, ["committed"]), { committed: "rebase", stuck: "stuck" }),
      rebase: operation(inTurn(replay, ["deliver"]), { deliver: "deliver", implement: "implement", gate: "gate", stuck: "stuck", refused: "refused" }),
      deliver: operation(async () => {
        // A process restored directly at deliver no longer owns the turn that protected its replay.
        if (!turnHeld) {
          work.block("Delivery was interrupted; continue to check the current base and run every gate again before delivery.");
          return stopAt("deliver");
        }
        return inTurn(() => {
          const result = deliver();
          return result.type === "delivered" ? conclude("completed") : stopAt("deliver");
        }, [])();
      }, { delivered: "delivered", kept: "delivered", refused: "refused", stuck: "stuck" }),
      stuck: evidenceHuman((prompt, on, options) => {
        if (!saved.pendingScope) return human(prompt, on, options);
        // Adapt only this workflow's request; the shared helper retains its existing contract.
        const { recommended: _recommended, reason: _reason, present: _present, presentWith: _presentWith, presentIn: _presentIn, choices: _choices, discussion: _discussion, ...rest } = options ?? {};
        return human(prompt, on, { ...rest, suggestions: scopeDecisions });
      }, stuckPrompt, {
        submitted: [
          { guard: ({ event }: { event: Event }) => typeof event.value === "string" && !event.value.trim(), target: "stuck", reenter: true, actions: () => { stopAt(saved.origin); } },
          { guard: ({ event }: { event: Event }) => decisionOf(event.value) === "hand off", target: "handedOff", actions: endDecision },
          { guard: ({ event }: { event: Event }) => decisionOf(event.value) === "discard", target: "abandoned", actions: endDecision },
          ...(["prepare", "falsify", "plan", "planReview", "test", "red", "implement", "gate", "rebase"] as const).map(target => ({
            guard: ({ event }: { event: Event }) => destination(String(event.value)) === target, target, actions: continueWork,
          })),
        ],
      }, { present: "presenter", suggestions: decisions }, () => questionEvidence()),
      delivered: final(endings.delivered), refused: final(endings.refused), handedOff: final(endings.handedOff), abandoned: final(endings.abandoned),
    },
  } satisfies Parameters<typeof machine>[0];
  const states = definition.states;

  const deliveredMeaning = () => saved.prUrl
    ? `delivered as ${saved.lease && saved.pushed ? "updated " : ""}pull request #${/\/pull\/(\d+)/u.exec(saved.prUrl)?.[1] ?? saved.prUrl}`
    : `delivered as ${repository.output === "patch" ? "a patch" : "a branch"}`;
  const stuckMeaning = () => `stuck at ${saved.stoppedIn}, needs you`;
  const reviewMeaning = () => {
    const { reviewRounds, maxReviewRounds } = work.status();
    const round = saved.extraRound === "running" ? saved.extraReviewRounds : reviewRounds;
    return `under review, round ${round + 1} of ${maxReviewRounds + 1}${saved.extraRound === "running" ? " in the extra review budget" : ""}`;
  };
  const meanings = {
    prepare: "preparing the ticket worktree", falsify: "checking whether the ticket is sound",
    plan: "planning; the plan review is next", planReview: "reviewing the implementation plan",
    test: "writing the failing tests", red: "checking that the new tests fail",
    implement: "implementing; gates not yet run", gate: () => `running ${repository.checks.join(", ")}`,
    review: reviewMeaning, judge: "checking the review findings", stuck: stuckMeaning,
    commit: "committing the checked changes", rebase: "checking the current base and replaying changes",
    deliver: "delivering the checked changes", delivered: deliveredMeaning,
    refused: "refused; see the recorded reason", handedOff: "handed off; work kept", abandoned: "abandoned",
  } satisfies Record<keyof typeof states, string | (() => string)>;
  function publishState(name: keyof typeof states) {
    const meaning = meanings[name];
    setNow(typeof meaning === "function" ? meaning() : meaning);
  }
  // Invocation input is also evaluated on checkpoint continuation, unlike entry actions.
  // Only presentation is added: the original transitions, actors and endings stay intact.
  const reportingStates = Object.fromEntries(Object.entries(states).map(([name, state]) => {
    if (!("invoke" in state)) return [name, state];
    const input = "input" in state.invoke ? state.invoke.input : undefined;
    return [name, { ...state, invoke: { ...state.invoke, input: () => {
      publishState(name as keyof typeof states);
      return typeof input === "function" ? input() : input;
    } } }];
  })) as typeof states;
  return machine({ ...definition, states: reportingStates });
}

type ScopeAddition = { path: string; stage: "red" | "gate" };
type ScopeMiss = { stage: "red" | "gate"; files: { path: string; added: number | null; removed: number | null }[] };
const literalPath = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && !value.includes("\0") && !isAbsolute(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
const scopeStage = (value: unknown) => value === "red" || value === "gate";
const recordValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const scopeAddition = (value: unknown): value is ScopeAddition => recordValue(value) && literalPath(value.path) && scopeStage(value.stage);
const scopeMiss = (value: unknown): value is ScopeMiss => recordValue(value) && scopeStage(value.stage)
  && Array.isArray(value.files) && value.files.length > 0 && value.files.every(file => recordValue(file) && literalPath(file.path)
    && [file.added, file.removed].every(count => count === null || (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)));

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

  const repo = object(data.repository, "repository", ["name", "path", "base", "setup", "checks", "rerunFailedChecks", "output", "remote", "draft", "redCheck", "companions"]);
  if (repo.companions !== undefined && !Array.isArray(repo.companions)) throw new Error("repository.companions must be an array of non-empty strings");
  const companions = ((repo.companions ?? []) as unknown[]).map((entry, i) => text(entry, `repository.companions[${i}]`));
  if (repo.rerunFailedChecks !== undefined && typeof repo.rerunFailedChecks !== "boolean") throw new Error("repository.rerunFailedChecks must be a boolean");
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
    rerunFailedChecks: repo.rerunFailedChecks,
  }, { checks: true, git: "clean", evidenceRoot }, saved);
  const checks = (repo.checks as { name: string }[]).map(c => c.name);
  if (redGreen && !checks.includes(redCheck)) throw new Error(`repository.redCheck names missing check: ${redCheck}`);
  const prefix = `ticket/${slug}`;
  const titled = titleSlug(title);
  return {
    ticket: { id, slug, title, summary: firstParagraph(ticket.body ?? ""), sections: ticketSections(ticket.body ?? "") }, prefix, branch: titled ? `${prefix}-${titled}` : prefix,
    worktree, evidenceRoot, work, resume: data.resume === true, redGreen, assume: data.assume === true, stuck,
    repository: { name, path, base, setup, output, remote, draft: repo.draft !== false, redCheck, checks, companions },
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
