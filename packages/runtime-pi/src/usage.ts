import type { RuntimeUsage } from "@anastom/runtime-contract";

const counterNames = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

// Pi initializes required counters to zero and some provider mappings use `|| 0`.
// Without field provenance those zero values cannot establish reported usage.
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Fresh-session completed assistant observations, deduplicated using Pi's authoritative message object. */
export class PiUsageAccumulator {
  private readonly seen = new WeakSet<object>();
  private readonly totals: RuntimeUsage = { type: "usage", scope: "attempt", coverage: "partial" };

  /** Consume only final assistant counters; no transcript, cost, or tool payload is retained. */
  observe(value: unknown): void {
    if (!value || typeof value !== "object" || this.seen.has(value)) {
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.role !== "assistant") {
      return;
    }
    this.seen.add(value);
    if (!message.usage || typeof message.usage !== "object") {
      return;
    }
    const usage = message.usage as Record<string, unknown>;
    // Pi splits uncached input, cache read and cache write into disjoint fields.
    const inputParts = [usage.input, usage.cacheRead, usage.cacheWrite];
    const inclusiveInput = inputParts.every(
      (part) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0,
    )
      ? inputParts.reduce<number>((sum, part) => sum + (part as number), 0)
      : undefined;
    const observation: Partial<RuntimeUsage> = {
      inputTokens: positive(inclusiveInput),
      outputTokens: positive(usage.output),
      cacheReadTokens: positive(usage.cacheRead),
      cacheWriteTokens: positive(usage.cacheWrite),
      reasoningTokens: positive(usage.reasoning),
      totalTokens: positive(usage.totalTokens),
    };
    for (const name of counterNames) {
      const count = observation[name];
      if (count !== undefined) {
        const total = (this.totals[name] ?? 0) + count;
        if (Number.isSafeInteger(total)) {
          this.totals[name] = total;
        } else {
          delete this.totals[name];
        }
      }
    }
  }

  /** Return partial observed counts, including an empty observation when usage is unavailable. */
  final(): RuntimeUsage {
    return structuredClone(this.totals);
  }
}
