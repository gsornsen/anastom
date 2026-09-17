import type { TerminalNodeView, TerminalRunView } from "./terminal-view.js";
import { terminalSafeText } from "./live.js";

const ansi = {
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
} as const;

/** Terminal dimensions, color preference, and transient local notification for one paint. */
export interface TerminalFrameOptions {
  columns: number;
  rows: number;
  color: boolean;
  notification?: string;
}

/** Render one complete frame without cursor movement or alternate-screen control bytes. */
export function renderTerminalFrame(view: TerminalRunView, options: TerminalFrameOptions): string {
  const columns = Math.max(1, Math.floor(options.columns));
  const rows = Math.max(1, Math.floor(options.rows));
  const pending = view.pendingControls.length;
  const header = [
    styled(
      truncate(
        `Anastom  ${terminalSafeText(view.workflowId)}  run ${terminalSafeText(view.runId)}`,
        columns,
      ),
      "heading",
      options.color,
    ),
    styled(
      truncate(
        `status=${view.status}  sequence=${view.sequence}  owner=${view.ownerState}  pending-controls=${pending}`,
        columns,
      ),
      statusTone(view.status),
      options.color,
    ),
  ];
  if (rows <= header.length) {
    return header.slice(0, rows).join("\n");
  }
  const footer = [
    ...(options.notification
      ? [styled(truncate(terminalSafeText(options.notification), columns), "warn", options.color)]
      : []),
    styled(
      truncate("p pause  c cancel  r resume  d/q detach  Ctrl-C detach", columns),
      "dim",
      options.color,
    ),
  ];
  const bodyRows = Math.max(0, rows - header.length - footer.length);
  const body = renderBody(view, bodyRows, columns, options.color);
  while (body.length < bodyRows) {
    body.push("");
  }
  return [...header, ...body, ...footer].slice(0, rows).join("\n");
}

function renderBody(
  view: TerminalRunView,
  rows: number,
  columns: number,
  color: boolean,
): string[] {
  if (rows === 0) {
    return [];
  }
  const lines = [styled(truncate(`Nodes (${view.nodes.length})`, columns), "dim", color)];
  if (rows === 1) {
    return lines;
  }
  const activityCapacity = Math.min(
    view.activity.length,
    Math.max(0, Math.floor((rows - 2) * 0.45)),
  );
  const nodeCapacity = Math.max(0, rows - lines.length - activityCapacity - 1);
  const visibleNodes =
    nodeCapacity < view.nodes.length && nodeCapacity > 0 ? nodeCapacity - 1 : nodeCapacity;
  lines.push(...view.nodes.slice(0, visibleNodes).map((node) => renderNode(node, columns, color)));
  if (visibleNodes < view.nodes.length && lines.length < rows) {
    lines.push(
      styled(
        truncate(`  ... ${view.nodes.length - visibleNodes} more nodes`, columns),
        "dim",
        color,
      ),
    );
  }
  if (activityCapacity > 0 && lines.length < rows) {
    lines.push(styled(truncate("Activity", columns), "dim", color));
    lines.push(
      ...view.activity
        .slice(-activityCapacity)
        .map((item) =>
          styled(
            truncate(`#${item.sequence} ${terminalSafeText(item.text)}`, columns),
            item.tone,
            color,
          ),
        ),
    );
  }
  return lines.slice(0, rows);
}

/** Render a deterministic plain frame suitable for logs and support output. */
export function renderTerminalSnapshot(view: TerminalRunView): string {
  const rows = view.nodes.length + view.activity.length + 8;
  return renderTerminalFrame(view, { columns: 120, rows, color: false });
}

function renderNode(node: TerminalNodeView, columns: number, color: boolean): string {
  const attempt = node.attempt ? ` attempt=${node.attempt}/${node.attemptStatus ?? "unknown"}` : "";
  const runtime = node.runtime
    ? ` runtime=${terminalSafeText(node.runtime.provider)}/${terminalSafeText(node.runtime.model)}`
    : "";
  const usage = node.usage
    ? ` tokens=${node.usage.totalTokens ?? "unavailable"}${node.usage.reasoningTokens === undefined ? "" : ` reasoning=${node.usage.reasoningTokens}`}`
    : "";
  const needs = node.needs.length > 0 ? ` needs=${node.needs.join(",")}` : "";
  const marker = nodeMarker(node.status);
  const line = ` ${marker} ${node.phase.padEnd(14)} ${node.nodeId} ${node.status}${attempt}${runtime}${usage}${needs}`;
  return styled(truncate(terminalSafeText(line), columns), statusTone(node.status), color);
}

function nodeMarker(status: string): string {
  if (status === "succeeded") {
    return "+";
  }
  if (["failed", "blocked", "cancelled"].includes(status)) {
    return "x";
  }
  if (status === "paused") {
    return "!";
  }
  if (status === "running" || status === "ready") {
    return ">";
  }
  return ".";
}

function statusTone(status: string): string {
  if (["succeeded", "passed", "committed"].includes(status)) {
    return "good";
  }
  if (["failed", "blocked", "recovery-blocked", "cancelled"].includes(status)) {
    return "bad";
  }
  if (["paused", "timed-out", "orphaned"].includes(status)) {
    return "warn";
  }
  return "normal";
}

function styled(value: string, tone: string, color: boolean): string {
  if (!color) {
    return value;
  }
  let start: string = ansi.cyan;
  if (tone === "good") {
    start = ansi.green;
  } else if (tone === "bad") {
    start = ansi.red;
  } else if (tone === "warn") {
    start = ansi.yellow;
  } else if (tone === "dim") {
    start = ansi.dim;
  }
  return `${start}${value}${ansi.reset}`;
}

function truncate(value: string, columns: number): string {
  if (displayWidth(value) <= columns) {
    return value;
  }
  if (columns <= 3) {
    return takeColumns(value, columns);
  }
  return `${takeColumns(value, columns - 3)}...`;
}

function takeColumns(value: string, columns: number): string {
  let width = 0;
  let result = "";
  for (const character of value) {
    const next = characterWidth(character);
    if (width + next > columns) {
      break;
    }
    width += next;
    result += character;
  }
  return result;
}

function displayWidth(value: string): number {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}

function characterWidth(character: string): number {
  if (/\p{Mark}/u.test(character) || character === "\u200d") {
    return 0;
  }
  return (character.codePointAt(0) ?? 0) < 0x1100 ? 1 : 2;
}
