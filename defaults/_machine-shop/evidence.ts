import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Stop {
  id: string;
  key: string;
  run: string;
  workspace: string;
  ticket: string;
  workflow: string;
  stage: string;
  reason: string;
  at: string;
  question: string | null;
  answers: string[];
  recommendations: unknown[];
  locations: string[];
  repository: unknown;
}
export interface Reading {
  stops: Stop[];
  notEnded: string[];
  unreadable: string[];
  outcomes: Record<string, number>;
  stopsByStage: Record<string, number>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const line = (value: string) => value.replace(/\s+/gu, " ").trim();
const numbered = (a: string, b: string) => Number(a.match(/\d+/u)?.[0]) - Number(b.match(/\d+/u)?.[0]);

function safeDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe evidence directory: ${path}`);
}

// Shared with retrospective. Keep its ticket-stop interpretation;
// audit additionally needs outcome totals and evidence from other workflows.
export function readEvidence(workspaces: string[], own: string, since: number, until: number, allWorkflows = false): Reading {
  const reading: Reading = { stops: [], notEnded: [], unreadable: [], outcomes: {}, stopsByStage: {} };
  const inWindow = (time: number) => time >= since && time <= until;
  for (const workspace of workspaces) {
    const root = join(workspace, ".machine-runs", "machine-shop");
    let directories: string[];
    try {
      safeDirectory(join(workspace, ".machine-runs"));
      safeDirectory(root);
      directories = readdirSync(root).sort();
    } catch (error) {
      reading.unreadable.push(`${root}: ${message(error)}`);
      continue;
    }
    for (const run of directories) {
      const folder = join(root, run);
      if (folder === own) continue;
      const label = `${run} (${workspace})`;
      try {
        const stat = lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const read = (name: string) => {
          const path = join(folder, name);
          const info = lstatSync(path);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name}: not a regular evidence file`);
          return { body: readFileSync(path, "utf8"), time: info.mtimeMs };
        };
        const json = (name: string) => {
          const file = read(name);
          try { return { value: JSON.parse(file.body) as unknown, time: file.time }; }
          catch { throw new Error(`${name}: invalid JSON`); }
        };
        const started = json("started.json").value;
        if (!object(started) || !text(started.workflow) || !text(started.startedAt) || !Number.isFinite(Date.parse(started.startedAt))) throw new Error("started.json: invalid run metadata");
        if (!allWorkflows && started.workflow !== "ticket-task") continue;
        const names = readdirSync(folder).sort();
        // Validate all present JSON stage reports, without following paths they contain.
        const records = new Map<string, { value: unknown; time: number }>();
        for (const name of names.filter(name => name.endsWith(".json"))) records.set(name, json(name));
        const result = records.get("result.json")?.value;
        if (result !== undefined && (!object(result) || !text(result.outcome) || !text(result.finishedAt)
          || !Number.isFinite(Date.parse(result.finishedAt)) || typeof result.reason !== "string")) throw new Error("result.json: invalid ending metadata");
        const ending = result as { outcome: string; finishedAt: string; reason: string } | undefined;
        if (ending && inWindow(Date.parse(ending.finishedAt))) reading.outcomes[ending.outcome] = (reading.outcomes[ending.outcome] ?? 0) + 1;
        // Sort each numbered kind separately: unnumbered metadata must not interrupt numeric ordering.
        const answers = names.filter(name => /^human-\d+\.json$/u.test(name)).sort(numbered).flatMap(name => {
          const answer = records.get(name)!.value;
          if (!object(answer) || !text(answer.stage) || typeof answer.response !== "string") throw new Error(`${name}: invalid Human answer`);
          return answer.stage === "decide" ? [answer.response] : [];
        });
        const questions = names.filter(name => /^question-\d+\.txt$/u.test(name)).sort(numbered).map(name => ({ name, ...read(name) }));
        if (questions.length && answers.length > questions.length) throw new Error("More decide answers than question files");
        const falsify = names.filter(name => /^falsify-\d+\.json$/u.test(name)).sort(numbered).map(name => records.get(name)!);
        const delivery = records.get("delivery.json")?.value;
        const recordedTicket = object(delivery) ? (text(delivery.ticket) ? delivery.ticket
          : object(delivery.ticket) && text(delivery.ticket.id) ? delivery.ticket.id : undefined) : undefined;
        const ticket = questions.map(question => question.body.match(/^Ticket (\S+)\. Stopped in /mu)?.[1] ?? question.body.match(/\bTicket\s+([^\s:]+)(?=:| is stuck)/u)?.[1]).find(Boolean)
          ?? recordedTicket ?? "unknown (not recorded)";
        const runStops: Stop[] = [];
        const add = (suffix: string, body: string | null, reason: string, at: number, ownerAnswers: string[], stage: string) => {
          if (!inWindow(at)) return;
          const recent = falsify.filter(file => file.time <= at).sort((a, b) => a.time - b.time).at(-1)?.value;
          const recommendations = object(recent) && Array.isArray(recent.questions) ? recent.questions.flatMap(value =>
            object(value) && text(value.text) && text(value.recommended) ? [{ text: value.text, recommended: value.recommended }] : []) : [];
          const evidence = [body ?? "", reason, ...[...records.values()].filter(file => file.time <= at).map(file => JSON.stringify(file.value))].join("\n");
          const normalized = line(reason.split(/\.(?:\s|$)|\n/u)[0]!).replace(/\s*\(\d+\)/gu, "").replace(/\d+/gu, "#").toLowerCase()
            .replace(/\bopen questions?\b/gu, "open question")
            .replace(/^answer # open question (?:before any code is written|the reviewer raised)$/u, "ticket owner must settle # open question:")
            .replace(/^(repair|review) budget used up.*$/u, "$1 budget exhausted")
            .replace(/^the falsify report's questions were missing or malformed twice:/u, "the falsify report was malformed twice:");
          runStops.push({
            id: `${workspace}/${run}/${suffix}`, key: JSON.stringify([started.workflow, stage, normalized]), run, workspace,
            ticket,
            workflow: started.workflow as string, stage, reason, at: new Date(at).toISOString(), question: body,
            answers: ownerAnswers, recommendations,
            locations: [...new Set(evidence.match(/[\w./-]+\.[\w-]+:\d+(?::\d+)?/gu) ?? [])],
            repository: object(delivery) ? delivery.repository ?? null : null,
          });
        };
        for (const [index, question] of questions.entries()) {
          const first = question.body.split(/\r?\n/u)[0]!.trim();
          const needs = question.body.match(/\nNeeds: ([\s\S]*?)(?=\nWorktree: |$)/u)?.[1]?.trim() ?? "";
          const fullReason = first.startsWith("Discard the candidate") || (first.endsWith("…") && needs.startsWith(first.slice(0, -1)))
            ? needs : [first, needs].filter(Boolean).join("\n");
          const reason = question.body.match(/This run is stuck and needs a decision:\s*([\s\S]*?)(?:\n\s*Needs:|$)/u)?.[1]?.trim()
            ?? fullReason;
          const stage = question.body.match(/Stopped in ([\w-]+)\./u)?.[1] ?? "unknown (not recorded)";
          add(question.name, question.body, reason, question.time, answers[index] === undefined ? [] : [answers[index]!], stage);
        }
        // Older runs did not save questions. Their ending and answers describe one stop, not two.
        if (!questions.length && answers.length && ending) {
          add("legacy", null, ending.reason || answers.join("; "), Date.parse(ending.finishedAt), answers, "unknown (not recorded)");
        } else if (ending && ["blocked", "failed"].includes(ending.outcome)) {
          const stage = questions.at(-1)?.body.match(/Stopped in ([\w-]+)\./u)?.[1] ?? "unknown (not recorded)";
          add("result", null, ending.reason || `Run ended ${ending.outcome}`, Date.parse(ending.finishedAt), [], stage);
        }
        if (!ending && (runStops.length || (!questions.length && answers.length))) {
          reading.notEnded.push(`${label}: no result.json; the evidence does not distinguish waiting, running or crashed${!questions.length ? "; no question text or ending time is available" : ""}`);
        }
        reading.stops.push(...runStops);
        for (const stop of runStops) reading.stopsByStage[stop.stage] = (reading.stopsByStage[stop.stage] ?? 0) + 1;
      } catch (error) {
        reading.unreadable.push(`${label}: ${message(error)}`);
      }
    }
  }
  return reading;
}

