import { describe, expect, it } from "vitest";

import { renderTerminalFrame, renderTerminalSnapshot } from "./terminal-frame.js";
import { projectTerminalRunView } from "./terminal-view.js";
import { terminalInspection } from "./testing/terminal-fixture.js";

describe("terminal run projection and frames", () => {
  it("shows graph, runtime, usage, integration, and verification from public projections", () => {
    const view = projectTerminalRunView(terminalInspection());
    expect(view.nodes.map(({ nodeId }) => nodeId)).toEqual([
      "analysis",
      "implement.left",
      "implement.right",
      "integrate",
      "verify",
    ]);
    expect(view.nodes[1]).toMatchObject({
      phase: "implementation",
      status: "running",
      needs: ["analysis"],
      runtime: { provider: "openai", model: "gpt-5.6-terra" },
      usage: { totalTokens: 162, reasoningTokens: 12 },
    });
    expect(view.activity.map(({ text }) => text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("public progress"),
        expect.stringContaining("integration committed"),
        expect.stringContaining("verification passed"),
      ]),
    );
    expect(view.activity.map(({ text }) => text).join("\n")).not.toContain("\u001b");
    expect(view.activity.map(({ text }) => text).join("\n")).not.toContain("\u202e");
  });

  it("renders bounded narrow and reduced-color output without wrapping control text", () => {
    const frame = renderTerminalFrame(projectTerminalRunView(terminalInspection()), {
      columns: 48,
      rows: 12,
      color: false,
      notification: "Control accepted",
    });
    const lines = frame.split("\n");
    expect(lines).toHaveLength(12);
    expect(lines.every((line) => line.length <= 48)).toBe(true);
    expect(frame).not.toContain("\u001b");
    expect(frame).toContain("p pause");
    expect(frame).toContain("Control accepted");
  });

  it("conservatively truncates wide public text to the terminal width", () => {
    const view = projectTerminalRunView(terminalInspection());
    const frame = renderTerminalFrame(
      {
        ...view,
        workflowId: "界".repeat(40),
      },
      { columns: 30, rows: 10, color: false },
    );
    expect(frame.split("\n")[0]).toMatch(/\.\.\.$/);
  });

  it("neutralizes terminal controls in graph node fields", () => {
    const view = projectTerminalRunView(terminalInspection());
    const nodes = view.nodes.map((node, index) =>
      index === 1 ? { ...node, needs: ["analysis\u001b[31m\u202e"] } : node,
    );
    const frame = renderTerminalFrame({ ...view, nodes }, { columns: 160, rows: 12, color: false });

    expect(frame).not.toContain("\u001b");
    expect(frame).not.toContain("\u202e");
    expect(frame).toContain("analysis�[31m�");
  });

  it("never paints more rows than a very short terminal exposes", () => {
    const frame = renderTerminalFrame(projectTerminalRunView(terminalInspection()), {
      columns: 30,
      rows: 2,
      color: false,
    });
    expect(frame.split("\n")).toHaveLength(2);
    expect(frame).toContain("status=running");
  });

  it("never paints beyond a terminal narrower than the key legend", () => {
    const frame = renderTerminalFrame(projectTerminalRunView(terminalInspection()), {
      columns: 8,
      rows: 4,
      color: false,
    });

    expect(frame.split("\n")).toHaveLength(4);
    expect(frame.split("\n").every((line) => [...line].length <= 8)).toBe(true);
  });

  it("produces a deterministic plain snapshot while interactive color remains available", () => {
    const view = projectTerminalRunView(terminalInspection());
    const snapshot = renderTerminalSnapshot(view);
    expect(snapshot).toContain("implement.left");
    expect(snapshot).toContain("reasoning=12");
    expect(snapshot).toContain("verification passed");
    expect(snapshot).not.toContain("\u001b");
    expect(renderTerminalFrame(view, { columns: 100, rows: 20, color: true })).toContain(
      "\u001b[32m",
    );
  });

  it("retains only the most recent bounded public activity", () => {
    const inspection = terminalInspection();
    const repeated = Array.from({ length: 20 }, (_, index) => ({
      version: "anastom.dev/live-run-event/v1alpha1" as const,
      runId: "terminal-run",
      sequence: 20 + index,
      type: "log" as const,
      nodeId: "implement.left",
      phase: "implementation" as const,
      attempt: 1,
      message: `message ${index}`,
    }));
    inspection.liveEvents = [...(inspection.liveEvents ?? []), ...repeated];
    const view = projectTerminalRunView(inspection);
    expect(view.activity).toHaveLength(12);
    expect(view.activity[0]?.text).toContain("message 8");
    expect(view.activity.at(-1)?.text).toContain("message 19");
  });
});
