import Ajv from "ajv";
import capabilitiesSchema from "../schemas/capabilities.v1alpha1.json" with { type: "json" };
import observationSchema from "../schemas/observation.v1alpha1.json" with { type: "json" };
import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeNegotiation,
} from "./index.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const capabilitiesValidator = ajv.compile(capabilitiesSchema);
const observationValidator = ajv.compile(observationSchema);

/** A sanitized pre-state failure to probe or satisfy the explicitly selected runtime. */
export class RuntimePreflightError extends Error {
  /** Classify the failure without exposing native configuration or credential contents. */
  constructor(
    readonly category: "policy-violation" | "runtime-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RuntimePreflightError";
  }
}

/** Validate a complete capability snapshot; unknown extra fields fail closed. */
export function assertRuntimeCapabilities(value: unknown): asserts value is RuntimeCapabilities {
  if (!capabilitiesValidator(value)) {
    throw new RuntimePreflightError(
      "runtime-unavailable",
      "Runtime returned an invalid capability snapshot",
    );
  }
}

/** Validate public observation fields before persistence, excluding opaque native payloads. */
export function assertRuntimeEvent(value: unknown): asserts value is RuntimeEvent {
  if (!observationValidator(value)) {
    throw new Error("Invalid public runtime observation");
  }
}

/** Check recorded requirements against the selected adapter and the actual filesystem mode. */
export function assertRuntimeNegotiation(
  value: RuntimeNegotiation,
  runtimeId: string,
  workspaceMode: "readonly" | "isolated",
): void {
  assertRuntimeCapabilities(value.capabilities);
  if (
    value.version !== "anastom.dev/runtime-negotiation/v1alpha1" ||
    value.runtimeId !== runtimeId ||
    value.requirements.workspaceMode !== workspaceMode ||
    value.requirements.cancellation !== true ||
    value.requirements.structuredOutput !== "validated"
  ) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Runtime negotiation does not match the selected worker and workspace",
    );
  }
  const capabilities = value.capabilities;
  if (!capabilities.workspaceModes?.includes(workspaceMode)) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Selected runtime does not declare support for the requested " + workspaceMode + " workspace",
    );
  }
  if (!capabilities.cancellation || capabilities.structuredOutput === "none") {
    throw new RuntimePreflightError(
      "policy-violation",
      "Selected runtime requires confirmed cancellation and validated structured output support",
    );
  }
}

/** Obtain one validated capability decision without creating worker state or calling a model. */
export async function probeRuntime(
  runtime: RuntimeAdapter,
  workspaceMode: "readonly" | "isolated",
): Promise<RuntimeNegotiation> {
  let capabilities: unknown;
  try {
    capabilities = structuredClone(await runtime.capabilities());
  } catch (error) {
    if (error instanceof RuntimePreflightError) {
      throw error;
    }
    throw new RuntimePreflightError(
      "runtime-unavailable",
      "Runtime capability probe failed; check installation and authentication readiness",
    );
  }
  assertRuntimeCapabilities(capabilities);
  const decision: RuntimeNegotiation = {
    version: "anastom.dev/runtime-negotiation/v1alpha1",
    runtimeId: runtime.id,
    requirements: { workspaceMode, cancellation: true, structuredOutput: "validated" },
    capabilities,
  };
  assertRuntimeNegotiation(decision, runtime.id, workspaceMode);
  return decision;
}
