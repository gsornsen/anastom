import { describe, expect, it } from "vitest";
import type { DurableRuntimeAdapter } from "@anastom/runtime-contract";

import { PiRuntimeAdapter, piRuntimeDescriptorCodec } from "./index.js";

describe("Pi durable descriptor", () => {
  it("round-trips only explicit public selection", async () => {
    const adapter = new PiRuntimeAdapter({ provider: "anthropic", model: "claude-opus-4-8" });
    const descriptor = await adapter.descriptor();
    expect(descriptor).toEqual({
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "pi",
      configurationVersion: "anastom.dev/runtime-pi-config/v1alpha1",
      configuration: { provider: "anthropic", model: "claude-opus-4-8" },
    });
    const rebuilt = (await piRuntimeDescriptorCodec.create(
      piRuntimeDescriptorCodec.parse(descriptor),
    )) as DurableRuntimeAdapter;
    expect(await rebuilt.descriptor()).toEqual(descriptor);
  });

  it("rejects unknown/private fields and ambiguous injected defaults", async () => {
    const privateDescriptor = {
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "pi",
      configurationVersion: "anastom.dev/runtime-pi-config/v1alpha1",
      configuration: { provider: "anthropic", model: "fixture", apiKey: "secret" },
    };
    expect(() => piRuntimeDescriptorCodec.parse(privateDescriptor)).toThrow(
      "Invalid Pi runtime descriptor",
    );
    await expect(
      piRuntimeDescriptorCodec.create(
        privateDescriptor as unknown as Parameters<typeof piRuntimeDescriptorCodec.create>[0],
      ),
    ).rejects.toThrow("Invalid Pi runtime descriptor");
    await expect(
      new PiRuntimeAdapter({
        factory: async () => {
          throw new Error("unused");
        },
      }).descriptor(),
    ).rejects.toThrow("explicit provider and model");
  });
});
