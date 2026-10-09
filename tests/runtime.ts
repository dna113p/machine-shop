// Test-only checkout fallback; distributed definitions use public runtime types.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

let location: string;
try { location = import.meta.resolve("@dna113p/machines"); }
catch (error) {
  const source = resolve(import.meta.dirname, "../../machines/src/index.ts");
  if (!existsSync(source)) throw error;
  location = pathToFileURL(source).href;
}
export const runtime: typeof import("@dna113p/machines") = await import(location);
export const launcher = await import(location.endsWith(".ts")
  ? new URL("launcher.ts", location).href
  : import.meta.resolve("@dna113p/machines/launcher"));
export const runtimeLocation = location;
