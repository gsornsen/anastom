import Ajv from "ajv";
import type { RuntimeDescriptor } from "@anastom/runtime-contract";
import { assertRuntimeDescriptor, RuntimePreflightError } from "@anastom/runtime-contract";
import schema from "../schemas/runtime-config.v1alpha1.json" with { type: "json" };

/** The complete public Pi selection persisted for durable reconstruction. */
export type PiRuntimeDescriptor = RuntimeDescriptor & {
  runtimeId: "pi";
  configurationVersion: "anastom.dev/runtime-pi-config/v1alpha1";
  configuration: { provider: string; model: string };
};

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

/** Parse the exact Pi descriptor schema, rejecting private or unknown configuration. */
export function parsePiRuntimeDescriptor(value: unknown): PiRuntimeDescriptor {
  assertRuntimeDescriptor(value);
  if (!validate(value)) {
    throw new RuntimePreflightError("policy-violation", "Invalid Pi runtime descriptor");
  }
  return structuredClone(value) as unknown as PiRuntimeDescriptor;
}

/** Validate one explicit Pi provider/model selection. */
export function assertPiSelection(provider: string, model: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(model)
  ) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Pi requires supported provider and model identifiers",
    );
  }
}
