import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { launcher, runtime } from "./runtime.ts";
import chatGptThread, { agentRoles, description } from "../chatgpt-thread.ts";

const conversation = "https://chatgpt.com/c/6a0b1c2d-thread";
const outcomes = ["completed", "needs_input", "blocked", "failed"];
type Ask = { prompt: string; choices?: readonly string[]; suggestions?: readonly string[] };
type Sent = { conversation: string; text: string; cwd: string; bridgeThreadId?: string };
const handoff = (reason: string, summary: string, threadId = "thread-1") => ({
  type: reason, summary, conversation,
  handoff: { id: `handoff-${summary.length}`, projectId: "project-1", threadId, reason, summary, createdAt: 1 },
});

/** Answers Human requests in order and keeps what each one showed; one more request than answers fails the run. */
function person(...answers: (string | (() => string))[]) {
  const requests: Ask[] = [];
  return Object.assign((request: Ask) => {
    requests.push(request);
    const next = answers.shift();
    if (next === undefined) throw new Error("Unexpected Human request");
    return typeof next === "string" ? next : next();
  }, { requests });
}
/** Stands in for the browser: records every message and answers each with the next result, throwing the Errors. */
function browser(...results: (ReturnType<typeof handoff> | Error)[]) {
  const sent: Sent[] = [];
  return Object.assign(async (message: Sent) => {
    sent.push(message);
    const next = results.shift();
    if (next === undefined) throw new Error("Unexpected continuation");
    if (next instanceof Error) throw next;
    return next;
  }, { sent });
}
async function execute(input: unknown, options: { agent?: (request: any) => unknown; human?: ReturnType<typeof person>; send?: ReturnType<typeof browser> } = {}) {
  const human = options.human ?? person();
  const send = options.send ?? browser();
  const requests: { prompt: string; outcomes: readonly string[]; cwd?: string }[] = [];
  const states: string[] = [];
  const result = await runtime.run(chatGptThread(runtime, input, send), {
    agents: {
      "chatgpt-web": (request: { prompt: string; outcomes: readonly string[]; cwd?: string }) => {
        requests.push(request);
        if (options.agent === undefined) throw new Error("Unexpected Agent request");
        return options.agent(request) as { type: string };
      },
    },
    human, onState: state => states.push(String(state)),
  });
  return { state: result.value, output: result.output as any, states, requests, asked: human.requests, sent: send.sent };
}

test("a fresh task starts one chat and sends each Human reply to it until done", async () => {
  const second = "  Keep the port,\nbut add a flag.  ";
  const run = await execute("  Add a health endpoint  ", {
    agent: () => handoff("needs_input", "Which port should it listen on?"),
    human: person("Use 8080", second, "  DONE \n"),
    send: browser(handoff("blocked", "The port is taken"), handoff("completed", "Endpoint added with a --port flag")),
  });

  assert.equal(run.state, "done");
  assert.deepEqual(run.states, ["start", "reply", "send", "reply", "send", "reply", "done"]);
  assert.deepEqual(run.requests, [{ prompt: "Add a health endpoint", outcomes, cwd: process.cwd() }]);
  assert.deepEqual(run.sent, [
    { conversation, text: "Use 8080", cwd: process.cwd(), bridgeThreadId: "thread-1" },
    { conversation, text: second, cwd: process.cwd(), bridgeThreadId: "thread-1" },
  ]);
  assert.equal(run.asked.length, 3);
  for (const [index, shown] of ["(needs_input): Which port should it listen on?", "(blocked): The port is taken", "(completed): Endpoint added with a --port flag"].entries()) {
    const request = run.asked[index]!;
    assert.ok(request.prompt.includes(shown), request.prompt);
    assert.ok(request.prompt.includes(`Conversation: ${conversation}`));
    assert.doesNotMatch(request.prompt, /did not go through/u);
    assert.deepEqual(request.suggestions, ["done"]); assert.equal(request.choices, undefined);
  }
  assert.deepEqual(run.output, { conversation, reason: "completed", summary: "Endpoint added with a --port flag" });
});

test("every Agent outcome keeps the conversation and continues to the Human", async () => {
  for (const outcome of outcomes) {
    const run = await execute("Add a health endpoint", { agent: () => handoff(outcome, `Stopped as ${outcome}`), human: person("done") });
    assert.deepEqual(run.states, ["start", "reply", "done"]);
    assert.deepEqual(run.output, { conversation, reason: outcome, summary: `Stopped as ${outcome}` });
    assert.deepEqual(run.sent, []);
  }
});

