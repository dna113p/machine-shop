import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesScope, outsideScope } from "../defaults/_machine-shop/scope.ts";

for (const [pattern, yes, no] of [
  ["src/**/a.ts", ["src/a.ts", "src/deep/more/a.ts"], ["src/a.js", "other/a.ts"]],
  ["**", ["a.ts", "src/deep/a.ts"], []],
  ["src/**", ["src", "src/a.ts", "src/deep/a.ts"], ["src2/a.ts"]],
  ["*.ts", ["a.ts", ".ts"], ["src/a.ts", "a.tsx"]],
  ["src/a?.ts", ["src/ab.ts"], ["src/a.ts", "src/abc.ts", "src/a/b.ts"]],
  ["a.ts", ["a.ts"], ["ba.ts", "a.tsx", "src/a.ts"]],
  ["src", ["src", "src/a.ts", "src/deep/a.ts"], ["src2/a.ts"]],
  ["src/", ["src", "src/a.ts"], ["src2/a.ts"]],
  ["./src/*.ts", ["src/a.ts"], ["src/deep/a.ts"]],
  ["./src", ["src/a.ts"], ["other/a.ts"]],
  ["a[1]+(x){y}.$^|\\*.ts", ["a[1]+(x){y}.$^|\\file.ts"], ["a1xfile.ts"]],
] as const) {
  test(`scope pattern ${pattern} follows literal and glob rules`, () => {
    for (const path of yes) assert.equal(matchesScope(path, [pattern]), true, path);
    for (const path of no) assert.equal(matchesScope(path, [pattern]), false, path);
  });
}

test("outsideScope preserves paths outside all patterns in input order", () => {
  assert.deepEqual(outsideScope(["z.txt", "src/a.ts", "README.md", "other/a.ts"], ["src/**", "README.md"]), ["z.txt", "other/a.ts"]);
  assert.deepEqual(outsideScope(["a"], []), ["a"]);
  assert.equal(matchesScope("anything", [""]), false);
});
