interface Parts {
  decision: string;
  standing: string;
  changed?: string;
  evidence: string[];
  needs?: string;
  options?: { name: string; does: string; recommended?: boolean }[];
}

/** Fit a flattened opening, including its ellipsis, without splitting a word. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit);
  const boundary = prefix.lastIndexOf(" ");
  return `${boundary < 0 ? "" : prefix.slice(0, boundary)}…`;
}

/** Split at a sentence or line; retain the full text when its opening needs cutting. */
export function opening(text: string): { first: string; rest: string } {
  const whole = text.trim();
  const boundary = /\.(?=\s|$)|\r?\n/u.exec(whole);
  const end = boundary ? boundary.index + (boundary[0] === "." ? 1 : 0) : whole.length;
  const sentence = whole.slice(0, end);
  return { first: cut(sentence, 100), rest: sentence.length > 100 ? whole : whole.slice(end).trim() };
}

/** A decision first, followed by the context and choices needed to answer it. */
export function brief(parts: Parts): string {
  const decision = cut(parts.decision.trim().replace(/\s+/gu, " "), 100);
  const options = [...(parts.options ?? [])].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
  return [
    decision, "", parts.standing,
    ...(parts.changed === undefined ? [] : [`Since last time: ${parts.changed}`]),
    ...(parts.needs === undefined ? [] : [`Needs: ${parts.needs}`]),
    ...parts.evidence,
    ...options.map(option => `${option.name}: ${option.does}${option.recommended ? " (recommended)" : ""}`),
  ].join("\n");
}

export const firstLine = (text: string): string => text.split(/\r?\n/u)[0] ?? "";

export interface EvidenceBlock {
  title: string;
  text: string;
  tail?: string;
  table?: { headings: string[]; rows: string[][] };
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

/** Budget the encoded output, keeping Unicode code points whole and accounting for the marker. */
export function excerpt(value: string, bytes: number, encode = (text: string) => text, fromEnd = false, source = "stuck.md"): string {
  if (Buffer.byteLength(encode(value)) <= bytes) return value;
  const size = Buffer.byteLength(value);
  const selected = (length: number) => {
    // A UTF-16 boundary between the two halves of a surrogate pair is not a text boundary.
    if (length && (fromEnd ? /[\uDC00-\uDFFF]/u.test(value[value.length - length]!) : /[\uD800-\uDBFF]/u.test(value[length - 1]!))) length--;
    const kept = fromEnd ? value.slice(value.length - length) : value.slice(0, length);
    const marker = `[${size - Buffer.byteLength(kept)} bytes omitted; see ${source}.]`;
    return fromEnd ? `${marker}\n${kept}` : `${kept}\n${marker}`;
  };
  let low = 0; let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(encode(selected(mid))) <= bytes) low = mid;
    else high = mid - 1;
  }
  return selected(low);
}

const factValue = (value: unknown, budget: number, fromEnd = false): string => {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json) <= budget ? json
    : JSON.stringify(excerpt(typeof value === "string" ? value : json, budget, JSON.stringify, fromEnd));
};

/** Each failure owns a share; all passing metadata together gets only one share. */
function checkFacts(checks: Record<string, unknown>[], budget: number): string {
  const passing = checks.filter(check => check.passed === true).length;
  const share = Math.floor((budget - 2 - checks.length) / Math.max(1, checks.length - passing + Number(passing > 0)));
  return `[${checks.map(check => {
    const limit = check.passed === true ? Math.floor(share / passing) : share;
    const fields = Object.entries(check).filter(([, value]) => value !== undefined);
    const overhead = Buffer.byteLength(fields.map(([key]) => JSON.stringify(key) + ":,").join("")) + 2;
    const remaining = limit - overhead;
    const tailBudget = typeof check.tail === "string" ? Math.floor(remaining / 2) : 0;
    const fieldBudget = Math.floor((remaining - tailBudget) / Math.max(1, fields.length - Number(tailBudget > 0)));
    return `{${fields.map(([key, value]) => `${JSON.stringify(key)}:${factValue(value, key === "tail" ? tailBudget : fieldBudget, key === "tail")}`).join(",")}}`;
  }).join(",")}]`;
}

