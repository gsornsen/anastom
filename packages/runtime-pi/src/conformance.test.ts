import type { PiSession } from "./index.js";
import { PiRuntimeAdapter } from "./index.js";
import {
  conformanceReport,
  runtimeConformance,
} from "../../runtime-contract/src/testing/conformance.js";
import type { ExecutionRequest, RuntimeEvent } from "@anastom/runtime-contract";

runtimeConformance("Pi", {
  real: true,
  create: async (scenario) => {
    const requests: ExecutionRequest[] = [];
    let disposed = 0;
    const adapter = new PiRuntimeAdapter({
      factory: async (request) => {
        requests.push(structuredClone(request));
        let listener: ((event: RuntimeEvent) => void) | undefined;
        let release!: () => void;
        const inFlight = new Promise<void>((done) => {
          release = done;
        });
        const session: PiSession = {
          identity: { provider: "fixture", model: "fixture" },
          subscribe: (observe) => {
            listener = observe;
            return () => {
              listener = undefined;
            };
          },
          prompt: async () => {
            if (scenario === "cancellable") {
              await inFlight;
              return;
            }
            if (scenario === "failure") {
              throw new Error("PRIVATE_SENTINEL");
            }
            const logs = scenario === "pressure" ? 2048 : 1;
            for (let i = 0; i < logs; i++) {
              listener?.({ type: "log", message: "Pi tool finished: edit" });
            }
          },
          finalMessage: () =>
            scenario === "missing"
              ? null
              : {
                  role: "assistant",
                  stopReason: "stop",
                  content: [
                    { type: "thinking", thinking: "PRIVATE_SENTINEL" },
                    {
                      type: "text",
                      text: scenario === "invalid" ? "{}" : JSON.stringify(conformanceReport),
                    },
                  ],
                },
          finalUsage: () => ({
            type: "usage",
            scope: "attempt",
            coverage: "partial",
            inputTokens: 100,
            outputTokens: 20,
          }),
          abort: async () => {
            release();
          },
          dispose: () => {
            disposed++;
          },
        };
        return session;
      },
    });
    return {
      adapter,
      requests,
      started: () => requests.length,
      finalized: () => disposed,
      dispose: async () => {},
    };
  },
});
