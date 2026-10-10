import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Implements in an isolated worktree, reviews the result, then asks before merging.";

export default function worktreeTask(
  { agent, final, human, machine, operation }: MachinePrimitives,
  input: string,
) {
  const task = input.trim();
  if (task === "") {
    throw new Error("worktree-task requires a task description");
  }

  const id = randomUUID();
  const sourceDirectory = process.cwd();
  const worktreeDirectory = join(tmpdir(), `machine-shop-${id}`);
  const worktreeBranch = `machine-shop/${id}`;
  let baseCommit = "";
  let sourceBranch = "";
  let feedback = "";
  let reviewDetails = "No review details were returned.";
  let reviewSummary = "Review completed.";
  let showReviewDetails = false;
  let revisions = 0;

  return machine({
    initial: "createWorktree",
    states: {
      createWorktree: operation(
        () => {
          requireClean(sourceDirectory, "source checkout");
          sourceBranch = git(sourceDirectory, "symbolic-ref", "--quiet", "--short", "HEAD");
          baseCommit = git(sourceDirectory, "rev-parse", "HEAD");
          git(
            sourceDirectory,
            "worktree",
            "add",
            "-b",
            worktreeBranch,
            worktreeDirectory,
            baseCommit,
          );
          announce(
            `↳ worktree ${worktreeDirectory} · ${baseCommit.slice(0, 7)}`,
            `Created ${worktreeDirectory} from ${baseCommit}.`,
          );
          return { type: "created" };
        },
        { created: "implement" },
      ),

      implement: agent(
        [
          `Implement this task: ${task}`,
          "Work only in the current worktree.",
          "Run the relevant checks, commit all changes, and leave the worktree clean.",
        ].join("\n"),
        { completed: "review" },
        { cwd: worktreeDirectory },
      ),

      review: agent(
        () => [
          `Review the implementation of this task: ${task}`,
          `Inspect the committed changes since ${baseCommit}.`,
          "Do not modify the worktree. Report concrete issues and finish with the reviewed outcome.",
          'Include a short summary in the outcome, for example: MACHINES_EVENT {"type":"reviewed","summary":"4 P2 and 2 P3 findings"}',
        ].join("\n"),
        {
          reviewed: {
            actions: ({ event }) => {
              reviewDetails = eventText(event, "message")
                ?? "No review details were returned.";
              reviewSummary = eventText(event, "summary")
                ?? "Review completed; use details to inspect the report.";
              showReviewDetails = false;
            },
            target: "humanReview",
          },
        },
        { cwd: worktreeDirectory },
      ),

      humanReview: human(
        () => [
          "Review needed.",
          `Automated review${revisions === 0 ? "" : " (before revision)"}: ${reviewSummary}`,
          `Worktree: ${worktreeDirectory}`,
          ...(showReviewDetails
            ? ["", "Automated review report:", reviewDetails]
            : []),
          'Enter "details" to show the report, "approve" to merge, or type revision feedback.',
        ].join("\n"),
        {
          submitted: [
            {
              guard: ({ event }) => response(event).trim().toLowerCase() === "approve",
              target: "merge",
            },
            {
              guard: ({ event }) => response(event).trim().toLowerCase() === "details",
              target: "showReview",
            },
            {
              actions: ({ event }) => {
                feedback = response(event);
                showReviewDetails = false;
              },
              target: "revise",
            },
          ],
        },
        { suggestions: ["approve", "details"] },
      ),

      showReview: operation(
        () => {
          showReviewDetails = true;
          return { type: "shown" };
        },
        { shown: "humanReview" },
      ),

      revise: agent(
        () => [
          `Continue this task: ${task}`,
          "Address this human feedback:",
          feedback,
          "Run the relevant checks, commit all changes, and leave the worktree clean.",
        ].join("\n"),
        {
          completed: {
            actions: () => {
              revisions += 1;
            },
            target: "humanReview",
          },
        },
        { cwd: worktreeDirectory },
      ),

      merge: operation(
        () => {
          requireClean(sourceDirectory, "source checkout");
          requireClean(worktreeDirectory, "worktree");
          const currentBranch = git(
            sourceDirectory,
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD",
          );
          if (currentBranch !== sourceBranch) {
            throw new Error(
              `Source checkout moved from branch "${sourceBranch}" to "${currentBranch}"`,
            );
          }
          git(sourceDirectory, "merge", "--ff-only", worktreeBranch);
          announce(
            `↳ merged ${worktreeBranch} → ${sourceBranch}`,
            `Merged ${worktreeBranch} into ${sourceBranch}.`,
          );
          return { type: "merged" };
        },
        { merged: "cleanup" },
      ),

      cleanup: operation(
        () => {
          git(sourceDirectory, "worktree", "remove", worktreeDirectory);
          git(sourceDirectory, "branch", "-d", worktreeBranch);
          announce(
            `↳ removed ${worktreeDirectory}`,
            `Removed ${worktreeDirectory}.`,
          );
          return { type: "cleaned" };
        },
        { cleaned: "done" },
      ),

      done: final(),
    },
  });
}

function requireClean(directory: string, name: string): void {
  if (git(directory, "status", "--porcelain") !== "") {
    throw new Error(`${name} must be clean`);
  }
}

function git(directory: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    const detail = commandErrorDetail(cause);
    throw new Error(
      `git ${args.join(" ")} failed in ${directory}${detail === "" ? "" : `: ${detail}`}`,
      { cause },
    );
  }
}

function commandErrorDetail(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "stderr" in cause) {
    return String(cause.stderr).trim();
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function response(event: unknown): string {
  if (
    event !== null
    && typeof event === "object"
    && "value" in event
    && typeof event.value === "string"
  ) {
    return event.value;
  }
  throw new Error("Human review returned invalid input");
}

function eventText(event: unknown, key: string): string | undefined {
  if (event === null || typeof event !== "object") return undefined;

  const value = (event as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function announce(interactive: string, plain: string): void {
  console.log(process.stdout.isTTY ? `  ${interactive}` : plain);
}
