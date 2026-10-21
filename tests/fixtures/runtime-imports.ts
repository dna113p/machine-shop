// Extend the test harness's checkout fallback to imports inside workflow definitions.
// Production definitions continue to import the public package unchanged.
import { registerHooks } from "node:module";
import { runtimeLocation } from "../runtime.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@dna113p/machines") return { url: runtimeLocation, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
