import { describe, expect, it } from "vitest";
import {
  conformanceReport,
  conformanceRequest,
} from "../../runtime-contract/src/testing/conformance.js";
import { ClaudeJsonlDecoder } from "./jsonl.js";
import { ClaudeNativeTurn } from "./native.js";

const model = "claude-opus-4-8";
const tools = ["Read", "Glob", "Grep", "Write", "Edit"];
const init = {
  type: "system",
  subtype: "init",
  claude_code_version: "2.1.268",
  model,
  tools: [...tools, "StructuredOutput"],
  mcp_servers: [],
  plugins: [],
  private_metadata: "PRIVATE_SENTINEL",
};

describe("Claude Code native evidence boundary", () => {
  it("accepts schema-valid StructuredOutput and inclusive split input usage only", () => {
    const native = new ClaudeNativeTurn(model, tools);
    native.observe(init);
    native.observe({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "PRIVATE_SENTINEL" },
          },
        ],
      },
      thinking: "PRIVATE_SENTINEL",
    });
    native.observe({
      type: "result",
      subtype: "success",
      structured_output: conformanceReport,
      usage: {
        input_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
        output_tokens: 10,
        private_debug: "PRIVATE_SENTINEL",
      },
    });
    expect(native.result(conformanceRequest("/tmp"), 0)).toEqual({
      status: "succeeded",
      output: conformanceReport,
    });
    expect(native.finalUsage()).toEqual({
      type: "usage",
      scope: "attempt",
      coverage: "partial",
      inputTokens: 12,
      outputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 3,
    });
    expect(JSON.stringify(native.observations)).not.toContain("PRIVATE_SENTINEL");
  });
  it("rejects report absence, invalid output, wrong model and expanded tool/MCP profiles", () => {
    const absent = new ClaudeNativeTurn(model, tools);
    absent.observe(init);
    absent.observe({ type: "result", subtype: "success" });
    expect(absent.result(conformanceRequest("/tmp"), 0)).toMatchObject({
      status: "failed",
      failure: { category: "schema-violation" },
    });
    const invalid = new ClaudeNativeTurn(model, tools);
    invalid.observe(init);
    invalid.observe({ type: "result", subtype: "success", structured_output: {} });
    expect(invalid.result(conformanceRequest("/tmp"), 0)).toMatchObject({
      status: "failed",
      failure: { category: "schema-violation" },
    });
    for (const changed of [
      { ...init, model: "fallback" },
      { ...init, tools: [...init.tools, "Bash"] },
      { ...init, mcp_servers: ["untrusted"] },
    ]) {
      expect(() => new ClaudeNativeTurn(model, tools).observe(changed)).toThrow(
        /identity or tool isolation/,
      );
    }
    expect(() => absent.observe({ type: "assistant" })).toThrow(/terminal result/);
    expect(() => new ClaudeNativeTurn(model, tools).observe({ type: "assistant" })).toThrow(
      /preceded initialization/,
    );
  });
  it("frames split multibyte JSONL and rejects malformed, oversized or premature EOF", () => {
    const decoder = new ClaudeJsonlDecoder(128);
    const bytes = Buffer.from(JSON.stringify({ type: "assistant", text: "é" }) + "\n");
    const frames: unknown[] = [];
    for (const byte of bytes) {
      frames.push(...decoder.push(Buffer.from([byte])));
    }
    expect(frames).toEqual([{ type: "assistant", text: "é" }]);
    expect(() => decoder.finish()).not.toThrow();
    expect(() => new ClaudeJsonlDecoder(8).push(Buffer.from("x".repeat(9)))).toThrow(
      /exceeds limit/,
    );
    const partial = new ClaudeJsonlDecoder();
    partial.push(Buffer.from('{"type":"result"'));
    expect(() => partial.finish()).toThrow(/prematurely/);
  });
});
