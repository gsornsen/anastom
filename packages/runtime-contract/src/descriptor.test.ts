import { describe, expect, it } from "vitest";

import { assertRuntimeDescriptor, RuntimePreflightError } from "./index.js";

const descriptor = {
  version: "anastom.dev/runtime-descriptor/v1alpha1",
  runtimeId: "fixture",
  configurationVersion: "anastom.dev/runtime-fixture-config/v1alpha1",
  configuration: { model: "fixture" },
};

describe("runtime descriptor envelope", () => {
  it("accepts a bounded exact envelope", () => {
    expect(() => assertRuntimeDescriptor(descriptor)).not.toThrow();
  });

  it("rejects unknown envelope fields and oversized canonical bytes", () => {
    expect(() => assertRuntimeDescriptor({ ...descriptor, authToken: "secret" })).toThrow(
      RuntimePreflightError,
    );
    expect(() =>
      assertRuntimeDescriptor({
        ...descriptor,
        configuration: { model: "x".repeat(17 * 1024) },
      }),
    ).toThrow("exceeds 16 KiB");
  });
});
