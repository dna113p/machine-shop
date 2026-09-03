import assert from "node:assert/strict";

import { agent, final, human, machine, operation, run } from "../../../machines/src/index.ts";
import implementReview from "../../implement-review.ts";

let agentRuns = 0;
const expectedFeedback = process.env.FAKE_REVIEW_FEEDBACK;
const definition = implementReview(
  { agent, final, human, machine, operation },
  "Add the smallest useful example",
);

const result = await run(definition, {
  agents: {
    default: (request) => {
      agentRuns += 1;
      assert.equal(request.cwd, process.cwd());
      assert.deepEqual(request.outcomes, ["completed"]);
      assert.match(request.prompt, /Add the smallest useful example/u);

      if (agentRuns === 1) {
        assert.doesNotMatch(request.prompt, /review feedback/u);
      } else {
        assert.equal(agentRuns, 2);
        assert.ok(expectedFeedback);
        assert.ok(request.prompt.includes(expectedFeedback));
      }

      return { type: "completed" };
    },
  },
});

console.log(`Agent runs: ${agentRuns}`);
console.log(`--> ${String(result.value)}`);
