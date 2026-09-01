import type { MachinePrimitives } from "../machines/src/index.ts";

export default function implementReview(
  { agent, final, human, machine }: MachinePrimitives,
  input: string,
) {
  const task = input.trim();
  if (task === "") throw new Error("implement-review requires a task description");

  const directory = process.cwd();
  let feedback = "";

  return machine({
    initial: "implement",
    states: {
      implement: agent(
        () => feedback === ""
          ? [
            `Implement this task: ${task}`,
            "Work directly in the current directory and run the relevant checks.",
          ].join("\n")
          : [
            `Continue this task: ${task}`,
            "Address this review feedback:",
            feedback,
            "Run the relevant checks.",
          ].join("\n"),
        { completed: "humanReview" },
        { cwd: directory },
      ),

      humanReview: human(
        () => [
          `Review the implementation in ${directory}.`,
          'Enter "approve" to finish, or type feedback for another Agent pass.',
        ].join("\n"),
        {
          submitted: [
            {
              guard: ({ event }) => response(event).trim().toLowerCase() === "approve",
              target: "done",
            },
            {
              actions: ({ event }) => {
                feedback = response(event);
              },
              target: "implement",
            },
          ],
        },
        { suggestions: ["approve"] },
      ),

      done: final(),
    },
  });
}

function response(event: unknown): string {
  if (
    event !== null
    && typeof event === "object"
    && "value" in event
    && typeof event.value === "string"
  ) {
    return event.value;
  }
  throw new Error("Human review returned invalid input");
}
