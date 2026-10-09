import type { Event, MachinePrimitives } from "@dna113p/machines";
import type { ChatGptWebContinueRunner } from "@dna113p/machines/chatgpt-web";

export const description = "Keeps one ChatGPT web chat going: starts or adopts a conversation, then sends each Human reply to it until done.";
export const agentRoles = {
  "chatgpt-web": "Starts the fresh ChatGPT web chat that works in the launch directory through rig-bridge",
};

export default function chatGptThread(
  { agent, final, human, machine, operation }: MachinePrimitives,
  input: unknown,
  send: ChatGptWebContinueRunner = continueInBrowser,
) {
  const task = typeof input === "string" ? input.trim() : "";
  if (task === "") {
    throw new Error("chatgpt-thread requires a task description or a ChatGPT conversation URL");
  }

  const directory = process.cwd();
  const adopted = conversationUrl(task);
  let conversation = adopted ?? "";
  let threadId: string | undefined;
  let latest: { reason: string; summary: string } | undefined;
  let reply = "";
  let failure = "";

  const started = {
    target: "reply",
    actions: ({ event }: { event: Event }) => {
      const url = conversationUrl(event.conversation);
      if (url === undefined) {
        throw new Error(`chatgpt-thread cannot continue: the chatgpt-web Agent returned "${event.type}" without a ChatGPT conversation URL`);
      }
      conversation = url;
      threadId = handoffThread(event);
      latest = handoff(event);
    },
  };

  return machine({
    initial: adopted === undefined ? "start" : "reply",
    output: () => ({ conversation, reason: latest?.reason ?? null, summary: latest?.summary ?? null }),
    states: {
      start: agent(
        task,
        { completed: started, needs_input: started, blocked: started, failed: started },
        { cwd: directory, using: "chatgpt-web" },
      ),

      reply: human(
        () => [
          ...(failure === ""
            ? []
            : [
              `The last reply did not go through: ${failure}`,
              "It was not sent again. Check the conversation before retrying. The unsent or uncertain reply was:",
              quote(reply),
              "",
            ]),
          latest === undefined
            ? "The chat is paired and waiting for a message."
            : `ChatGPT handed off (${latest.reason}): ${latest.summary}`,
          `Conversation: ${conversation}`,
          'Enter "done" to finish, or type a reply to send to the chat.',
        ].join("\n"),
        {
          submitted: [
            {
              guard: ({ event }) => response(event).trim().toLowerCase() === "done",
              target: "done",
            },
            {
              actions: ({ event }) => {
                reply = response(event);
              },
              target: "send",
            },
          ],
        },
        { suggestions: ["done"] },
      ),

      // One attempt per Human reply: a failure goes back to the Human and is never retried here.
      send: operation(
        async () => {
          try {
            const next = await send({
              conversation,
              text: reply,
              cwd: directory,
              ...(threadId === undefined ? {} : { bridgeThreadId: threadId }),
            });
            latest = handoff(next);
            // An adopted chat learns its rig-bridge thread from the first handoff; a handoff without one keeps the saved id.
            threadId = handoffThread(next) ?? threadId;
            failure = "";
            return { type: "sent" };
          } catch (cause) {
            failure = cause instanceof Error ? cause.message : String(cause);
            return { type: "unsent" };
          }
        },
        { sent: "reply", unsent: "reply" },
      ),

      done: final(),
    },
  });
}

// Loaded on first use so the Machine can be described, adopted, and tested without the browser runner.
const continueInBrowser: ChatGptWebContinueRunner = async (message) => {
  let runner: typeof import("@dna113p/machines/chatgpt-web");
  try {
    runner = await import("@dna113p/machines/chatgpt-web");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not load @dna113p/machines/chatgpt-web beside this definition (${reason}); the message was not sent`, { cause });
  }
  if (typeof runner.chatGptWebContinue !== "function") {
    throw new Error("the installed @dna113p/machines does not export chatGptWebContinue; the message was not sent");
  }
  return runner.chatGptWebContinue({ output: "capture" })(message);
};

function conversationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || /\s/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:"
    && url.host === "chatgpt.com"
    && url.username === ""
    && url.password === ""
    && /\/c\/[\w-]+/u.test(url.pathname)
    ? url.href
    : undefined;
}

function handoff(event: Event): { reason: string; summary: string } {
  const reported = record(event.handoff);
  const summary = [reported.summary, event.summary].find((value) => typeof value === "string" && value.trim() !== "");
  return {
    reason: typeof reported.reason === "string" && reported.reason !== "" ? reported.reason : event.type,
    summary: typeof summary === "string" ? summary : "(no summary)",
  };
}

function handoffThread(event: Event): string | undefined {
  const { threadId } = record(event.handoff);
  return typeof threadId === "string" && threadId !== "" ? threadId : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" ? value as Readonly<Record<string, unknown>> : {};
}

function quote(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
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
  throw new Error("Human reply returned invalid input");
}