test("a task without a rig-bridge handoff shows the event and sends without a thread id", async () => {
  const run = await execute("Add a health endpoint", {
    agent: () => ({ type: "completed", summary: "Endpoint added", conversation }),
    human: person("Thanks, now document it", "done"),
    send: browser(handoff("completed", "Documented")),
  });
  assert.ok(run.asked[0]!.prompt.includes("(completed): Endpoint added"));
  assert.deepEqual(run.sent, [{ conversation, text: "Thanks, now document it", cwd: process.cwd() }]);
});

test("an adopted conversation URL goes straight to the Human and sends the first reply", async () => {
  const project = "https://chatgpt.com/g/g-p-widgets/c/6a0b1c2d-thread";
  const run = await execute(`  ${project}\n`, {
    human: person("Continue with the next step", "Done"),
    send: browser({ ...handoff("needs_input", "Which step is next?", "thread-9"), conversation: project }),
  });

  assert.equal(run.state, "done");
  assert.deepEqual(run.states, ["reply", "send", "reply", "done"]);
  assert.deepEqual(run.requests, []);
  assert.deepEqual(run.sent, [{ conversation: project, text: "Continue with the next step", cwd: process.cwd() }]);
  assert.match(run.asked[0]!.prompt, /paired and waiting for a message/u);
  assert.ok(run.asked[0]!.prompt.includes(`Conversation: ${project}`));
  assert.deepEqual(run.asked[0]!.suggestions, ["done"]);
  assert.ok(run.asked[1]!.prompt.includes("(needs_input): Which step is next?"));
  assert.doesNotMatch(run.asked[1]!.prompt, /paired and waiting/u);
  assert.deepEqual(run.output, { conversation: project, reason: "needs_input", summary: "Which step is next?" });
});

test("the rig-bridge thread id returned by a continuation is saved for the replies that follow", async () => {
  const adopted = await execute(conversation, {
    human: person("First", "Second", "Third", "done"),
    send: browser(
      handoff("needs_input", "Which step is next?", "thread-9"),
      { type: "completed", summary: "No handoff this time", conversation },
      handoff("completed", "Finished"),
    ),
  });
  assert.deepEqual(adopted.states, ["reply", "send", "reply", "send", "reply", "send", "reply", "done"]);
  // The first reply has no thread yet; a continuation without a handoff keeps the saved one.
  assert.deepEqual(adopted.sent, [
    { conversation, text: "First", cwd: process.cwd() },
    { conversation, text: "Second", cwd: process.cwd(), bridgeThreadId: "thread-9" },
    { conversation, text: "Third", cwd: process.cwd(), bridgeThreadId: "thread-9" },
  ]);

  const moved = await execute("Add a health endpoint", {
    agent: () => handoff("needs_input", "Which port?"),
    human: person("Use 8080", "Now document it", "done"),
    send: browser(handoff("blocked", "The port is taken", "thread-2"), handoff("completed", "Documented", "thread-2")),
  });
  assert.deepEqual(moved.sent.map(message => message.bridgeThreadId), ["thread-1", "thread-2"]);
});

test("an adopted conversation ended at once sends nothing and reports no handoff", async () => {
  const run = await execute(conversation, { human: person("done") });
  assert.deepEqual(run.states, ["reply", "done"]);
  assert.deepEqual(run.sent, []);
  assert.deepEqual(run.output, { conversation, reason: null, summary: null });
});

test("only an https chatgpt.com conversation URL is adopted; anything else is a task", async () => {
  for (const task of [
    "http://chatgpt.com/c/6a0b1c2d-thread",
    "https://chatgpt.com/",
    "https://example.invalid/c/6a0b1c2d-thread",
    "https://user:secret@chatgpt.com/c/6a0b1c2d-thread",
    `${conversation} summarize this chat`,
  ]) {
    const run = await execute(task, { agent: () => handoff("completed", "Handled as a task"), human: person("done") });
    assert.deepEqual(run.requests.map(request => request.prompt), [task]);
    assert.deepEqual(run.states, ["start", "reply", "done"]);
  }
});

