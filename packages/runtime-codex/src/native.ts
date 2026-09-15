import { validateJsonValue, type JsonValue } from "@anastom/core";
import type {
  ExecutionRequest,
  ExecutionResult,
  RuntimeEvent,
  RuntimeUsage,
} from "@anastom/runtime-contract";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function toolKind(nativeType: string): string {
  if (nativeType === "command_execution") {
    return "command";
  }
  if (nativeType === "file_change") {
    return "file-change";
  }
  if (nativeType === "mcp_tool_call") {
    return "mcp";
  }
  if (nativeType === "web_search") {
    return "web";
  }
  return "other";
}

/** A strict allowlist of native lifecycle and final-report fields; private bodies are discarded. */
export class NativeTurn {
  started = false;
  completed = false;
  nativeFailed = false;
  report?: unknown;
  private usage?: RuntimeUsage;
  private turnStarted = false;
  readonly observations: RuntimeEvent[] = [];

  /** Capture one native JSONL frame; malformed required shapes fail before durable observation. */
  observe(value: unknown): void {
    const frame = record(value);
    if (!frame || typeof frame.type !== "string") {
      throw new Error("Malformed native JSONL event");
    }
    switch (frame.type) {
      case "thread.started":
        if (this.started) {
          throw new Error("Duplicate native lifecycle start");
        }
        this.started = true;
        break;
      case "turn.started":
        if (!this.started || this.completed || this.turnStarted) {
          throw new Error("Malformed native turn order");
        }
        this.turnStarted = true;
        break;
      case "item.updated":
        // Updates may contain partial tool output or private text and are never persisted.
        break;
      case "item.started":
      case "item.completed": {
        this.observeItem(frame);
        break;
      }
      case "turn.completed":
        if (!this.started || !this.turnStarted || this.completed || this.nativeFailed) {
          throw new Error("Malformed native completion");
        }
        this.completed = true;
        this.usage = this.mapUsage(frame.usage);
        break;
      case "turn.failed":
        if (!this.started || !this.turnStarted || this.completed) {
          throw new Error("Malformed native failure");
        }
        this.nativeFailed = true;
        break;
      case "error":
        this.nativeFailed = true;
        break;
      default:
        // Unknown private or optional native events never enter the public history.
        break;
    }
  }

  private observeItem(frame: Record<string, unknown>): void {
    const item = record(frame.item);
    if (!item || typeof item.type !== "string") {
      throw new Error("Malformed native item");
    }
    if (item.type === "agent_message" && frame.type === "item.completed") {
      this.report = item.text;
      return;
    }
    if (!["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
      return;
    }
    let status = "completed";
    if (frame.type === "item.started") {
      status = "started";
    } else if (item.status === "failed") {
      status = "failed";
    }
    this.observations.push({ type: "log", message: `Codex ${toolKind(item.type)} ${status}` });
  }

  /** Emit positive counters only because this native release synthesizes unavailable zeros. */
  private mapUsage(value: unknown): RuntimeUsage {
    const native = record(value);
    const input = positive(native?.input_tokens);
    const output = positive(native?.output_tokens);
    const cacheRead = positive(native?.cached_input_tokens);
    const reasoning = positive(native?.reasoning_output_tokens);
    return {
      type: "usage",
      scope: "attempt",
      coverage: "partial",
      ...(input === undefined ? {} : { inputTokens: input }),
      ...(output === undefined ? {} : { outputTokens: output }),
      ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      // Native cache-write is a placeholder under missing provider provenance.
    };
  }

  /** Confirm native completion and independently parse/validate the report after process exit and cleanup. */
  result(request: ExecutionRequest, exitCode: number | null): ExecutionResult {
    if (this.completed && this.nativeFailed) {
      return {
        status: "failed",
        failure: {
          category: "policy-violation",
          message: "Codex reported conflicting native outcomes or hidden context handling",
        },
      };
    }
    if (this.nativeFailed || exitCode !== 0) {
      return {
        status: "failed",
        failure: {
          category: "model-provider",
          message:
            "Codex model execution failed; check authentication, provider, model and bounded context",
        },
      };
    }
    if (!this.completed) {
      return {
        status: "failed",
        failure: {
          category: "runtime-unavailable",
          message: "Codex exited before a completed native turn",
        },
      };
    }
    try {
      if (typeof this.report !== "string") {
        throw new Error("No final assistant report");
      }
      const output = JSON.parse(this.report) as JsonValue;
      if (!validateJsonValue(request.requiredOutputSchema, output).valid) {
        throw new Error("Invalid final assistant report");
      }
      return { status: "succeeded", output };
    } catch {
      return {
        status: "failed",
        failure: {
          category: "schema-violation",
          message: "Codex final report must be JSON matching the required output schema",
        },
      };
    }
  }

  /** Return one final partial attempt observation; no raw provider usage object is retained. */
  finalUsage(): RuntimeUsage {
    return structuredClone(this.usage ?? { type: "usage", scope: "attempt", coverage: "partial" });
  }
}
