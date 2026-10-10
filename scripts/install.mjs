#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
export const available = readdirSync(join(root, "defaults"))
  .filter(name => name.endsWith(".ts")).map(name => name.slice(0, -3)).sort();

/** Copies only selected definitions. No imports, model calls, settings, or dependency installation. */
export function install({ target, workflows, dryRun = false, allowShadowing = false }) {
  if (typeof target !== "string" || !isAbsolute(target)) throw new Error("--target must be an existing absolute project path");
  const project = realpathSync(target);
  if (project === realpathSync(homedir())) throw new Error("This installer is project-local; it does not install into the global home catalog");
  if (!lstatSync(project).isDirectory()) throw new Error("Target must be a directory");
  if (!Array.isArray(workflows) || workflows.length === 0) throw new Error("Select at least one --workflow; there is no implicit install-all");
  const selected = [...new Set(workflows)];
  for (const name of selected) if (!available.includes(name)) throw new Error(`Unknown workflow: ${name}`);
  const catalog = join(project, ".machines");
  const support = join(catalog, "_machine-shop");
  for (const directory of [catalog, support]) {
    const stat = maybeStat(directory);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Refusing unsafe directory: ${directory}`);
  }
  if (!maybeStat(catalog) && !allowShadowing) {
    let parent = dirname(project);
    while (true) {
      if (maybeStat(join(parent, ".machines"))) throw new Error("Creating this catalog hides an ancestor .machines catalog. Inspect inherited routes first; use --allow-shadowing only deliberately.");
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
  }
  // The shared helper has no index.ts, so discovery does not mistake it for a Machine.
  const copies = [{ source: join(root, "defaults/_machine-shop/task.ts"), destination: join(support, "task.ts") }];
  for (const name of selected) {
    const alternate = join(catalog, `dev-${name}`);
    if (maybeStat(alternate)) throw new Error(`Refusing to shadow an existing alternate definition: ${alternate}`);
    copies.push({ source: join(root, "defaults", `${name}.ts`), destination: join(catalog, `dev-${name}.ts`) });
  }
  // Validate every destination before making any ordinary writes.
  const plan = copies.map(({ source, destination }) => {
    const content = readFileSync(source);
    const stat = maybeStat(destination);
    if (stat && (stat.isSymbolicLink() || !stat.isFile() || !readFileSync(destination).equals(content))) {
      throw new Error(`Refusing to overwrite customized or conflicting file: ${destination}`);
    }
    return { source, destination, content, action: stat ? "unchanged" : "create" };
  });
  if (!dryRun) {
    for (const directory of [catalog, support]) if (!maybeStat(directory)) mkdirSync(directory);
    for (const file of plan) if (file.action === "create") writeFileSync(file.destination, file.content, { flag: "wx" });
  }
  return { project, workflows: selected, dryRun, files: plan.map(({ source, destination, action }) => ({ source, destination, action })) };
}

function maybeStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

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
