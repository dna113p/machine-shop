import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MachinePrimitives } from "../machines/src/index.ts";

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
  const worktreeDirectory = join(tmpdir(), `dev-machines-${id}`);
  const worktreeBranch = `dev-machines/${id}`;
  let baseCommit = "";
  let sourceBranch = "";
  let feedback = "";

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
          console.log(`Created ${worktreeDirectory} from ${baseCommit}.`);
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
        ].join("\n"),
        { reviewed: "humanReview" },
        { cwd: worktreeDirectory },
      ),

      humanReview: human(
        [
          `Review the implementation in ${worktreeDirectory}.`,
          'Enter "approve" to merge it, or enter feedback for another Agent revision.',
        ].join("\n"),
        {
          submitted: [
            {
              guard: ({ event }) => response(event).trim().toLowerCase() === "approve",
              target: "merge",
            },
            {
              actions: ({ event }) => {
                feedback = response(event);
              },
              target: "revise",
            },
          ],
        },
        { suggestions: ["approve"] },
      ),

      revise: agent(
        () => [
          `Continue this task: ${task}`,
          "Address this human feedback:",
          feedback,
          "Run the relevant checks, commit all changes, and leave the worktree clean.",
        ].join("\n"),
        { completed: "humanReview" },
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
          console.log(`Merged ${worktreeBranch} into ${sourceBranch}.`);
          return { type: "merged" };
        },
        { merged: "cleanup" },
      ),

      cleanup: operation(
        () => {
          git(sourceDirectory, "worktree", "remove", worktreeDirectory);
          git(sourceDirectory, "branch", "-d", worktreeBranch);
          console.log(`Removed ${worktreeDirectory}.`);
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
