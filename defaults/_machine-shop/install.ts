import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface Catalog { version: string; files: Record<string, string> }
export interface Provenance { version: string; files: Record<string, { hash: string; version: string }> }
export const hash = (content: string) => createHash("sha256").update(content).digest("hex");
export function maybeStat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function safePath(root: string, path: string) {
  const key = relative(root, path);
  if (key.startsWith("..") || isAbsolute(key)) throw new Error(`Path escapes catalog: ${path}`);
  let current = root;
  for (const part of ["", ...key.split("/").filter(Boolean)]) {
    current = join(current, part);
    const stat = maybeStat(current);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing unsafe symlink: ${current}`);
    if (current !== path && stat && !stat.isDirectory()) throw new Error(`Refusing unsafe directory: ${current}`);
  }
}
export function readOptional(root: string, path: string): string | null {
  safePath(root, path);
  const stat = maybeStat(path);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
  return readFileSync(path, "utf8");
}
export function loadCatalog(): Catalog {
  const root = resolve(import.meta.dirname, "..");
  const files: Record<string, string> = {};
  const visit = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe catalog source: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (/\.(?:ts|mjs)$/u.test(name)) files[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return { version: JSON.parse(readFileSync(join(root, "../package.json"), "utf8")).version, files };
}
export const catalogNames = (catalog: Catalog) => Object.keys(catalog.files).filter(key => /^[^/]+\.ts$/u.test(key)).map(key => key.slice(0, -3)).sort();
export const installableNames = (catalog: Catalog) => catalogNames(catalog).filter(name => name !== "audit-project");
export function provenance(project: string): Provenance {
  const content = readOptional(project, join(project, ".machines/_machine-shop/manifest.json"));
  if (content === null) return { version: "unknown", files: {} };
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed.version !== "string" || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)
    || Object.values(parsed.files).some((value: any) => !value || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.hash)
      || typeof value.version !== "string" || !value.version.trim())) throw new Error("Invalid machine-shop manifest");
  return parsed;
}

/** The same destination/shadowing rules apply even when only routes are written. */
export function preflightCatalog(project: string, allowShadowing = false) {
  if (realpathSync(project) === realpathSync(homedir())) throw new Error("Refusing global home catalog");
  const destinationRoot = join(project, ".machines");
  for (const path of [destinationRoot, join(destinationRoot, "_machine-shop")]) {
    safePath(project, path);
    if (maybeStat(path) && !lstatSync(path).isDirectory()) throw new Error(`Refusing unsafe directory: ${path}`);
  }
  if (!maybeStat(destinationRoot) && !allowShadowing) {
    let parent = dirname(project);
    while (true) {
      if (maybeStat(join(parent, ".machines"))) throw new Error("Creating this catalog hides an ancestor .machines catalog. Inspect inherited routes first; use --allow-shadowing only deliberately.");
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
  }
}

/** Resolve the exact transitive file set used by installation and audit inventory. */
export function workflowFiles(catalog: Catalog, selected: string[]) {
  const files = new Map<string, { source: string; content: string }>();
  const add = (key: string, destination = key) => {
    if (files.has(destination)) return;
    const content = catalog.files[key];
    if (content === undefined) throw new Error(`Missing catalog dependency: ${key}`);
    files.set(destination, { source: key, content });
    for (const match of content.matchAll(/(?:from\s*|import\s*\()?["'](\.\.?\/[^"']+\.(?:ts|mjs))["']/gu)) {
      const dependency = relative("/", resolve("/", dirname(key), match[1]!));
      if (!dependency.startsWith("_machine-shop/")) throw new Error(`Unsupported catalog dependency: ${dependency}`);
      add(dependency);
    }
  };
  for (const name of selected) add(`${name}.ts`, `dev-${name}.ts`);
  return files;
}

/** Shared by the CLI and the checkout-only audit. */
export function install({ target, workflows, dryRun = false, allowShadowing = false, refresh = false, catalog = loadCatalog(), onWrite }: {
  target: string; workflows: string[]; dryRun?: boolean; allowShadowing?: boolean; refresh?: boolean; catalog?: Catalog; onWrite?: (path: string) => void;
}) {
  if (typeof target !== "string" || !isAbsolute(target)) throw new Error("--target must be an existing absolute project path");
  const project = realpathSync(target);
  if (project === realpathSync(homedir())) throw new Error("This installer is project-local; it does not install into the global home catalog");
  if (!lstatSync(project).isDirectory()) throw new Error("Target must be a directory");
  if (!Array.isArray(workflows) || !workflows.length) throw new Error("Select at least one --workflow; there is no implicit install-all");
  const selected = [...new Set(workflows)];
  const available = installableNames(catalog);
  for (const name of selected) if (!available.includes(name)) throw new Error(`Unknown workflow: ${name}`);
  preflightCatalog(project, allowShadowing);
  const destinationRoot = join(project, ".machines");
  for (const name of selected) {
    const alternate = join(destinationRoot, `dev-${name}`);
    if (maybeStat(alternate)) throw new Error(`Refusing to shadow an existing alternate definition: ${alternate}`);
  }
  const files = workflowFiles(catalog, selected);
  const baseline = provenance(project);
  const manifestPath = join(destinationRoot, "_machine-shop/manifest.json");
  const manifestBefore = readOptional(project, manifestPath);
  const plan = [...files].map(([key, { source, content }]) => {
    const destination = join(destinationRoot, key);
    const before = readOptional(project, destination);
    if (before !== null && before !== content && !(refresh && baseline.files[key]?.hash === hash(before))) {
      throw new Error(`Refusing to overwrite customized or conflicting file: ${destination}`);
    }
    return { key, source, destination, content, before, action: before === content ? "unchanged" : before === null ? "create" : "refresh" };
  });
  if (!dryRun) {
    // Recheck the complete plan before any writes, including provenance and helpers.
    for (const file of plan) if (readOptional(project, file.destination) !== file.before) throw new Error(`Destination changed: ${file.destination}`);
    if (readOptional(project, manifestPath) !== manifestBefore) throw new Error("Provenance changed during installation");
    for (const file of plan) {
      if (file.action !== "unchanged") {
        safePath(project, file.destination);
        mkdirSync(dirname(file.destination), { recursive: true });
        writeFileSync(file.destination, file.content, { flag: file.action === "create" ? "wx" : "w" });
        onWrite?.(file.destination);
      }
      // Identical pre-existing files were not copied. Do not manufacture a
      // trusted baseline for unknown or modified files merely by selecting them.
      if (file.action !== "unchanged") baseline.files[file.key] = { hash: hash(file.content), version: catalog.version };
    }
    baseline.version = catalog.version;
    const next = JSON.stringify(baseline, null, 2) + "\n";
    if (next !== manifestBefore) {
      safePath(project, manifestPath);
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, next, { flag: manifestBefore === null ? "wx" : "w" });
      onWrite?.(manifestPath);
    }
  }
  return { project, workflows: selected, dryRun, files: plan.map(({ source, destination, action }) => ({ source, destination, action })) };
}
