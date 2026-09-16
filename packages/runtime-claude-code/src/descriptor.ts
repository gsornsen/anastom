import Ajv from "ajv";
import type { RuntimeDescriptor } from "@anastom/runtime-contract";
import { assertRuntimeDescriptor, RuntimePreflightError } from "@anastom/runtime-contract";
import schema from "../schemas/runtime-config.v1alpha1.json" with { type: "json" };
import type { ClaudeAuthSource } from "./auth.js";

/** The credential-free Claude Code selection persisted for durable reconstruction. */
export type ClaudeCodeRuntimeDescriptor = RuntimeDescriptor & {
  runtimeId: "claude-code";
  configurationVersion: "anastom.dev/runtime-claude-code-config/v1alpha1";
  configuration: {
    provider: "anthropic";
    model: string;
    authSource: ClaudeAuthSource;
  };
};

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

/** Parse the exact Claude Code descriptor without accepting credentials or process settings. */
export function parseClaudeCodeRuntimeDescriptor(value: unknown): ClaudeCodeRuntimeDescriptor {
  assertRuntimeDescriptor(value);
  if (!validate(value)) {
    throw new RuntimePreflightError("policy-violation", "Invalid Claude Code runtime descriptor");
  }
  return structuredClone(value) as unknown as ClaudeCodeRuntimeDescriptor;
}
