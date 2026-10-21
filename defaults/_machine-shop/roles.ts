import { stripTypeScriptTypes } from "node:module";

interface Token { kind: "word" | "string" | "literal" | "punctuation"; value: string }

/** Lex declarations without importing or evaluating the project's code. */
function tokens(source: string): Token[] {
  const javascript = stripTypeScriptTypes(source);
  let at = 0;
  const quoted = (quote: string): string => {
    at++;
    let value = "";
    while (at < javascript.length) {
      const char = javascript[at++]!;
      if (char === quote) return value;
      if (char !== "\\") { value += char; continue; }
      const escape = javascript[at++]!;
      if (escape === "\n") continue;
      if (escape === "\r") { if (javascript[at] === "\n") at++; continue; }
      if (escape === "u" || escape === "x") {
        const braced = escape === "u" && javascript[at] === "{";
        if (braced) at++;
        const end = braced ? javascript.indexOf("}", at) : at + (escape === "u" ? 4 : 2);
        value += String.fromCodePoint(Number.parseInt(javascript.slice(at, end), 16));
        at = end + (braced ? 1 : 0);
      } else {
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
        value += escapes[escape] ?? escape;
      }
    }
    throw new Error("Unterminated string in Machine declaration");
  };
  const scan = (closing?: string): Token[] => {
    const result: Token[] = [];
    let expressionStart = true;
    while (at < javascript.length) {
      const char = javascript[at]!;
      if (/\s/u.test(char)) { at++; continue; }
      if (javascript.startsWith("//", at) || (at === 0 && javascript.startsWith("#!"))) {
        while (at < javascript.length && !/[\n\r\u2028\u2029]/u.test(javascript[at]!)) at++;
        continue;
      }
      if (javascript.startsWith("/*", at)) { at = javascript.indexOf("*/", at + 2) + 2; continue; }
      if (char === closing) { at++; return result; }
      if (char === '"' || char === "'") {
        result.push({ kind: "string", value: quoted(char) }); expressionStart = false; continue;
      }
      if (char === "`") {
        at++;
        while (at < javascript.length) {
          if (javascript[at] === "\\") { at += 2; continue; }
          if (javascript[at] === "`") { at++; break; }
          if (javascript.startsWith("${", at)) { at += 2; scan("}"); }
          else at++;
        }
        result.push({ kind: "literal", value: "template" }); expressionStart = false; continue;
      }
      if (char === "/" && expressionStart) {
        at++;
        let inClass = false;
        while (at < javascript.length) {
          const part = javascript[at++]!;
          if (part === "\\") { at++; continue; }
          if (part === "[") inClass = true;
          if (part === "]") inClass = false;
          if (part === "/" && !inClass) break;
        }
        while (/[a-z]/iu.test(javascript[at] ?? "")) at++;
        result.push({ kind: "literal", value: "regexp" }); expressionStart = false; continue;
      }
      const word = javascript.slice(at).match(/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*/u)?.[0];
      if (word) {
        at += word.length; result.push({ kind: "word", value: word });
        expressionStart = ["return", "throw", "case", "void", "typeof", "delete", "yield", "await", "in", "of"].includes(word);
        continue;
      }
      at++;
      result.push({ kind: "punctuation", value: char });
      if (char === "{" || char === "(" || char === "[") {
        const end = char === "{" ? "}" : char === "(" ? ")" : "]";
        result.push(...scan(end), { kind: "punctuation", value: end });
        expressionStart = false;
      } else expressionStart = !/[\d.]/u.test(char);
    }
    return result;
  };
  return scan();
}

/** Read the property declarations of a literal agentRoles export, never its descriptions. */
export function declaredRoles(source: string): string[] {
  const lexed = tokens(source);
  const is = (index: number, value: string) => lexed[index]?.value === value && lexed[index]?.kind !== "string" && lexed[index]?.kind !== "literal";
  let depth = 0;
  for (let index = 0; index < lexed.length; index++) {
    if (depth === 0 && is(index, "export") && is(index + 1, "const") && is(index + 2, "agentRoles") && is(index + 3, "=")) {
      let cursor = index + 4;
      if (!is(cursor++, "{")) throw new Error("Cannot inventory agentRoles: expected an object literal");
      const names = new Set<string>();
      while (!is(cursor, "}")) {
        const key = lexed[cursor++];
        if (!key || !["word", "string"].includes(key.kind) || !is(cursor++, ":")) {
          throw new Error("Cannot inventory agentRoles: expected a named property declaration");
        }
        names.add(key.value);
        let nesting = 0;
        while (cursor < lexed.length) {
          const token = lexed[cursor]!;
          if (token.kind === "punctuation") {
            if (nesting === 0 && [",", "}"].includes(token.value)) break;
            if (["{", "(", "["].includes(token.value)) nesting++;
            if (["}", ")", "]"].includes(token.value)) nesting--;
          }
          cursor++;
        }
        if (is(cursor, ",")) cursor++;
        else if (!is(cursor, "}")) throw new Error("Cannot inventory agentRoles: unterminated object literal");
      }
      return [...names];
    }
    if (lexed[index]?.kind === "punctuation") {
      if (["{", "(", "["].includes(lexed[index]!.value)) depth++;
      if (["}", ")", "]"].includes(lexed[index]!.value)) depth--;
    }
  }
  return [];
}
