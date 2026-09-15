import { runtimeConformance } from "../../runtime-contract/src/testing/conformance.js";
import { CodexRuntimeAdapter } from "./index.js";
import { syntheticCodex } from "./testing/fixture.js";

runtimeConformance("Codex process double", {
  real: true,
  create: async (scenario) => {
    const fixture = await syntheticCodex(scenario);
    const adapter = new CodexRuntimeAdapter({
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      executable: fixture.executable,
      authDirectory: fixture.authDirectory,
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
