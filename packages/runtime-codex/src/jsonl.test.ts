import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "./jsonl.js";

describe("bounded native JSONL framing", () => {
  it("reassembles split multibyte UTF-8 and JSON frames without silently replacing bytes", () => {
    const decoder = new JsonlDecoder();
    const bytes = Buffer.from(
      '{"type":"item.completed","item":{"text":"café"}}\n{"type":"turn.completed"}\n',
    );
    const firstSplit = bytes.indexOf(Buffer.from("é")) + 1;
    expect(decoder.push(bytes.subarray(0, firstSplit))).toEqual([]);
    expect(decoder.push(bytes.subarray(firstSplit, bytes.length - 3))).toEqual([
      { type: "item.completed", item: { text: "café" } },
    ]);
    expect(decoder.push(bytes.subarray(bytes.length - 3))).toEqual([{ type: "turn.completed" }]);
    expect(() => decoder.finish()).not.toThrow();
  });
  it("rejects oversized, invalid UTF-8 and incomplete frames", () => {
    expect(() => new JsonlDecoder(12).push(Buffer.from("x".repeat(13)))).toThrow(/exceeds/);
    expect(() => new JsonlDecoder().push(Buffer.from([0xc3, 0x28, 0x0a]))).toThrow();
    const decoder = new JsonlDecoder();
    decoder.push(Buffer.from('{"type":"turn.completed"}'));
    expect(() => decoder.finish()).toThrow(/Incomplete/);
  });
});
