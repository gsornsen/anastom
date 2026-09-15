import { FakeRuntimeAdapter } from "./index.js";
import {
  conformanceReport,
  runtimeConformance,
} from "../../runtime-contract/src/testing/conformance.js";

runtimeConformance("Fake", {
  real: false,
  create: async (scenario) => {
    const attempt =
      scenario === "failure" || scenario === "missing"
        ? {
            outcome: "failed" as const,
            failure: {
              category: "runtime-unavailable" as const,
              message: "Scripted absence or failure",
            },
          }
        : {
            output: scenario === "invalid" ? {} : conformanceReport,
            events: Array.from(
              { length: scenario === "pressure" ? 2048 : 1 },
              () => "Scripted public observation",
            ),
          };
    return {
      adapter: new FakeRuntimeAdapter({ nodes: { work: [attempt, attempt] } }),
      dispose: async () => {},
    };
  },
});
