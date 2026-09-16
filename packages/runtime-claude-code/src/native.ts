import { validateJsonValue, type JsonValue } from "@anastom/core";
import type {
  ExecutionRequest,
  ExecutionResult,
  RuntimeEvent,
  RuntimeUsage,
} from "@anastom/runtime-contract";
import { CLAUDE_CODE_VERSION } from "./executable.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Allowlist native identity, generic file-tool lifecycle, final report and documented usage. */
export class ClaudeNativeTurn {
  initialized = false;
  completed = false;
  nativeFailed = false;
  report?: unknown;
  readonly observations: RuntimeEvent[] = [];
  private usage?: RuntimeUsage;

  /** Bind the operator's selected model and the mode-specific native tool allowlist. */
  constructor(
    private readonly model: string,
    private readonly allowedTools: readonly string[],
  ) {}

  /** Consume one JSONL frame and discard everything except approved public fields. */
  observe(value: unknown): void {
    const frame = record(value);
    if (!frame || typeof frame.type !== "string") {
      throw new Error("Malformed Claude Code native JSONL frame");
    }
    if (this.completed) {
      throw new Error("Claude Code native JSONL event followed the terminal result");
    }
    if (frame.type === "system" && frame.subtype === "init") {
      this.observeInit(frame);
      return;
    }
    if (frame.type === "assistant") {
      if (!this.initialized) {
        throw new Error("Claude Code native assistant frame preceded initialization");
      }
      this.observeAssistant(frame);
      return;
    }
    if (frame.type !== "result") {
      return;
    }
    this.observeResult(frame);
  }

  private observeInit(frame: Record<string, unknown>): void {
    if (this.initialized || this.completed) {
      throw new Error("Duplicate Claude Code native initialization");
    }
    const tools = array(frame.tools);
    const mcp = array(frame.mcp_servers);
    const plugins = array(frame.plugins);
    const permitted = new Set([...this.allowedTools, "StructuredOutput"]);
    if (
      frame.claude_code_version !== CLAUDE_CODE_VERSION ||
      typeof frame.model !== "string" ||
      frame.model !== this.model ||
      !tools ||
      tools.some((tool) => typeof tool !== "string" || !permitted.has(tool)) ||
      !mcp ||
      mcp.length !== 0 ||
      !plugins ||
      plugins.length !== 0
    ) {
      throw new Error(
        "Claude Code native identity or tool isolation differs from the selected profile",
      );
    }
    this.initialized = true;
    this.observations.push({
      type: "metadata",
      provider: "anthropic",
      model: frame.model,
      source: "reported",
      runtimeVersion: CLAUDE_CODE_VERSION,
    });
  }

  private observeAssistant(frame: Record<string, unknown>): void {
    // Tool input, thinking, text and model messages remain private. Only tool names cross.
    const message = record(frame.message);
    for (const block of array(message?.content) ?? []) {
      const item = record(block);
      if (
        item?.type === "tool_use" &&
        typeof item.name === "string" &&
        this.allowedTools.includes(item.name)
      ) {
        this.observations.push({ type: "log", message: "Claude Code file tool invoked" });
      }
    }
  }

  private observeResult(frame: Record<string, unknown>): void {
    if (!this.initialized || this.completed) {
      throw new Error("Malformed Claude Code native completion order");
    }
    this.completed = true;
    if (frame.subtype !== "success" || frame.is_error === true) {
      this.nativeFailed = true;
      return;
    }
    this.report = frame.structured_output;
    this.usage = this.mapUsage(frame.usage);
  }

  /** Anthropic's result-level main-loop usage is cumulative within one query, not all retries. */
  private mapUsage(value: unknown): RuntimeUsage {
    const native = record(value);
    const uncached = counter(native?.input_tokens);
    const read = counter(native?.cache_read_input_tokens);
    const write = counter(native?.cache_creation_input_tokens);
    const output = counter(native?.output_tokens);
    const inputParts = [uncached, read, write].filter((part): part is number => part !== undefined);
    const inclusive = inputParts.reduce((sum, part) => sum + part, 0);
    const input = Number.isSafeInteger(inclusive) && inclusive > 0 ? inclusive : undefined;
    return {
      type: "usage",
      scope: "attempt",
      coverage: "partial",
      ...(input === undefined ? {} : { inputTokens: input }),
      ...(output === undefined ? {} : { outputTokens: output }),
      ...(read === undefined ? {} : { cacheReadTokens: read }),
      ...(write === undefined ? {} : { cacheWriteTokens: write }),
    };
  }

  /** Require native completion and engine-compatible schema before accepting a report. */
  result(request: ExecutionRequest, exitCode: number | null): ExecutionResult {
    if (this.nativeFailed || exitCode !== 0) {
      return {
        status: "failed",
        failure: {
          category: "model-provider",
          message:
            "Claude Code model execution failed; check the selected auth source, provider and model",
        },
      };
    }
    if (!this.initialized || !this.completed) {
      return {
        status: "failed",
        failure: {
          category: "runtime-unavailable",
          message: "Claude Code exited before a completed native result",
        },
      };
    }
    if (
      this.report === undefined ||
      !validateJsonValue(request.requiredOutputSchema, this.report as JsonValue).valid
    ) {
      return {
        status: "failed",
        failure: {
          category: "schema-violation",
          message: "Claude Code final StructuredOutput must match the required report schema",
        },
      };
    }
    return { status: "succeeded", output: this.report as JsonValue };
  }

  /** Return one defensive partial attempt observation with unknown counters absent. */
  finalUsage(): RuntimeUsage {
    return structuredClone(this.usage ?? { type: "usage", scope: "attempt", coverage: "partial" });
  }
}
