import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { available, install } from "../scripts/install.mjs";
import { launcher, runtimeLocation } from "./runtime.ts";

function fixture(context: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "dev-install-test-"));
  const project = join(base, "project"); const home = join(base, "empty-home");
  mkdirSync(project); mkdirSync(home);
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, project, home };
}
const checkInput = workspace => ({ task: "Check the installed workflow", workspace,
  checks: [{ name: "local-check", command: [process.execPath, "-e", "console.log('real check')"] }] });

test("installer lists exactly eleven opt-in defaults", () => {
  assert.equal(available.length, 11);
  assert.equal(available.includes("audit-project"), false, "audit runs only from the checkout");
  const listed = spawnSync(process.execPath, ["scripts/install.mjs", "--list"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split("\n"), available);
});

test("audit cannot be installed and creates no target files", context => {
  const { project } = fixture(context);
  assert.throws(() => install({ target: project, workflows: ["audit-project"] }), /Unknown workflow/u);
  assert.deepEqual(readdirSync(project), []);
});

test("selective installation records each copied file's hash and version in the manifest", context => {
  const { project } = fixture(context);
  const result = install({ target: project, workflows: ["retrospective"] });
  const support = join(project, ".machines/_machine-shop");
  assert.deepEqual(readdirSync(support).sort(), ["evidence.ts", "manifest.json", "task.ts"]);
  const manifest = JSON.parse(readFileSync(join(support, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.files).sort(), ["_machine-shop/evidence.ts", "_machine-shop/task.ts", "dev-retrospective.ts"]);
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  for (const file of result.files) {
    const key = file.destination.slice(join(project, ".machines").length + 1);
    assert.deepEqual(manifest.files[key], { hash: createHash("sha256").update(readFileSync(file.destination)).digest("hex"), version });
  }
});

test("dry-run creates no catalog or files", context => {
  const { project } = fixture(context);
  const plan = install({ target: project, workflows: ["verify-checks"], dryRun: true });
  assert.equal(plan.files.length, 2); assert.equal(plan.dryRun, true);
  assert.deepEqual(readdirSync(project), []);
});

test("selective installation preserves instructions and existing definitions", context => {
  const { project } = fixture(context);
  mkdirSync(join(project, ".machines"));
  writeFileSync(join(project, "AGENTS.md"), "Existing project policy");
  writeFileSync(join(project, ".machines/README.md"), "Existing routes");
  writeFileSync(join(project, ".machines/custom.ts"), "Existing custom Machine");
  install({ target: project, workflows: ["verify-checks", "review-code", "verify-checks"] });
  assert.deepEqual(readdirSync(join(project, ".machines")).sort(), ["README.md", "_machine-shop", "custom.ts", "dev-review-code.ts", "dev-verify-checks.ts"]);
  assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "Existing project policy");
  assert.equal(readFileSync(join(project, ".machines/README.md"), "utf8"), "Existing routes");
  assert.equal(existsSync(join(project, ".machines/agents.ts")), false);
});

test("repeat installation is a no-op", context => {
  const { project } = fixture(context);
  install({ target: project, workflows: ["verify-checks"] });
  const repeated = install({ target: project, workflows: ["verify-checks"] });
  assert.ok(repeated.files.every(file => file.action === "unchanged"));
});

test("customized definitions block the whole install before other new files", context => {
  const { project } = fixture(context);
  install({ target: project, workflows: ["review-code"] });
  const custom = join(project, ".machines/dev-review-code.ts");
  writeFileSync(custom, "Custom project policy");
  assert.throws(() => install({ target: project, workflows: ["verify-checks", "review-code"] }), /overwrite customized/u);
  assert.equal(existsSync(join(project, ".machines/dev-verify-checks.ts")), false);
  assert.equal(readFileSync(custom, "utf8"), "Custom project policy");
});

test("customized helper is never silently upgraded", context => {
  const { project } = fixture(context);
  install({ target: project, workflows: ["review-code"] });
  const custom = join(project, ".machines/_machine-shop/task.ts");
  writeFileSync(custom, "Custom helper");
  assert.throws(() => install({ target: project, workflows: ["verify-checks"] }), /overwrite customized/u);
  assert.equal(existsSync(join(project, ".machines/dev-verify-checks.ts")), false);
});

for (const path of [".machines", ".machines/_machine-shop", ".machines/dev-verify-checks.ts"]) {
  test(`installer rejects a symlink destination at ${path}`, context => {
    const { project, base } = fixture(context);
    if (path !== ".machines") mkdirSync(join(project, ".machines"));
    symlinkSync(join(base, "absent"), join(project, path));
    assert.throws(() => install({ target: project, workflows: ["verify-checks"] }), /unsafe|conflicting/u);
    assert.equal(existsSync(join(base, "absent")), false);
  });
}

test("directory-form Machines cannot be silently shadowed by file-form defaults", context => {
  const { project } = fixture(context);
  mkdirSync(join(project, ".machines/dev-verify-checks"), { recursive: true });
  writeFileSync(join(project, ".machines/dev-verify-checks/index.ts"), "existing");
  assert.throws(() => install({ target: project, workflows: ["verify-checks"] }), /alternate definition/u);
  assert.equal(existsSync(join(project, ".machines/_machine-shop")), false);
});

test("an inherited project catalog requires a deliberate shadowing decision", context => {
  const { project, base } = fixture(context);
  mkdirSync(join(base, ".machines"));
  assert.throws(() => install({ target: project, workflows: ["verify-checks"] }), /ancestor/u);
  assert.equal(existsSync(join(project, ".machines")), false);
  install({ target: project, workflows: ["verify-checks"], allowShadowing: true });
  assert.equal(existsSync(join(project, ".machines/dev-verify-checks.ts")), true);
});

test("invalid selections and relative targets do not create files", context => {
  const { project } = fixture(context);
  for (const workflows of [[], ["not-real"], ["verify-checks", "../escape"]]) {
    assert.throws(() => install({ target: project, workflows }));
  }
  assert.throws(() => install({ target: ".", workflows: ["verify-checks"] }));
  assert.deepEqual(readdirSync(project), []);
});

test("all installed definitions discover cleanly without fake live bindings or effects", async context => {
  const { project, home } = fixture(context);
  install({ target: project, workflows: available });
  const found = await launcher.listMachines({ cwd: project, home });
  assert.equal(found.length, 11);
  assert.ok(found.every(item => item.error === undefined), JSON.stringify(found));
  assert.deepEqual(found.find(item => item.name === "dev-verify-checks").missingAgents, []);
  assert.ok(found.find(item => item.name === "dev-implement-task").missingAgents.includes("implementer"));
  assert.equal(existsSync(join(project, ".machine-runs")), false);
});

test("installed workflow and helper remain runnable after moving the project", async context => {
  const { project, home, base } = fixture(context);
  install({ target: project, workflows: ["verify-checks"] });
  const moved = join(base, "moved project"); renameSync(project, moved);
  const prepared = await launcher.prepareMachineRun({ cwd: moved, home, machine: "dev-verify-checks", input: checkInput(moved) });
  const result = await prepared.start();
  assert.equal(result.value, "done"); assert.equal(result.output.outcome, "completed");
  assert.match(readFileSync(result.output.checks[0].log, "utf8"), /real check/u);
  const code = readFileSync(join(moved, ".machines/dev-verify-checks.ts"), "utf8");
  assert.doesNotMatch(code, /\/home\/|machines\/src/u);
});

test("real CLI executes an installed Machine and exits unsuccessfully on failed checks", context => {
  const { project, home } = fixture(context);
  install({ target: project, workflows: ["verify-checks"] });
  const cli = fileURLToPath(new URL(runtimeLocation.endsWith(".ts") ? "cli.ts" : "cli.js", runtimeLocation));
  const data = checkInput(project);
  const call = () => spawnSync(process.execPath, [cli, "run", "dev-verify-checks", "--", JSON.stringify(data)], {
    cwd: project, encoding: "utf8", env: { ...process.env, MACHINES_USER_HOME: home },
  });
  const passed = call(); assert.equal(passed.status, 0, passed.stderr); assert.match(passed.stdout, /--> done/u);
  data.checks[0].command = [process.execPath, "-e", "process.exit(1)"];
  const failed = call(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /Required checks failed/u);
});

test("an identical legacy helper remains unknown when another default is installed", context => {
  const { project } = fixture(context);
  install({ target: project, workflows: ["verify-checks"] });
  const path = join(project, ".machines/_machine-shop/manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  delete manifest.files["_machine-shop/task.ts"];
  writeFileSync(path, JSON.stringify(manifest));
  install({ target: project, workflows: ["review-code"] });
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after.files["_machine-shop/task.ts"], undefined);
  assert.ok(after.files["dev-review-code.ts"]);
});