/** Preserve the ordinary facts schema; oversized fields become explicitly marked text excerpts. */
export function evidenceFacts(facts: Record<string, unknown>): string {
  const entries = Object.entries(facts).filter(([, value]) => value !== undefined);
  const overhead = Buffer.byteLength(entries.map(([key]) => JSON.stringify(key) + ":,").join("")) + 2;
  const checks = Array.isArray(facts.checks) && facts.checks.every(check => check && typeof check === "object") ? facts.checks : undefined;
  // Reserve room for every failed gate's identity and tail, independent of unrelated facts.
  const checkBudget = checks ? 60_000 : 0;
  const budget = Math.floor((180_000 - overhead - checkBudget) / Math.max(1, entries.length - Number(!!checks)));
  return `{${entries.map(([key, value]) => {
    const encoded = key === "checks" && checks ? checkFacts(checks, checkBudget) : factValue(value, budget);
    return `${JSON.stringify(key)}:${encoded}`;
  }).join(",")}}`;
}

/** Deterministic Drip body fragment. Each block gets an escaped-byte budget, including table markup. */
export function evidencePage(parts: {
  headline: string;
  stopped: string;
  breadcrumb: string;
  blocks: EvidenceBlock[];
  effects: Record<string, string>;
  recommended: string;
}): string {
  const budget = Math.floor(150_000 / (parts.blocks.length + 3));
  const html = (value: string, limit = budget) => escapeHtml(excerpt(value, limit, escapeHtml));
  const blocks = parts.blocks.map(block => {
    let table = "";
    if (block.table) {
      const { headings, rows } = block.table;
      const shown = rows.slice(0, 100);
      const cellBudget = Math.floor((budget - 2000) / Math.max(1, shown.length * headings.length)) - 20;
      // Small row budgets would be consumed by omission markers. Show fewer complete rows instead.
      const count = Math.min(shown.length, Math.max(1, Math.floor((budget - 2000) / (headings.length * 300))));
      const cells = Math.max(256, cellBudget);
      table = `<table><thead><tr>${headings.map(heading => `<th>${html(heading, 256)}</th>`).join("")}</tr></thead><tbody>`
        + shown.slice(0, count).map(row => `<tr>${row.map(cell => `<td>${html(cell, cells)}</td>`).join("")}</tr>`).join("")
        + "</tbody></table>";
      if (rows.length > count) table += `<p>${rows.length - count} rows omitted; see stuck.md.</p>`;
    }
    const remaining = budget - Buffer.byteLength(table);
    const tailBudget = block.tail === undefined ? 0 : Math.floor(remaining * 2 / 3);
    const tail = block.tail === undefined ? "" : `<pre>${escapeHtml(excerpt(block.tail, tailBudget, escapeHtml, true))}</pre>`;
    return `<section><h2>${html(block.title, 256)}</h2>${table}<pre>${html(block.text, remaining - tailBudget)}</pre>${tail}</section>`;
  }).join("\n");
  return [
    `<h1>${html(parts.headline)}</h1>`,
    `<p class="lede">${html(parts.stopped)}</p>`,
    `<section class="recap"><span class="chip warn">Needs a decision</span><pre>${html(parts.breadcrumb)}</pre></section>`,
    blocks,
    `<section class="decision"><h2>Choose what happens next</h2><ul class="options">`,
    ...Object.entries(parts.effects).map(([name, effect]) => `<li${name === parts.recommended ? ' class="recommended"' : ""}><b>${escapeHtml(name)}</b>: ${escapeHtml(effect)}${name === parts.recommended ? " (recommended)" : ""}</li>`),
    "</ul></section>",
  ].join("\n");
}

