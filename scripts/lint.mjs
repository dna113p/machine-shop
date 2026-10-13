import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Like typecheck.mjs: this repository installs no dependencies of its own, so the
// linter comes from the sibling Machines checkout when it is not installed here.
const root = resolve(import.meta.dirname, "..");
const candidates = [
  resolve(root, "node_modules/oxlint/bin/oxlint"),
  resolve(root, "../machines/node_modules/oxlint/bin/oxlint"),
];
const linter = candidates.find(existsSync);
if (!linter) throw new Error("Install this repo's dev dependencies or the sibling Machines checkout's dependencies");
execFileSync(process.execPath, [linter, "--deny-warnings", ...process.argv.slice(2)], {
  cwd: root, stdio: "inherit",
});
