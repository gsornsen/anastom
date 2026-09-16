import { describe, expect, it } from "vitest";
import type { DurableRuntimeAdapter } from "@anastom/runtime-contract";

import {
  CodexRuntimeAdapter,
  codexRuntimeDescriptorCodec,
  parseCodexRuntimeDescriptor,
} from "./index.js";

describe("Codex durable descriptor", () => {
  it("round-trips selection without executable or auth-store paths", async () => {
    const adapter = new CodexRuntimeAdapter({
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      executable: "/private/test/codex",
      authDirectory: "/private/test/auth",
    });
    const descriptor = await adapter.descriptor();
    expect(descriptor).toEqual({
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "codex",
      configurationVersion: "anastom.dev/runtime-codex-config/v1alpha1",
      configuration: {
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        authSource: "file-store",
      },
    });
    expect(JSON.stringify(descriptor)).not.toContain("/private/test");
    const rebuilt = (await codexRuntimeDescriptorCodec.create(descriptor)) as DurableRuntimeAdapter;
    expect(await rebuilt.descriptor()).toEqual(descriptor);
  });

  it("rejects unknown auth and transport configuration", async () => {
    const privateDescriptor = {
      version: "anastom.dev/runtime-descriptor/v1alpha1",
      runtimeId: "codex",
      configurationVersion: "anastom.dev/runtime-codex-config/v1alpha1",
      configuration: {
        provider: "openai",
        model: "fixture",
        authSource: "file-store",
        authDirectory: "/private/auth",
      },
    };
    expect(() => parseCodexRuntimeDescriptor(privateDescriptor)).toThrow(
      "Invalid Codex runtime descriptor",
    );
    await expect(
      codexRuntimeDescriptorCodec.create(
        privateDescriptor as unknown as Parameters<typeof codexRuntimeDescriptorCodec.create>[0],
      ),
    ).rejects.toThrow("Invalid Codex runtime descriptor");
  });
});
