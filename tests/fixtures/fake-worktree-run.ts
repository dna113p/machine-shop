import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import worktreeTask from "../../worktree-task.ts";

interface AgentRequest {
  readonly prompt: string;
  readonly cwd?: string;
}

const {
  agent,
  final,
  human,
  machine,
  operation,
  run,
} = await import(pathToFileURL(machinesRuntime()).href);

const definition = worktreeTask(
  { agent, final, human, machine, operation },
  "Create result.txt",
);
let agentRuns = 0;

const result = await run(definition, {
  agent: (request: AgentRequest) => {
    agentRuns += 1;

    if (agentRuns === 1) {
      assert.match(request.prompt, /Create result\.txt/u);
      assert.ok(request.cwd);
      writeFileSync(join(request.cwd, "result.txt"), "implemented\n");
      git(request.cwd, "add", "result.txt");
      git(request.cwd, "commit", "-m", "Implement task");
      return { type: "completed" };
    }

    if (agentRuns === 2) {
      assert.match(request.prompt, /Review the implementation/u);
      return { type: "reviewed" };
    }

    assert.equal(agentRuns, 3);
    const feedback = process.env.FAKE_REVISION_FEEDBACK;
    assert.ok(feedback);
    assert.match(request.prompt, /Continue this task/u);
    assert.ok(request.prompt.includes(feedback));
    assert.ok(request.cwd);
    writeFileSync(join(request.cwd, "result.txt"), "implemented\nrevised\n");
    git(request.cwd, "add", "result.txt");
    git(request.cwd, "commit", "-m", "Revise task");
    return { type: "completed" };
  },
});

console.log(`Agent runs: ${agentRuns}`);
console.log(`--> ${String(result.value)}`);

function machinesRuntime(): string {
  const projectDirectory = resolve(import.meta.dirname, "../..");
  const commonGitDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: projectDirectory, encoding: "utf8" },
  ).trim();

  // A linked worktree may not share the primary checkout's sibling layout.
  return resolve(dirname(commonGitDirectory), "../machines/src/index.ts");
}

function git(directory: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: directory, stdio: "ignore" });
}
