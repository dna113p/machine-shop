import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const candidates = [
  resolve(root, "node_modules/typescript/bin/tsc"),
  resolve(root, "../machines/node_modules/typescript/bin/tsc"),
];
const compiler = candidates.find(existsSync);
if (!compiler) throw new Error("Install this repo's dev dependencies or the sibling Machines checkout's dependencies");
execFileSync(process.execPath, [compiler, "--noEmit", "-p", resolve(root, "tsconfig.json")], {
  cwd: root, stdio: "inherit",
});
