import type { RuntimeEvent } from "@anastom/runtime-contract";

// Deliberately consume only public tool names/outcomes, never messages or tool bodies.
/**
 * Normalize Pi public tool lifecycle observations; omit thinking, raw tool inputs, and result bodies.
 */
export function observablePiEvent(event: {
  type: string;
  toolName?: string;
  isError?: boolean;
}): RuntimeEvent | null {
  const tool = ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(
    event.toolName ?? "",
  )
    ? event.toolName
    : "other";
  if (event.type === "tool_execution_start" && event.toolName) {
    return { type: "log", message: "Pi tool started: " + tool };
  }
  if (event.type === "tool_execution_end" && event.toolName) {
    return {
      type: "log",
      message: "Pi tool finished: " + tool + (event.isError ? " (failed)" : ""),
    };
  }
  return null;
}
