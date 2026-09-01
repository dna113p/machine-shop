import type { MachinePrimitives } from "../machines/src/index.ts";

export const description = "Prints an input through one Operation as a quick runtime check.";

export default function smoke(
  { final, machine, operation }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "run",
    states: {
      run: operation(
        () => {
          console.log(input || "Dev Machines is connected.");
          return { type: "completed" };
        },
        { completed: "done" },
      ),
      done: final(),
    },
  });
}