/** A bounded, inert Drip fragment composed only from recorded ticket evidence. */
export function handoffPage(parts: {
  title: string;
  breadcrumb: string;
  outcome: string;
  done: string[];
  decided: string;
  needs: string;
  files: { path: string; added: number | null; removed: number | null }[] | null;
  gates: { name: string; outcome: "passed" | "failed" | "skipped"; tail?: string }[];
  review: EvidenceBlock[];
  evidence: EvidenceBlock[];
}): string {
  const html = (value: string, budget = 2_000, tail = false) =>
    escapeHtml(excerpt(value, budget, escapeHtml, tail, "the run evidence"));
  // Fixed section budgets include markup. Bound list lengths as well as individual fields;
  // truncating the finished HTML could cut entities, Unicode, or closing tags.
  const omitted = (count: number, unit: string) => count > 0
    ? `<p>${count} ${unit} omitted; see the run evidence.</p>` : "";
  const blocks = (items: EvidenceBlock[], budget: number) => {
    items = items.filter(block => block.text.trim() || block.tail?.trim());
    const shown = items.slice(0, 40);
    const share = Math.floor((budget - 1_000) / Math.max(1, shown.length));
    return shown.map(block => {
      const remaining = share - 400;
      return `<section><h2>${html(block.title, 256)}</h2><pre>${html(block.text, block.tail === undefined ? remaining : Math.floor(remaining / 3))}</pre>`
        + (block.tail === undefined ? "" : `<pre>${html(block.tail, Math.floor(remaining * 2 / 3), true)}</pre>`) + "</section>";
    }).join("\n") + omitted(items.length - shown.length, "blocks");
  };
  const files = parts.files?.slice(0, 60);
  const table = files?.length ? '<table><thead><tr><th>File</th><th>Added</th><th>Removed</th></tr></thead><tbody>'
    + files.map(file => `<tr><td>${html(file.path, 300)}</td><td>${html(String(file.added ?? "binary"), 64)}</td><td>${html(String(file.removed ?? "binary"), 64)}</td></tr>`).join("")
    + "</tbody></table>" + omitted(parts.files!.length - files.length, "files") : files ? "<p>No code written yet.</p>" : "<p>Diff unavailable.</p>";
  const gates = parts.gates.slice(0, 100);
  const failures = gates.filter(gate => gate.outcome === "failed").length;
  const tailBudget = Math.floor(35_000 / Math.max(1, failures));
  const gateHtml = gates.map(gate => `<section><span class="chip ${{ passed: "ok", failed: "bad", skipped: "muted" }[gate.outcome]}">${html(gate.name, 160)}: ${gate.outcome}</span>`
    + (gate.outcome === "failed" ? `<pre>${html(gate.tail ?? "No log recorded.", tailBudget, true)}</pre>` : "") + "</section>").join("\n")
    + omitted(parts.gates.length - gates.length, "gates");
  const reviewHtml = blocks(parts.review, 25_000);
  return [
    `<h1>${html(parts.title, 4_000)}</h1>`,
    `<p>${html(parts.breadcrumb, 8_000)}</p>`,
    `<p class="lede">${html(parts.outcome, 4_000)}</p>`,
    `<section class="recap"><dl><dt>Now</dt><dd>${html(parts.outcome, 4_000)}</dd>`,
    `<dt>Done</dt><dd>${html(parts.done.join(", ") || "No stages passed.", 4_000)}</dd>`,
    `<dt>Decided</dt><dd>${html(parts.decided, 8_000)}</dd>`,
    `<dt>Needs</dt><dd>${html(parts.needs, 4_000)}</dd></dl></section>`,
    `${files?.length ? "<h2>Files changed</h2>" : ""}${table}`,
    ...(gates.length ? [`<h2>Gates</h2>${gateHtml}`] : []),
    ...(reviewHtml ? [`<h2>Review verdict</h2>${reviewHtml}`] : []),
    blocks(parts.evidence, 40_000),
  ].join("\n");
}
