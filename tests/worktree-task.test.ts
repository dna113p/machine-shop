import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const fakeRun = resolve("tests/fixtures/fake-worktree-run.ts");

test("the worktree Machine implements, reviews, merges, cleans up, and finishes", () => {
  const repository = mkdtempSync(join(tmpdir(), "dev-machines-test-"));

  try {
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.name", "Dev Machines Test");
    git(repository, "config", "user.email", "dev-machines@example.invalid");
    writeFileSync(join(repository, "README.md"), "# Test repository\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "Initial commit");

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
    assert.match(result.stdout, /--> done/u);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

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
