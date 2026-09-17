import { describe, expect, it } from "vitest";
import type { DurableRuntimeAdapter } from "@anastom/runtime-contract";

import { ClaudeCodeRuntimeAdapter, claudeCodeRuntimeDescriptorCodec } from "./index.js";

describe("Claude Code durable descriptor", () => {
  it("round-trips only the selected first-party auth mode", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      provider: "anthropic",
      model: "claude-opus-4-8",
      authSource: "subscription",
    });
    const descriptor = await adapter.descriptor();
    expect(descriptor).toEqual({
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "claude-code",
      configurationVersion: "anastom.dev/runtime-claude-code-config/v1alpha1",
      configuration: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        authSource: "subscription",
      },
    });
    const rebuilt = (await claudeCodeRuntimeDescriptorCodec.create(
      descriptor,
    )) as DurableRuntimeAdapter;
    expect(await rebuilt.descriptor()).toEqual(descriptor);
  });

  it("rejects credentials and process overrides", async () => {
    const privateDescriptor = {
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "claude-code",
      configurationVersion: "anastom.dev/runtime-claude-code-config/v1alpha1",
      configuration: {
        provider: "anthropic",
        model: "fixture",
        authSource: "api-key",
        apiKey: "secret",
      },
    };
    expect(() => claudeCodeRuntimeDescriptorCodec.parse(privateDescriptor)).toThrow(
      "Invalid Claude Code runtime descriptor",
    );
    await expect(
      claudeCodeRuntimeDescriptorCodec.create(
        privateDescriptor as unknown as Parameters<
          typeof claudeCodeRuntimeDescriptorCodec.create
        >[0],
      ),
    ).rejects.toThrow("Invalid Claude Code runtime descriptor");
  });
});
