import { findPackageJSON } from "node:module";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { catalogNames, hash, maybeStat, provenance, readOptional, safePath, workflowFiles, type Catalog } from "./install.ts";
import { readEvidence } from "./evidence.ts";
import { declaredRoles } from "./roles.ts";

export const gateClasses = ["lint", "types", "tests", "build", "live"] as const;
export type GateClass = typeof gateClasses[number];
export interface Gate { class: GateClass; name: string; command: string[] }
export interface Preset { name: string; source: string; description: string; harness?: string; model?: string }
export interface Default { name: string; status: "absent" | "current" | "stale" | "modified" | "unknown"; roles: string[]; catalogRoles: string[]; refreshHelpers: string[]; installable: boolean }
export interface Inventory {
  project: string; since: string; until: string;
  instructions: Record<string, string | null>; scripts: Record<string, string>; ci: Record<string, string>;
  gates: { found: Gate[]; missing: GateClass[] };
  presets: Preset[]; bindings: { source: string | null; roles: Record<string, string | null> };
  runtime: { pinned: string | null; installed: string }; catalogVersion: string;
  defaults: Default[]; custom: string[]; snapshot: string;
  helpers: { name: string; status: string }[]; provenanceVersion: string;
  runs: ReturnType<typeof readEvidence>;
}
export interface Proposal {
  defaults: { name: string; action: "install" | "refresh" | "keep" | "leave"; reason: string }[];
  routes: { task: string; machine: string; roles: Record<string, { preset: string; reason: string; evidence: string[] }> }[];
  gates: Inventory["gates"];
  findings: { reason: string; evidence: string[]; route: string }[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 4000;
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function parseAuditInput(input: unknown) {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (!object(value) || Object.keys(value).some(key => !["project", "apply", "since"].includes(key))) throw new Error("Expected project, optional apply and since");
  if (!text(value.project) || !isAbsolute(value.project) || value.project.includes("\0")) throw new Error("project must be an absolute directory path");
  if (value.apply !== undefined && typeof value.apply !== "boolean") throw new Error("apply must be a boolean");
  const until = Date.now();
  let since = until - 7 * 86400000;
  if (value.since !== undefined) {
    if (typeof value.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.since)) throw new Error("since must be YYYY-MM-DD");
    since = Date.parse(value.since);
    if (!Number.isFinite(since) || new Date(since).toISOString().slice(0, 10) !== value.since) throw new Error("since must be a valid calendar date");
  }
  return { project: resolve(value.project), apply: value.apply === true, since, until };
}
interface Launcher {
  listAgentPresets(location: { cwd: string }): Promise<Preset[]>;
  listMachines(location: { cwd: string }): Promise<{ name: string; agentRoles: Record<string, string>; error?: string }[]>;
}
export async function projectRuntime(project: string): Promise<{ launcher: Launcher; version: string }> {
  const bases = [pathToFileURL(join(project, "package.json")).href, import.meta.url];
  if (process.argv[1] && maybeStat(process.argv[1])) bases.push(pathToFileURL(realpathSync(process.argv[1])).href);
  let packagePath: string | undefined;
  for (const base of bases) {
    try { packagePath = findPackageJSON("@dna113p/machines", base); }
    catch (error) { if (!["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    if (packagePath) break;
  }
  if (!packagePath) throw new Error("Cannot resolve the installed Machines runtime from the project, workflow or running CLI");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  // Resolve the public import export; createRequire.resolve uses the incompatible require condition.
  const exported = pkg.exports?.["./launcher"];
  const entry = typeof exported === "string" ? exported : exported?.import;
  if (typeof entry !== "string" || !entry.startsWith("./")) throw new Error("Installed Machines has no public launcher import export");
  return { launcher: await import(new URL(entry, pathToFileURL(packagePath)).href), version: pkg.version };
}
/** Detect any catalog edit while the proposal is waiting, including helpers, modes and symlinks. */
export function catalogSnapshot(project: string) {
  const root = join(project, ".machines");
  const values: unknown[] = [];
  const visit = (path: string) => {
    const stat = maybeStat(path);
    if (!stat) return;
    values.push([path.slice(project.length), stat.mode, stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? hash(readFileSync(path, "utf8")) : null]);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  return hash(JSON.stringify(values));
}
export async function inventoryProject(project: string, catalog: Catalog, own: string, since: number, until: number): Promise<Inventory> {
  if (!lstatSync(project).isDirectory()) throw new Error("project must be an existing directory");
  // The project's own gate list (.machines/gates.json, which the task helper runs) is read as an instruction file and as gates.
  const instructions = Object.fromEntries(["AGENTS.md", "CLAUDE.md", ".machines/README.md", ".machines/gates.json"].map(key => [key, readOptional(project, join(project, key))]));
  const pkg = JSON.parse(readOptional(project, join(project, "package.json")) ?? "{}");
  const scripts: Record<string, string> = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  const matchers: Record<GateClass, RegExp> = { lint: /(?:^|:)lint(?:$|:)/u, types: /(?:typecheck|type-check|types|tsc)/u, tests: /(?:^|:)tests?(?:$|:)/u, build: /(?:^|:)build(?:$|:)/u, live: /(?:live|e2e|integration)/u };
  const found = Object.keys(scripts).sort().flatMap(name => gateClasses.filter(kind => matchers[kind].test(name)).map(kind => ({ class: kind, name, command: ["npm", "run", name] })));
  // A gate list names its checks; a name is classed as a script name is, and its command is kept as written (placeholders included).
  let gateList: unknown = null;
  try { gateList = instructions[".machines/gates.json"] === null ? null : JSON.parse(instructions[".machines/gates.json"]!); } catch { gateList = null; }
  if (object(gateList) && Array.isArray(gateList.checks)) for (const check of gateList.checks) {
    if (!object(check) || !text(check.name) || !Array.isArray(check.command) || !check.command.length || check.command.some(part => !text(part))) continue;
    const named = `${check.name}`.toLowerCase();
    const kind = gateClasses.find(kind => matchers[kind].test(named)) ?? (/(?:smoke|package|install)/u.test(named) ? "live" : undefined);
    if (kind) found.push({ class: kind, name: `.machines/gates.json:${check.name}`, command: check.command as string[] });
  }
  const ci: Record<string, string> = {};
  const workflows = join(project, ".github/workflows");
  safePath(project, workflows);
  if (maybeStat(workflows)) for (const name of readdirSync(workflows).sort()) if (/\.ya?ml$/u.test(name)) ci[`.github/workflows/${name}`] = readOptional(project, join(workflows, name))!;
  for (const name of [".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml"]) {
    const content = readOptional(project, join(project, name)); if (content !== null) ci[name] = content;
  }
  // Recognize literal CI commands only; shell expressions and multiline scripts remain source evidence.
  for (const [source, content] of Object.entries(ci)) for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const literal = line.match(/^\s*(?:-\s*)?run:\s*["']?([\w./:@= -]+?)["']?\s*$/u)?.[1]
      ?? line.match(/^\s*-\s*((?:npm|pnpm|yarn|npx|go|cargo|pytest|ruff|mypy|tsc|eslint)\s+[\w./:@= -]+)\s*$/u)?.[1];
    if (!literal) continue;
    const command = literal.trim().split(/\s+/u);
    const joined = command.join(" ");
    const kind: GateClass | undefined = /\b(?:eslint|ruff|lint)\b/u.test(joined) ? "lint"
      : /\b(?:tsc|mypy|typecheck|type-check|types)\b/u.test(joined) ? "types"
      : /\b(?:live|e2e|integration|playwright)\b/u.test(joined) ? "live"
      : /\b(?:test|pytest|vitest|jest)\b/u.test(joined) ? "tests"
      : /\bbuild\b/u.test(joined) ? "build" : undefined;
    if (kind && !found.some(gate => gate.class === kind && (gate.command.join(" ") === joined || (joined === "npm test" && gate.command.join(" ") === "npm run test")))) {
      found.push({ class: kind, name: `${source}:${index + 1}`, command });
    }
  }
  const baseline = provenance(project);
  const names = catalogNames(catalog);
  const defaults: Default[] = names.map(name => {
    const key = `dev-${name}.ts`;
    const content = readOptional(project, join(project, ".machines", key));
    return { name, roles: declaredRoles(content ?? catalog.files[`${name}.ts`]!), catalogRoles: declaredRoles(catalog.files[`${name}.ts`]!),
      refreshHelpers: [], installable: name !== "audit-project",
      status: content === null ? "absent" : !baseline.files[key] ? "unknown" : baseline.files[key].hash !== hash(content) ? "modified"
      : content === catalog.files[`${name}.ts`] ? "current" : "stale" };
  });
  const directory = join(project, ".machines");
  const custom = maybeStat(directory) ? readdirSync(directory).sort().filter(name => {
    if (name === "agents.ts" || name.startsWith("_")) return false;
    const stat = lstatSync(join(directory, name));
    return (name.endsWith(".ts") && !names.some(key => name === `dev-${key}.ts`)) || (stat.isDirectory() && !!maybeStat(join(directory, name, "index.ts")));
  }).map(name => name.replace(/\.ts$/u, "")) : [];
  const helpers: Inventory["helpers"] = [];
  const support = join(directory, "_machine-shop");
  safePath(project, support);
  const visitHelpers = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      safePath(project, path);
      if (lstatSync(path).isDirectory()) { visitHelpers(path); continue; }
      const key = path.slice(directory.length + 1);
      if (key === "_machine-shop/manifest.json") continue;
      const content = readOptional(project, path)!;
      const expected = catalog.files[key];
      helpers.push({ name: key, status: !baseline.files[key] ? "unknown" : baseline.files[key].hash !== hash(content) ? "modified" : content === expected ? "current" : "stale" });
    }
  };
  if (maybeStat(support)) visitHelpers(support);
  for (const entry of defaults) {
    if (!entry.installable) continue;
    const dependencies = workflowFiles(catalog, [entry.name]);
    entry.refreshHelpers = helpers.filter(helper => helper.status === "stale" && dependencies.has(helper.name)).map(helper => helper.name);
  }
  const { launcher, version } = await projectRuntime(project);
  const presets = await launcher.listAgentPresets({ cwd: project });
  return { project, since: new Date(since).toISOString(), until: new Date(until).toISOString(), instructions, scripts, ci,
    gates: { found, missing: gateClasses.filter(kind => !found.some(gate => gate.class === kind)) }, presets,
    bindings: { source: readOptional(project, join(directory, "agents.ts")), roles: Object.fromEntries([...new Set(defaults.flatMap(item => item.roles))].map(role => [role, presets.find(preset => preset.name === role)?.source ?? null])) },
    runtime: { pinned: pkg.dependencies?.["@dna113p/machines"] ?? pkg.devDependencies?.["@dna113p/machines"] ?? null, installed: version },
    catalogVersion: catalog.version, provenanceVersion: baseline.version, helpers, defaults, custom, snapshot: catalogSnapshot(project), runs: readEvidence([project], own, since, until, true) };
}
export function validateProposal(summary: unknown, inventory: Inventory): Proposal {
  const body: unknown = typeof summary === "string" ? JSON.parse(summary) : summary;
  if (!object(body) || !Array.isArray(body.defaults)) throw new Error("defaults must be an array");
  const decisions = new Map<string, string>();
  for (const item of body.defaults) {
    if (!object(item) || !text(item.name) || !text(item.reason) || !text(item.action)) throw new Error("Each default needs name, action and reason");
    const entry = inventory.defaults.find(entry => entry.name === item.name);
    if (!entry || decisions.has(item.name)) throw new Error(`Unknown or duplicate default: ${item.name}`);
    const permitted = !entry.installable ? ["leave"] : entry.status === "absent" ? ["install", "leave"] : (entry.status === "stale" || (entry.status === "current" && entry.refreshHelpers.length > 0)) ? ["refresh", "keep", "leave"] : ["keep", "leave"];
    if (!permitted.includes(item.action)) throw new Error(`Unsafe ${item.action} for ${item.name} (${entry.status})`);
    decisions.set(item.name, item.action);
  }
  if (decisions.size !== inventory.defaults.length) throw new Error("defaults must cover every catalog entry exactly once");
  if (!Array.isArray(body.routes) || body.routes.length > 50) throw new Error("routes must be an array of at most 50 routes");
  const routes = new Set<string>();
  for (const route of body.routes) {
    if (!object(route) || !text(route.task) || !text(route.machine) || !object(route.roles) || routes.has(route.machine)) throw new Error("Each route needs a task, unique machine and roles");
    const entry = inventory.defaults.find(entry => `dev-${entry.name}` === route.machine);
    if (!entry || !entry.installable || (entry.status === "absent" && decisions.get(entry.name) !== "install")) throw new Error(`Route has no installed or selected Machine: ${route.machine}`);
    routes.add(route.machine);
    const declared = ["install", "refresh"].includes(decisions.get(entry.name)!) ? entry.catalogRoles : entry.roles;
    if (Object.keys(route.roles).sort().join() !== [...declared].sort().join()) throw new Error(`Route ${route.machine} must bind each declared role`);
    for (const binding of Object.values(route.roles)) {
      if (!object(binding) || !text(binding.preset) || !text(binding.reason) || !Array.isArray(binding.evidence) || !binding.evidence.length) throw new Error("Each role needs preset, reason and evidence");
      const preset = inventory.presets.find(item => item.name === binding.preset);
      if (!preset || binding.evidence.some(item => item !== preset.source && item !== preset.description)) throw new Error(`Unavailable preset or unsupported evidence: ${binding.preset}`);
    }
  }
  const gates = body.gates;
  const gateKey = (gate: Gate) => JSON.stringify([gate.class, gate.name, gate.command]);
  if (!object(gates) || !Array.isArray(gates.found) || !Array.isArray(gates.missing)
    || gates.found.some(gate => !object(gate) || !gateClasses.includes(gate.class as GateClass) || !text(gate.name) || !Array.isArray(gate.command) || gate.command.some(part => !text(part)))
    || JSON.stringify((gates.found as Gate[]).map(gateKey).sort()) !== JSON.stringify(inventory.gates.found.map(gateKey).sort())
    || JSON.stringify([...gates.missing].sort()) !== JSON.stringify([...inventory.gates.missing].sort())) throw new Error("gates must retain the found commands and missing classes from inventory");
  if (!Array.isArray(body.findings) || body.findings.length > 200) throw new Error("findings must be an array of at most 200 items");
  // A finding may cite a run stop, or an inventoried file: an instruction file that was read, a CI file, or a gate's name.
  const evidence = new Set([...inventory.runs.stops.flatMap(stop => [stop.id, ...stop.locations]),
    ...Object.entries(inventory.instructions).filter(([, content]) => content !== null).map(([key]) => key),
    ...Object.keys(inventory.ci), ...inventory.gates.found.map(gate => gate.name)]);
  for (const finding of body.findings) {
    if (!object(finding) || !text(finding.reason) || !text(finding.route) || !Array.isArray(finding.evidence) || !finding.evidence.length
      || finding.evidence.some(item => !evidence.has(item)) || (!routes.has(finding.route) && !gateClasses.includes(finding.route as GateClass))) throw new Error("Each finding needs a known route or gate class, and evidence from the inventory: a stop id or location, an instruction or CI file key, or a gate name");
  }
  return body as unknown as Proposal;
}
const escape = (value: string) => value.replace(/[&<>"']/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const cell = (value: unknown) => escape([...String(value)].slice(0, 500).join(""));
function table(headers: string[], rows: unknown[][]) {
  const start = `<table><thead><tr>${headers.map(header => `<th>${cell(header)}</th>`).join("")}</tr></thead><tbody>`;
  let body = "";
  for (const row of rows.slice(0, 60)) {
    const rendered = `<tr>${row.map(value => `<td>${cell(value)}</td>`).join("")}</tr>`;
    if (Buffer.byteLength(start + body + rendered) > 16_000) break;
    body += rendered;
  }
  return start + body + "</tbody></table>";
}
export function auditPage(inventory: Inventory, proposal: Proposal, decision: string) {
  const page = `<h1>${cell(basename(inventory.project))}: ${cell(decision)}</h1>
<p class="breadcrumb">${cell(inventory.project)} · Machines ${cell(inventory.runtime.installed)} (pinned ${cell(inventory.runtime.pinned ?? "none")}) · Catalog ${cell(inventory.catalogVersion)}: ${inventory.defaults.length} defaults, ${inventory.custom.length} project Machines</p>
<h2>Drift</h2>${table(["Machine", "Status", "Action", "Reason"], [...proposal.defaults.map(item => [item.name, inventory.defaults.find(entry => entry.name === item.name)!.status, item.action, item.reason]), ...inventory.custom.map(name => [name, "project-specific", "leave", "Owner policy"])])}
<h2>Proposed routing map</h2>${table(["Task", "Machine", "Role bindings and evidence"], proposal.routes.map(route => [route.task, route.machine, Object.entries(route.roles).map(([role, binding]) => `${role} = ${binding.preset}: ${binding.reason} (${binding.evidence.join(", ")})`).join("; ")]))}
<h2>Gates</h2>${table(["Class", "Commands", "Status"], gateClasses.map(kind => [kind, proposal.gates.found.filter(gate => gate.class === kind).map(gate => gate.command.join(" ")).join("; ") || "No command", proposal.gates.missing.includes(kind) ? "missing" : "found; not executed"]))}
<h2>Run evidence</h2><p>${cell(inventory.since)} through ${cell(inventory.until)}</p>
${table(["Helper", "Provenance"], inventory.helpers.map(helper => [helper.name, helper.status]))}
${table(["Outcome", "Count"], Object.entries(inventory.runs.outcomes))}${table(["Stopped stage", "Count"], Object.entries(inventory.runs.stopsByStage))}
${table(["Finding", "Route or gate", "Evidence"], proposal.findings.map(item => [item.reason, item.route, item.evidence.join("; ")]))}
<details><summary>Stops and unreadable evidence</summary>${table(["Stage", "Reason", "Evidence"], inventory.runs.stops.map(stop => [stop.stage, stop.reason, stop.id]))}<p>${cell(inventory.runs.unreadable.join("; "))}</p><p>${cell(inventory.runs.notEnded.join("; "))}</p></details>
<p>Tables show at most 60 rows within a byte budget; text cells are shortened. Full inventory and proposal are in inventory.json and audit.json. The catalog comes from the Machine Shop checkout, not a live upstream check.</p>
<section class="decision"><h2>Decision</h2><p>${cell(decision)}. Accept installs selected defaults, refreshes trusted unchanged copies, updates the marked routing section and creates bindings only when absent. Other findings stay here for the owner.</p></section>`;
  // Bound encoded bytes as well as characters; keep the complete kit structure.
  if (Buffer.byteLength(page) >= 200_000) throw new Error("Audit page exceeds 200 kB");
  return page;
}
export function routingReadme(previous: string | null, proposal: Proposal) {
  const open = "<!-- machine-shop:routes -->", close = "<!-- /machine-shop:routes -->";
  const old = previous ?? "";
  const md = (value: string) => escape(value.replace(/[\r\n]/gu, " ")).replace(/[\\`*_{}[\]#|]/gu, "\\$&");
  const section = `${open}\n## Machine routes\n\n${proposal.routes.map(route => `- ${md(route.task)}: \`${route.machine}\`${Object.entries(route.roles).map(([role, binding]) => ` --agent ${md(role)}=${md(binding.preset)}`).join("")}`).join("\n")}\n${close}`;
  const openings = old.split(open).length - 1, closings = old.split(close).length - 1;
  if (!openings && !closings) return old + (old.endsWith("\n") || !old ? "" : "\n") + "\n" + section + "\n";
  if (openings !== 1 || closings !== 1 || old.indexOf(open) > old.indexOf(close)) throw new Error("Broken or duplicate machine-shop:routes markers");
  return old.slice(0, old.indexOf(open)) + section + old.slice(old.indexOf(close) + close.length);
}

/** Keep environment choices in project bindings. Route flags also support different presets for the same role. */
export function agentBindings(inventory: Inventory, proposal: Proposal) {
  const selected = [...new Set(proposal.routes.flatMap(route => Object.values(route.roles).map(binding => binding.preset)))];
  const builtins: Record<string, string> = {
    default: 'adapters.acpAgent("npx", ["-y", "pi-acp"], { harness: "pi-acp", output: "capture" })',
    agy: 'adapters.agyAgent("agy", [], { harness: "agy", output: "capture" })',
    claude: 'adapters.claudeAgent("claude", [], { output: "capture" })',
    codex: 'adapters.codexAgent("codex", [], { output: "capture" })',
    "chatgpt-web": 'adapters.chatGptWebAgent({ output: "capture" })',
    deepseek: 'adapters.deepseekAgent("dsh", [], { output: "capture" })',
    jev: "adapters.jevAgent()", "openrouter-decision": "adapters.openRouterDecisionAgent()",
    laya: "adapters.layaAgent()", von: "adapters.vonAgent()",
  };
  const lines = ['// Generated from accepted audit evidence. Route-specific --agent flags are in README.md.', 'export default async function configure(adapters) {', '  const presets = {};'];
  const sources = [...new Set(selected.map(name => inventory.presets.find(preset => preset.name === name)!.source).filter(source => source !== "built in"))];
  for (const [index, source] of sources.entries()) {
    if (!isAbsolute(source)) throw new Error(`Preset has no loadable source: ${source}`);
    lines.push(`  const source${index} = await (await import(${JSON.stringify(pathToFileURL(source).href)})).default(adapters);`);
  }
  for (const name of selected) {
    const preset = inventory.presets.find(preset => preset.name === name)!;
    if (preset.source === "built in") {
      if (!builtins[name]) throw new Error(`Unsupported built-in preset: ${name}`);
      lines.push(`  presets[${JSON.stringify(name)}] = { description: ${JSON.stringify(preset.description)}, runner: ${builtins[name]} };`);
    } else lines.push(`  presets[${JSON.stringify(name)}] = source${sources.indexOf(preset.source)}[${JSON.stringify(name)}];`);
  }
  const aliases = new Map<string, Set<string>>();
  for (const route of proposal.routes) for (const [role, binding] of Object.entries(route.roles)) {
    if (!aliases.has(role)) aliases.set(role, new Set());
    aliases.get(role)!.add(binding.preset);
  }
  for (const [role, choices] of aliases) if (choices.size === 1 && !selected.includes(role)) lines.push(`  presets[${JSON.stringify(role)}] = presets[${JSON.stringify([...choices][0])}];`);
  return [...lines, "  return presets;", "}", ""].join("\n");
}
