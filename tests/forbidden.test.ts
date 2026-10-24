import assert from "node:assert/strict";
import { test } from "node:test";
import { forbiddenPatterns, matchesForbidden } from "../defaults/_machine-shop/scope.ts";

// The Forbidden section of about 75 of 173 tickets is prose such as "nothing beyond the scope above": only path-like entries are a wall.
test("forbiddenPatterns takes a bullet that is itself a path or glob, and backticked spans holding '/', '.' or '*'; prose stays text", () => {
  const bullets = [
    "nothing beyond the scope above",
    "Anything outside the paths under Scope",
    "Removing or weakening the `careful` map.",
    "Merging, pushing to a base branch, or any landing-step change.",
    "Any change to `land.mjs`, Dispatch, or workspace adapters.",
    "secrets/**",
    "README.md",
    "Edits to `generated/**` or `dist/*.js`",
  ];
  assert.deepEqual([...forbiddenPatterns(bullets)].sort(), ["README.md", "dist/*.js", "generated/**", "land.mjs", "secrets/**"]);
  assert.deepEqual(forbiddenPatterns(["nothing beyond the scope above"]), []);
  assert.deepEqual(forbiddenPatterns([]), []);
});

test("matchesForbidden uses Scope globs, and a pattern without '/' matches a file of that name at any depth", () => {
  for (const [path, patterns] of [
    ["land.mjs", ["land.mjs"]], ["scripts/land.mjs", ["land.mjs"]], ["secrets/a/b.txt", ["secrets/**"]], ["dist/app.js", ["dist/*.js"]],
  ] as const) assert.equal(matchesForbidden(path, [...patterns]), true, `${path} against ${patterns.join(", ")}`);
  for (const [path, patterns] of [
    ["land.mjs.bak", ["land.mjs"]], ["docs/secrets/a.txt", ["secrets/**"]], ["dist/deep/app.js", ["dist/*.js"]], ["notes.txt", []],
  ] as const) assert.equal(matchesForbidden(path, [...patterns]), false, `${path} against ${patterns.join(", ")}`);
});

test("forbiddenPatterns preserves spaces within a backticked literal path", () => {
  const patterns = forbiddenPatterns(["Do not change `docs/private notes.md`"]);
  assert.deepEqual(patterns, ["docs/private notes.md"]);
  assert.equal(matchesForbidden("docs/private notes.md", patterns), true);
});
