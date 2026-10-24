/** Match worktree-relative paths without consulting the filesystem. */
export function matchesScope(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const normalized = pattern.replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (!normalized) return false;
    if (!/[*?]/u.test(normalized)) return path === normalized || path.startsWith(`${normalized}/`);
    const segments = normalized.split("/");
    const paths = path.split("/");
    const match = (at: number, part: number): boolean => {
      if (at === segments.length) return part === paths.length;
      const segment = segments[at]!;
      if (segment === "**") return match(at + 1, part) || (part < paths.length && match(at, part + 1));
      const expression = [...segment].map(char => char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")).join("");
      return part < paths.length && new RegExp(`^${expression}$`, "u").test(paths[part]!) && match(at + 1, part + 1);
    };
    return match(0, 0);
  });
}

export function outsideScope(paths: string[], patterns: string[]): string[] {
  return paths.filter(path => !matchesScope(path, patterns));
}

/** Only path-like Forbidden entries are mechanical rules; prose remains prompt guidance. */
export function forbiddenPatterns(bullets: string[]): string[] {
  return [...new Set(bullets.flatMap(bullet => {
    const spans = [...bullet.matchAll(/`([^`]+)`/gu)].map(match => match[1]!);
    if (spans.length) return spans.filter(value => /[/.*]/u.test(value));
    const value = bullet.trim();
    return !/\s/u.test(value) && /[/.*]/u.test(value) ? [value] : [];
  }))];
}

/** A bare filename protects that file at every depth; qualified globs stay rooted. */
export function matchesForbidden(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => matchesScope(path, [pattern, ...(!pattern.includes("/") ? [`**/${pattern}`] : [])]));
}
