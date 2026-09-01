import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const fakeRun = resolve("tests/fixtures/fake-implement-review-run.ts");
const prompt = "Suggestions:\n- approve\n> ";

test("implement-review finishes after Human approval", () => {
  const result = spawnSync(process.execPath, [fakeRun], {
    encoding: "utf8",
    input: "approve\n",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent runs: 1/u);
  assert.match(result.stdout, /--> done/u);
});

test("implement-review sends free-form feedback through another Agent pass", async () => {
  const feedback = "Make the example even smaller.";
  const child = spawn(process.execPath, [fakeRun], {
    env: { ...process.env, FAKE_REVIEW_FEEDBACK: feedback },
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
    child.once("close", resolveExit);
  });

  try {
    await waitForPrompt(() => stdout, exited, 1);
    child.stdin.write(`${feedback}\n`);
    await waitForPrompt(() => stdout, exited, 2);
    child.stdin.end("approve\n");

    assert.equal(await exited, 0, stderr);
    assert.match(stdout, /Agent runs: 2/u);
    assert.match(stdout, /--> done/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

async function waitForPrompt(
  output: () => string,
  exited: Promise<number | null>,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (occurrences(output(), prompt) < count) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for prompt ${count}`);
    await Promise.race([
      exited.then((status) => {
        throw new Error(`Process exited with ${status} before prompt ${count}`);
      }),
      new Promise((resolveWait) => setTimeout(resolveWait, 10)),
    ]);
  }
}

function occurrences(output: string, value: string): number {
  return output.split(value).length - 1;
}
