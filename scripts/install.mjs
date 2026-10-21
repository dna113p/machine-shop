#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { install, loadCatalog, installableNames } from "../defaults/_machine-shop/install.ts";
export { install };
export const available = installableNames(loadCatalog());

function main(args) {
  if (args.length === 1 && args[0] === "--list") { console.log(available.join("\n")); return; }
  let target; let dryRun = false; let allowShadowing = false; const workflows = [];
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--dry-run") dryRun = true;
    else if (option === "--allow-shadowing") allowShadowing = true;
    else if (option === "--target" || option === "--workflow") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
      if (option === "--target") { if (target) throw new Error("Duplicate --target"); target = value; }
      else workflows.push(value);
    } else throw new Error(`Unknown option: ${option}`);
  }
  console.log(JSON.stringify(install({ target, workflows, dryRun, allowShadowing }), null, 2));
  console.log("Inspect the selected sources and discover bindings in the target project. Keep .machine-runs/ ignored; no presets or existing instruction files were changed.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
