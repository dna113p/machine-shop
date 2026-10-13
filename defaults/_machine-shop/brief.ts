interface Parts {
  decision: string;
  standing: string;
  changed?: string;
  evidence: string[];
  needs?: string;
  options?: { name: string; does: string; recommended?: boolean }[];
}

/** A decision first, followed by the context and choices needed to answer it. */
export function brief(parts: Parts): string {
  const words = parts.decision.trim().split(/\s+/u);
  const decision = words.slice(0, 10).join(" ") + (words.length > 10 ? "…" : "");
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
