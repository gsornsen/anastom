import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  FrameDecoder,
  encodeFrame,
  executionCapabilityDigest,
  matchesExecutionCapability,
  readEndedFrame,
} from "./protocol.js";

describe("execution supervisor framing", () => {
  it("decodes split canonical frames and rejects partial or trailing bytes", async () => {
    const frame = encodeFrame({ value: "fixture" }, 1_024);
    const decoder = new FrameDecoder(1_024);
    const values: unknown[] = [];
    for (const byte of frame) {
      values.push(...decoder.push(Buffer.from([byte])));
    }
    decoder.finish();
    expect(values).toEqual([{ value: "fixture" }]);

    const partial = new FrameDecoder(1_024);
    partial.push(frame.subarray(0, frame.length - 1));
    expect(() => partial.finish()).toThrow("partial frame");

    const stream = new PassThrough();
    const reading = readEndedFrame(stream, 1_024);
    stream.end(Buffer.concat([frame, Buffer.from("trailing")]));
    await expect(reading).rejects.toThrow("does not match");
  });

  it("rejects invalid lengths and fatal UTF-8", async () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(1_025);
    expect(() => new FrameDecoder(1_024).push(oversized)).toThrow("Invalid protocol frame length");

    const invalidUtf8 = Buffer.from([0, 0, 0, 1, 0xff]);
    const stream = new PassThrough();
    const reading = readEndedFrame(stream, 1_024);
    stream.end(invalidUtf8);
    await expect(reading).rejects.toThrow();
  });

  it("uses a stable digest and exact constant-time capability comparison", () => {
    const capability = "a".repeat(43);
    expect(executionCapabilityDigest(capability)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(matchesExecutionCapability(capability, capability)).toBe(true);
    expect(matchesExecutionCapability(capability, `${"a".repeat(42)}b`)).toBe(false);
    expect(matchesExecutionCapability(capability, "short")).toBe(false);
  });
});
