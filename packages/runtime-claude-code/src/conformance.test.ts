import { runtimeConformance } from "../../runtime-contract/src/testing/conformance.js";
import { ClaudeCodeRuntimeAdapter } from "./index.js";
import { syntheticClaudeCode } from "./testing/fixture.js";

runtimeConformance("Claude Code process double", {
  real: true,
  create: async (scenario) => {
    const fixture = await syntheticClaudeCode(scenario);
    const adapter = new ClaudeCodeRuntimeAdapter({
      provider: "anthropic",
      model: "claude-opus-4-8",
      authSource: "subscription",
      testing: { executable: fixture.executable, environment: { PATH: process.env.PATH } },
    });
    return {
      adapter,
      started: fixture.started,
      finalized: fixture.finalized,
      captured: fixture.captured,
      dispose: fixture.dispose,
    };
  },
});
