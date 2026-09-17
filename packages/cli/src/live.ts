import type { LiveRunEvent } from "@anastom/runtime-contract";

const color = {
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
} as const;

/**
 * Replace terminal control and bidirectional formatting characters in untrusted display text.
 * This is shared by the line and full-screen CLI renderers, not the public event shape.
 */
export function terminalSafeText(value: string): string {
  return [...value]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      if (character === "\n" || character === "\r" || character === "\t") {
        return " ";
      }
      const control = point < 32 || (point >= 127 && point <= 159);
      const bidirectional =
        point === 0x061c ||
        point === 0x200e ||
        point === 0x200f ||
        (point >= 0x202a && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x2069);
      return control || bidirectional ? "�" : character;
    })
    .join("");
}

/** Render one public observation as JSON Lines for pipes or concise colored text for a terminal. */
function renderLiveRunEvent(event: LiveRunEvent, isTty: boolean): string {
  if (!isTty) {
    return JSON.stringify(event);
  }
  const prefix = `${color.dim}#${event.sequence}${color.reset}`;
  switch (event.type) {
    case "run":
      return `${prefix} ${tone(event.status)}run ${event.status}${color.reset} id=${terminalSafeText(event.runId)}`;
    case "graph":
      return `${prefix} ${color.cyan}graph expanded${color.reset} nodes=${event.nodeCount}`;
    case "node":
      return `${prefix} ${color.cyan}${event.phase}${color.reset} ${terminalSafeText(event.nodeId)} ${tone(event.status)}${event.status}${color.reset}${category(event.failureCategory)}`;
    case "attempt":
      return `${prefix} ${terminalSafeText(event.nodeId)}/${event.attempt} ${tone(event.status)}${event.status}${color.reset}${event.runtimeId ? ` runtime=${terminalSafeText(event.runtimeId)}` : ""}${category(event.failureCategory)}`;
    case "log":
      return `${prefix} ${terminalSafeText(event.nodeId)}/${event.attempt} ${terminalSafeText(event.message)}${event.messageTruncated ? " …" : ""}${event.droppedMessages ? ` (dropped=${event.droppedMessages})` : ""}`;
    case "runtime":
      return `${prefix} ${terminalSafeText(event.nodeId)}/${event.attempt} runtime=${terminalSafeText(event.provider)}/${terminalSafeText(event.model)}`;
    case "usage":
      return `${prefix} ${terminalSafeText(event.nodeId)}/${event.attempt} tokens=${event.usage.totalTokens ?? "unavailable"} coverage=${event.usage.coverage}`;
    case "artifact":
      return `${prefix} ${terminalSafeText(event.nodeId)}/${event.attempt} artifact=${terminalSafeText(event.artifact.type)} digest=${terminalSafeText(event.artifact.digest)}`;
    case "workspace":
      return renderWorkspace(event, prefix);
    case "integration":
      return `${prefix} ${terminalSafeText(event.nodeId)} integration ${tone(event.status)}${event.status}${color.reset}${event.commit ? ` commit=${terminalSafeText(event.commit)}` : ""}${category(event.failureCategory)}`;
    case "verification":
      return `${prefix} ${terminalSafeText(event.nodeId)}/${event.attempt} verification ${event.passed ? `${color.green}passed` : `${color.red}failed`}${color.reset} exit=${event.exitCode ?? "none"} durationMs=${Math.round(event.durationMs)}`;
    case "control":
      return `${prefix} control ${event.status}${"action" in event ? ` action=${event.action}` : ""}${"outcome" in event ? ` outcome=${event.outcome}` : ""}`;
  }
}

/** Keep one renderer cursor so reconnect replays and newly committed batches do not duplicate lines. */
export class LiveRunRenderer {
  private throughSequence = 0;

  /** Select pipe-safe or terminal output without inspecting global process streams. */
  constructor(private readonly isTty: boolean) {}

  /** Render observations after the current cursor and advance only through rendered history. */
  render(events: readonly LiveRunEvent[]): string[] {
    const fresh = events.filter((event) => event.sequence > this.throughSequence);
    if (fresh.length > 0) {
      this.throughSequence = Math.max(...fresh.map((event) => event.sequence));
    }
    return fresh.map((event) => renderLiveRunEvent(event, this.isTty));
  }
}

function tone(status: string): string {
  if (["succeeded", "passed", "committed"].includes(status)) {
    return color.green;
  }
  if (["failed", "blocked", "recovery-blocked", "cancelled"].includes(status)) {
    return color.red;
  }
  if (["paused", "timed-out", "orphaned"].includes(status)) {
    return color.yellow;
  }
  return color.cyan;
}

function category(value: string | undefined): string {
  return value ? ` category=${value}` : "";
}

function renderWorkspace(
  event: Extract<LiveRunEvent, { type: "workspace" }>,
  prefix: string,
): string {
  const identity = "nodeId" in event && event.nodeId ? ` ${event.nodeId}` : "";
  if (event.status === "assigned") {
    return `${prefix}${terminalSafeText(identity)} workspace assigned id=${terminalSafeText(event.workspaceId)} mode=${event.mode}${event.path ? ` path=${terminalSafeText(event.path)}` : ""}${event.branch ? ` branch=${terminalSafeText(event.branch)}` : ""}`;
  }
  if (event.status === "patch-accepted") {
    return `${prefix}${terminalSafeText(identity)}/${event.attempt} patch accepted digest=${terminalSafeText(event.patchDigest)} files=${event.changedFiles.length}`;
  }
  return `${prefix}${terminalSafeText(identity)}/${event.attempt} workspace observed head=${terminalSafeText(event.headCommit)} files=${event.changedFiles.length}`;
}
