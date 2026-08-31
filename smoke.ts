import type { MachinePrimitives } from "../machines/src/index.ts";

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
