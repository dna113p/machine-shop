import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const fakeRun = resolve("tests/fixtures/fake-worktree-run.ts");
const humanPrompt = "Suggestions:\n- approve\n- details\n> ";
const humanPromptTimeoutMs = 10_000;

test("the worktree Machine implements, reviews, merges, cleans up, and finishes", () => {
  const repository = createRepository();

  try {
    const result = spawnSync(process.execPath, [fakeRun], {
      cwd: repository,
      encoding: "utf8",
      input: "approve\n",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(repository, "result.txt"), "utf8"), "implemented\n");
    assert.equal(git(repository, "branch", "--format=%(refname:short)"), "main");
    assert.equal(worktreeCount(repository), 1);
    assert.match(result.stdout, /Agent runs: 2/u);
    assert.match(result.stdout, /1 P2 finding/u);
    assert.doesNotMatch(result.stdout, /Fake review detail/u);
    assert.match(result.stdout, /--> done/u);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("review details are shown only when requested", async () => {
  const repository = createRepository();
  const child = spawn(process.execPath, [fakeRun], {
    cwd: repository,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (status) => resolveExit(status));
  });

  try {
    await waitForHumanPrompt(child.stdout, () => stdout, exited, 1);
    child.stdin.write("details\n");
    await waitForHumanPrompt(child.stdout, () => stdout, exited, 2);
    child.stdin.end("approve\n");

    assert.equal(await exited, 0, stderr);
    assert.match(stdout, /Fake review detail for the implementation/u);
    assert.equal(outputCount(stdout, humanPrompt), 2);
    assert.match(stdout, /Agent runs: 2/u);
    assert.match(stdout, /--> done/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited.catch(() => undefined);
    }
    rmSync(repository, { force: true, recursive: true });
  }
});

test("free-form feedback is revised, committed, approved, and cleaned up", async () => {
  const repository = createRepository();
  const baseCommit = git(repository, "rev-parse", "HEAD");
  const feedback = "Please add a revised line to result.txt.";
  const child = spawn(process.execPath, [fakeRun], {
    cwd: repository,
    env: { ...process.env, FAKE_REVISION_FEEDBACK: feedback },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (status) => resolveExit(status));
  });

  try {
    await waitForHumanPrompt(child.stdout, () => stdout, exited, 1);
    child.stdin.write(`${feedback}\n`);
    await waitForHumanPrompt(child.stdout, () => stdout, exited, 2);

    const createdWorktree = /^Created (.+) from [0-9a-f]+\.$/mu.exec(stdout);
    assert.ok(createdWorktree, stdout);
    const worktreeDirectory = createdWorktree[1];
    const worktreeBranch = git(worktreeDirectory, "branch", "--show-current");
    const worktreeBranchTipBeforeApproval = git(worktreeDirectory, "rev-parse", "HEAD");

    child.stdin.end("approve\n");

    assert.equal(await exited, 0, stderr);
    assert.equal(
      readFileSync(join(repository, "result.txt"), "utf8"),
      "implemented\nrevised\n",
    );
    assert.equal(git(repository, "rev-parse", "HEAD"), worktreeBranchTipBeforeApproval);
    assert.equal(git(repository, "rev-parse", "HEAD~2"), baseCommit);
    assert.equal(git(repository, "rev-list", "--count", `${baseCommit}..HEAD`), "2");
    assert.equal(
      git(repository, "log", "--reverse", "--format=%s", `${baseCommit}..HEAD`),
      "Implement task\nRevise task",
    );
    assert.equal(git(repository, "status", "--porcelain"), "");
    assert.equal(git(repository, "branch", "--format=%(refname:short)"), "main");
    assert.equal(git(repository, "branch", "--list", worktreeBranch), "");
    assert.equal(worktreeCount(repository), 1);
    assert.equal(outputCount(stdout, humanPrompt), 2);
    assert.match(stdout, /Agent runs: 3/u);

    const removedWorktree = /^Removed (.+)\.$/mu.exec(stdout);
    assert.ok(removedWorktree, stdout);
    assert.equal(removedWorktree[1], worktreeDirectory);
    assert.equal(existsSync(worktreeDirectory), false);
    assert.ok(stdout.indexOf(removedWorktree[0]) < stdout.indexOf("--> done"), stdout);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited.catch(() => undefined);
    }
    rmSync(repository, { force: true, recursive: true });
  }
});

test("the worktree Machine refuses a dirty source checkout without creating work", () => {
  const repository = createRepository();

  try {
    writeFileSync(join(repository, "uncommitted.txt"), "leave me alone\n");

    const result = spawnSync(process.execPath, [fakeRun], {
      cwd: repository,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source checkout must be clean/u);
    assert.equal(git(repository, "branch", "--format=%(refname:short)"), "main");
    assert.equal(worktreeCount(repository), 1);
    assert.equal(existsSync(join(repository, "result.txt")), false);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

async function waitForHumanPrompt(
  output: NodeJS.ReadableStream,
  stdout: () => string,
  exited: Promise<number | null>,
  occurrence: number,
): Promise<void> {
  const timeout = AbortSignal.timeout(humanPromptTimeoutMs);

  try {
    while (outputCount(stdout(), humanPrompt) < occurrence) {
      await Promise.race([
        once(output, "data", { signal: timeout }),
        exited.then((status) => {
          throw new Error(
            `Fake runner exited with status ${String(status)} before Human prompt ${occurrence}`,
          );
        }),
      ]);
    }
  } catch (cause) {
    if (timeout.aborted) {
      throw new Error(`Timed out waiting for Human prompt ${occurrence}`, { cause });
    }
    throw cause;
  }
}

function outputCount(output: string, value: string): number {
  return output.split(value).length - 1;
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "dev-machines-test-"));
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Dev Machines Test");
  git(repository, "config", "user.email", "dev-machines@example.invalid");
  writeFileSync(join(repository, "README.md"), "# Test repository\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "Initial commit");
  return repository;
}

function worktreeCount(repository: string): number {
  return git(repository, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .length;
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
