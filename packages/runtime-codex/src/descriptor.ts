import Ajv from "ajv";
import type { RuntimeDescriptor } from "@anastom/runtime-contract";
import { assertRuntimeDescriptor, RuntimePreflightError } from "@anastom/runtime-contract";
import schema from "../schemas/runtime-config.v1alpha1.json" with { type: "json" };
import type { CodexReasoningEffort } from "./profile.js";

/** The credential-free Codex selection persisted for durable reconstruction. */
export type CodexRuntimeDescriptor = RuntimeDescriptor & {
  runtimeId: "codex";
  configurationVersion: "anastom.dev/runtime-codex-config/v1alpha1";
  configuration: {
    provider: "openai";
    model: string;
    reasoningEffort?: CodexReasoningEffort;
    authSource: "file-store";
  };
};

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

/** Parse the exact Codex descriptor schema, rejecting auth paths and transport overrides. */
export function parseCodexRuntimeDescriptor(value: unknown): CodexRuntimeDescriptor {
  assertRuntimeDescriptor(value);
  if (!validate(value)) {
    throw new RuntimePreflightError("policy-violation", "Invalid Codex runtime descriptor");
  }
  return structuredClone(value) as unknown as CodexRuntimeDescriptor;
}
