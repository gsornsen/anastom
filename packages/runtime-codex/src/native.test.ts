import { describe, expect, it } from "vitest";
import {
  conformanceRequest,
  conformanceReport,
} from "../../runtime-contract/src/testing/conformance.js";
import { NativeTurn } from "./native.js";

function turn(report: unknown = conformanceReport, usage?: object): NativeTurn {
  const native = new NativeTurn();
  native.observe({ type: "thread.started", thread_id: "synthetic" });
  native.observe({ type: "turn.started" });
  native.observe({
    type: "item.completed",
    item: {
      id: "message",
      type: "agent_message",
      text: typeof report === "string" ? report : JSON.stringify(report),
      privateReasoning: "PRIVATE_SENTINEL",
    },
  });
  native.observe({ type: "turn.completed", usage });
  return native;
}

describe("Codex native public mapping", () => {
  it("validates the final report and excludes native private bodies", () => {
    const native = turn();
    expect(native.result(conformanceRequest("/fixture"), 0)).toEqual({
      status: "succeeded",
      output: conformanceReport,
    });
    expect(JSON.stringify(native.observations)).not.toContain("PRIVATE_SENTINEL");
    expect(native.finalUsage()).toEqual({ type: "usage", scope: "attempt", coverage: "partial" });
  });
  it("omits synthetic zeros but keeps established positive counters without inventing total/cache write", () => {
    const native = turn(conformanceReport, {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 10,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 5,
      total_tokens: 120,
    });
    expect(native.finalUsage()).toEqual({
      type: "usage",
      scope: "attempt",
      coverage: "partial",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      reasoningTokens: 5,
    });
    expect(
      turn(conformanceReport, {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      }).finalUsage(),
    ).toEqual({ type: "usage", scope: "attempt", coverage: "partial" });
  });
  it("fails malformed reports, missing turn completion, native failures and report-followed-exit failure", () => {
    expect(turn("{}").result(conformanceRequest("/fixture"), 0)).toMatchObject({
      status: "failed",
      failure: { category: "schema-violation" },
    });
    expect(turn().result(conformanceRequest("/fixture"), 1)).toMatchObject({
      status: "failed",
      failure: { category: "model-provider" },
    });
    const missing = new NativeTurn();
    missing.observe({ type: "thread.started", thread_id: "synthetic" });
    expect(missing.result(conformanceRequest("/fixture"), 0)).toMatchObject({
      status: "failed",
      failure: { category: "runtime-unavailable" },
    });
    const failed = new NativeTurn();
    failed.observe({ type: "thread.started", thread_id: "synthetic" });
    failed.observe({ type: "turn.started" });
    failed.observe({ type: "turn.failed", error: { message: "PRIVATE_SENTINEL" } });
    expect(JSON.stringify(failed.result(conformanceRequest("/fixture"), 1))).not.toContain(
      "PRIVATE_SENTINEL",
    );
  });
  it("maps only tool kind/status and rejects duplicate/conflicting turn outcomes", () => {
    const native = new NativeTurn();
    native.observe({ type: "thread.started", thread_id: "synthetic" });
    native.observe({ type: "turn.started" });
    native.observe({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "PRIVATE_SENTINEL",
        aggregated_output: "PRIVATE_SENTINEL",
        status: "failed",
      },
    });
    expect(native.observations).toEqual([{ type: "log", message: "Codex command failed" }]);
    native.observe({ type: "turn.completed", usage: {} });
    expect(() => native.observe({ type: "turn.completed", usage: {} })).toThrow(/completion/);
    native.observe({ type: "error", message: "PRIVATE_SENTINEL" });
    expect(native.result(conformanceRequest("/fixture"), 0)).toMatchObject({
      status: "failed",
      failure: { category: "policy-violation" },
    });
  });
});
