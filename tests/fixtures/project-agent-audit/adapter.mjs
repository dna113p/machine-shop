// Local JSON adapter only. No provider, network, manager or model is involved.
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
appendFileSync(config.calls, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(3) }) + "\n");
if (config.mode === "setup") {
  writeFileSync(config.sentinel, "Setup was executed without separate authorization");
  process.exit(99);
}
if (config.mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (config.mode === "malformed") {
  process.stdout.write("{not JSON");
} else if (config.mode === "oversized") {
  process.stdout.write("x".repeat(65_537));
  setInterval(() => {}, 1000);
} else {
  const state = config.snapshot?.state ?? "ready";
  const snapshot = {
    version: 1,
    project: realpathSync(process.cwd()),
    observedAt: new Date(Date.now() + (config.offsetMs ?? 0)).toISOString(),
    binding: state === "missing" ? null : { reference: "fixture://project-agent/binding-17", revision: "revision-42" },
    provider: { id: "fixture-provider", name: "Fixture provider" },
    agent: state === "missing" ? null : { id: "fixture-shared-agent", name: "Fixture shared agent" },
    capabilities: ["feedback", "read-project"],
    limits: ["Observation only; no write-access or enforcement guarantee"],
    state,
    explanation: state === "ready" ? "Provider observed the shared project binding ready; this is a snapshot." : `Binding is ${state}; use the supported setup route or inspect provider availability.`,
    ...config.snapshot,
  };
  process.stdout.write(JSON.stringify(snapshot));
  if (config.mode === "combined-output") {
    // Each stream is below 64 KiB; their sum exceeds it.
    process.stderr.write("x".repeat(34_000));
    process.stdout.write(" ".repeat(34_000));
    setInterval(() => {}, 1000);
  } else if (config.mode === "exit") {
    process.stderr.write("FIXTURE_RAW_CREDENTIAL_DO_NOT_PUBLISH");
    process.exitCode = 7;
  }
}
