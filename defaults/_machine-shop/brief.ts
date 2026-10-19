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
