import { canonicalJson } from "@anastom/core";
import type { ExecutionRequest } from "@anastom/runtime-contract";
import { RuntimePreflightError } from "@anastom/runtime-contract";
import type { ClaudeAuthSource } from "./auth.js";

const WORKER_PROMPT =
  "Implement the bounded software task using only the explicit context piped on stdin. Operate only in the assigned working directory, respect the supplied mutation policy, and return the required JSON report. The Anastom control plane owns authoritative verification. Do not use previous conversations or hidden local instructions.";

/** Reject provider, model, or billing-source defaults before any model session exists. */
export function validateClaudeSelection(
  provider: string,
  model: string,
  source: ClaudeAuthSource,
): void {
  if (provider !== "anthropic" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(model)) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Claude Code requires explicit --provider anthropic and a supported --model identifier",
    );
  }
  if (source !== "subscription" && source !== "api-key") {
    throw new RuntimePreflightError(
      "policy-violation",
      "Claude Code requires explicit subscription or api-key authentication selection",
    );
  }
}

/** Mode-specific native CLI arguments and immutable stdin context. */
export interface ClaudeCodeProfile {
  args: string[];
  prompt: string;
  allowedTools: readonly string[];
}

function selectedTools(source: ClaudeAuthSource, isolated: boolean): string[] {
  if (source === "api-key") {
    return isolated ? ["Read", "Edit"] : ["Read"];
  }
  return isolated ? ["Read", "Glob", "Grep", "Write", "Edit"] : ["Read", "Glob", "Grep"];
}

/** Render explicit Task context as stdin and fixed safe/restricted native CLI arguments. */
export function createClaudeCodeProfile(
  request: ExecutionRequest,
  source: ClaudeAuthSource,
  model: string,
): ClaudeCodeProfile {
  if (request.nodeKind !== "agent" || request.workspace.mode === "memory") {
    throw new RuntimePreflightError(
      "policy-violation",
      "Claude Code supports filesystem agent attempts only",
    );
  }
  if (request.workspace.mode === "readonly" && request.toolPolicy.allowMutations) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Readonly Claude Code attempts cannot authorize mutations",
    );
  }
  const isolated = request.workspace.mode === "isolated" && request.toolPolicy.allowMutations;
  // Native --bare mode exposes only Read/Edit in this pinned release, even when
  // --tools requests a larger surface. Do not advertise unavailable file creation.
  const tools = selectedTools(source, isolated);
  const prompt = canonicalJson(request.context);
  const schema = canonicalJson(request.requiredOutputSchema);
  if (Buffer.byteLength(prompt) > 1_048_576 || Buffer.byteLength(schema) > 65_536) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Claude Code context or output schema exceeds bounded profile",
    );
  }
  return {
    prompt,
    allowedTools: tools,
    args: [
      ...(source === "api-key" ? ["--bare"] : ["--safe-mode"]),
      "--restricted",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      schema,
      "--model",
      model,
      "--max-turns",
      "64",
      "--tools",
      tools.join(","),
      ...(isolated
        ? ["--allowedTools", ...(source === "api-key" ? ["Edit"] : ["Write", "Edit"])]
        : []),
      "--permission-mode",
      "dontAsk",
      WORKER_PROMPT,
    ],
  };
}
