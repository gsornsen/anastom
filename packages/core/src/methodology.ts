import { isAbsolute } from "node:path";
import { canonicalExistingRoot, resolveExistingChild } from "@anastom/path-policy";
import Ajv from "ajv";
import { parse } from "yaml";

import methodologyDocumentSchema from "../schemas/sdlc-methodology-document.v1alpha1.json" with { type: "json" };
import { digestBytes, digestJson } from "./canonical.js";
import { formatSchemaErrors, SdlcValidationError } from "./feature.js";
import { readBoundedUtf8 } from "./local-file.js";
import type { JsonSchema } from "./types.js";

const MANIFEST_BYTES = 64 * 1024;
const PROMPT_BYTES = 128 * 1024;
const SCHEMA_BYTES = 256 * 1024;
const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });

/** Stable names for the six roles in the built-in defined-SDLC method. */
export type SdlcRoleName =
  | "analyst"
  | "planner"
  | "implementer"
  | "integrator"
  | "specificationReviewer"
  | "qualityReviewer";

/** One role reference in the checked-in methodology manifest. */
interface SdlcMethodologyRoleDocument {
  id: string;
  prompt: string;
  outputSchema: string;
  mutation: "readonly" | "isolated";
}

/** Strict checked-in methodology manifest before local resources are loaded. */
interface SdlcMethodologyDocument {
  apiVersion: "anastom.dev/v1alpha1";
  kind: "Methodology";
  metadata: { id: "sdlc/default"; version: string };
  roles: Record<SdlcRoleName, SdlcMethodologyRoleDocument>;
}

/** Content-addressed prompt and output contract retained for one role. */
interface SdlcRoleSnapshot {
  id: string;
  promptRef: string;
  prompt: string;
  promptDigest: string;
  outputSchemaRef: string;
  outputSchema: JsonSchema;
  outputSchemaDigest: string;
  mutation: "readonly" | "isolated";
}

/** Complete methodology content persisted with a run so restart never reloads mutable files. */
export interface SdlcMethodologySnapshot {
  apiVersion: "anastom.dev/v1alpha1";
  kind: "Methodology";
  metadata: { id: "sdlc/default"; version: string };
  roles: Readonly<Record<SdlcRoleName, SdlcRoleSnapshot>>;
  methodologyDigest: string;
}

const validateMethodology = ajv.compile<SdlcMethodologyDocument>(methodologyDocumentSchema);
const roleNames: readonly SdlcRoleName[] = [
  "analyst",
  "planner",
  "implementer",
  "integrator",
  "specificationReviewer",
  "qualityReviewer",
];
const expectedRoleIds: Record<SdlcRoleName, string> = {
  analyst: "analyst",
  planner: "planner",
  implementer: "implementer",
  integrator: "integrator",
  specificationReviewer: "specification-reviewer",
  qualityReviewer: "quality-reviewer",
};

function assertPortableReference(reference: string, label: string): void {
  if (
    isAbsolute(reference) ||
    /^[a-zA-Z][a-zA-Z+.-]*:/.test(reference) ||
    reference.includes("\\") ||
    reference.includes("\0") ||
    reference.split("/").includes("..")
  ) {
    throw new SdlcValidationError("methodology", [
      `${label} must be a portable path inside the methodology root`,
    ]);
  }
}

async function loadRole(
  root: string,
  name: SdlcRoleName,
  role: SdlcMethodologyRoleDocument,
): Promise<SdlcRoleSnapshot> {
  if (role.id !== expectedRoleIds[name]) {
    throw new SdlcValidationError("methodology", [
      `role ${name} must use id ${JSON.stringify(expectedRoleIds[name])}`,
    ]);
  }
  assertPortableReference(role.prompt, `role ${name} prompt`);
  assertPortableReference(role.outputSchema, `role ${name} output schema`);
  const promptPath = await resolveExistingChild(root, role.prompt, "file");
  const schemaPath = await resolveExistingChild(root, role.outputSchema, "file");
  const [prompt, schemaSource] = await Promise.all([
    readBoundedUtf8(promptPath, { maxBytes: PROMPT_BYTES, label: `role ${name} prompt` }),
    readBoundedUtf8(schemaPath, {
      maxBytes: SCHEMA_BYTES,
      label: `role ${name} output schema`,
    }),
  ]);
  if (prompt.trim().length === 0) {
    throw new SdlcValidationError("methodology", [`role ${name} prompt must not be empty`]);
  }
  let outputSchema: unknown;
  try {
    outputSchema = JSON.parse(schemaSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SdlcValidationError("methodology", [
      `role ${name} output schema is not JSON: ${message}`,
    ]);
  }
  if (outputSchema === null || Array.isArray(outputSchema) || typeof outputSchema !== "object") {
    throw new SdlcValidationError("methodology", [
      `role ${name} output schema must contain a JSON object`,
    ]);
  }
  try {
    ajv.compile(outputSchema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SdlcValidationError("methodology", [
      `role ${name} output schema is invalid: ${message}`,
    ]);
  }
  return {
    id: role.id,
    promptRef: role.prompt,
    prompt,
    promptDigest: digestBytes(prompt),
    outputSchemaRef: role.outputSchema,
    outputSchema: outputSchema as JsonSchema,
    outputSchemaDigest: digestJson(outputSchema),
    mutation: role.mutation,
  };
}

/**
 * Load, confine, validate, and content-address the built-in SDLC methodology package.
 * @public
 */
export async function loadSdlcMethodology(
  methodologyRoot: string,
): Promise<SdlcMethodologySnapshot> {
  const root = await canonicalExistingRoot(methodologyRoot);
  const manifestPath = await resolveExistingChild(root, "methodology.yaml", "file");
  const manifestSource = await readBoundedUtf8(manifestPath, {
    maxBytes: MANIFEST_BYTES,
    label: "methodology manifest",
  });
  let candidate: unknown;
  try {
    candidate = parse(manifestSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SdlcValidationError("methodology", [`YAML parse error: ${message}`]);
  }
  if (!validateMethodology(candidate)) {
    throw new SdlcValidationError("methodology", formatSchemaErrors(validateMethodology.errors));
  }
  const entries = await Promise.all(
    roleNames.map(
      async (name) => [name, await loadRole(root, name, candidate.roles[name])] as const,
    ),
  );
  const content = {
    apiVersion: candidate.apiVersion,
    kind: candidate.kind,
    metadata: { ...candidate.metadata },
    roles: Object.fromEntries(entries) as Record<SdlcRoleName, SdlcRoleSnapshot>,
  };
  return { ...content, methodologyDigest: digestJson(content) };
}