test("a failed continuation returns to the Human with the error and the reply, and is not resent", async () => {
  const reply = "Rename the flag\nand rerun the tests";
  const failure = "ChatGPT Web continuation failed for the conversation: delivery of the message is uncertain";
  const send = browser(new Error(failure), handoff("completed", "Flag renamed"));
  const human = person(reply, () => {
    // The failed reply is back with the Human and has been attempted exactly once.
    assert.equal(send.sent.length, 1);
    return "I checked the chat: it did not arrive. Rename the flag.";
  }, "done");
  const run = await execute("Add a health endpoint", {
    agent: () => handoff("needs_input", "Which flag name?"),
    human, send,
  });

  assert.equal(run.state, "done");
  assert.deepEqual(run.states, ["start", "reply", "send", "reply", "send", "reply", "done"]);
  const failed = run.asked[1]!.prompt;
  assert.ok(failed.includes(failure), failed);
  assert.ok(failed.includes("> Rename the flag\n> and rerun the tests"), failed);
  assert.match(failed, /not sent again/u);
  // The standing handoff and the conversation are still shown, and the way out is still offered.
  assert.ok(failed.includes("(needs_input): Which flag name?"));
  assert.ok(failed.includes(`Conversation: ${conversation}`));
  assert.deepEqual(run.asked[1]!.suggestions, ["done"]);
  assert.deepEqual(run.sent.map(message => message.text), [reply, "I checked the chat: it did not arrive. Rename the flag."]);
  // A later success clears the error.
  assert.doesNotMatch(run.asked[2]!.prompt, /did not go through/u);
  assert.ok(run.asked[2]!.prompt.includes("(completed): Flag renamed"));
  assert.deepEqual(run.output, { conversation, reason: "completed", summary: "Flag renamed" });
});

test("a failed continuation followed by done ends with the last good handoff and one attempt", async () => {
  const run = await execute(conversation, { human: person("Continue", "done"), send: browser(new Error("the composer already holds unsent text; the message was not sent")) });
  assert.deepEqual(run.states, ["reply", "send", "reply", "done"]);
  assert.equal(run.sent.length, 1);
  assert.ok(run.asked[1]!.prompt.includes("the composer already holds unsent text; the message was not sent"));
  assert.ok(run.asked[1]!.prompt.includes("> Continue"));
  assert.match(run.asked[1]!.prompt, /paired and waiting for a message/u);
  assert.deepEqual(run.output, { conversation, reason: null, summary: null });
});

test("an Agent event without a conversation URL fails the run before any Human request", async () => {
  for (const event of [
    { type: "completed", summary: "Finished without reporting a chat" },
    { type: "needs_input", summary: "Not a chat URL", conversation: "https://chatgpt.com/" },
    { type: "completed", summary: "Not a string", conversation: 7 },
  ]) {
    const human = person();
    const send = browser();
    await assert.rejects(
      execute("Add a health endpoint", { agent: () => event, human, send }),
      new RegExp(`chatgpt-web Agent returned "${event.type}" without a ChatGPT conversation URL`, "u"),
    );
    assert.deepEqual(human.requests, []);
    assert.deepEqual(send.sent, []);
  }
});

test("empty and non-text input is rejected before any state runs", () => {
  for (const input of ["", "  \n\t", undefined, null, 7, { task: "Add a health endpoint" }]) {
    assert.throws(() => chatGptThread(runtime, input, browser()), /requires a task description or a ChatGPT conversation URL/u);
  }
});

test("the definition launches by path with the built-in chatgpt-web Agent and no browser for an adopted chat", async context => {
  const home = mkdtempSync(join(tmpdir(), "dev-chatgpt-thread-test-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  assert.match(description, /\S/u); assert.doesNotMatch(description, /\n/u);
  assert.deepEqual(Object.keys(agentRoles), ["chatgpt-web"]);

  const prepared = await launcher.prepareMachineRun({ cwd: home, home, machine: resolve("chatgpt-thread.ts"), input: conversation });
  assert.equal(prepared.description, description);
  const human = person("done");
  const result = await prepared.start({ human });
  assert.equal(result.value, "done");
  assert.deepEqual(result.output, { conversation, reason: null, summary: null });
  assert.match(human.requests[0]!.prompt, /paired and waiting for a message/u);
});
