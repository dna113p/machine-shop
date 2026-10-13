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
