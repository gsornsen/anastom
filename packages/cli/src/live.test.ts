import { describe, expect, it } from "vitest";
import type { LiveRunEvent } from "@anastom/runtime-contract";

import { LiveRunRenderer, terminalSafeText } from "./live.js";

const event: LiveRunEvent = {
  version: "anastom.dev/live-run-event/v1alpha1",
  runId: "run",
  sequence: 4,
  type: "log",
  nodeId: "implement.left",
  phase: "implementation",
  attempt: 1,
  message: "bounded public log",
  droppedMessages: 3,
};

const created: LiveRunEvent = {
  version: "anastom.dev/live-run-event/v1alpha1",
  runId: "visible-run-id",
  sequence: 1,
  type: "run",
  status: "created",
};

describe("live CLI rendering", () => {
  it("emits one parseable JSON value without terminal control bytes for non-TTY output", () => {
    const rendered = new LiveRunRenderer(false).render([event])[0]!;
    expect(JSON.parse(rendered)).toEqual(event);
    expect(rendered).not.toContain("\r");
    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("\u001b");
  });

  it("uses concise terminal styling and reports dropped messages", () => {
    const rendered = new LiveRunRenderer(true).render([event])[0]!;
    expect(rendered).toContain("\u001b[");
    expect(rendered).toContain("implement.left/1");
    expect(rendered).toContain("dropped=3");
  });

  it("keeps the durable run identity visible in human terminal output", () => {
    expect(new LiveRunRenderer(true).render([created])[0]).toContain("id=visible-run-id");
  });

  it("does not duplicate replayed observations after its cursor advances", () => {
    const renderer = new LiveRunRenderer(false);
    expect(renderer.render([event])).toHaveLength(1);
    expect(renderer.render([event])).toEqual([]);
    expect(renderer.render([{ ...event, sequence: 5, message: "next" }])).toHaveLength(1);
  });

  it("neutralizes terminal controls without changing structured JSON output", () => {
    const unsafe = { ...event, message: "progress\u001b[31m\u202esecret\nnext" };
    const terminal = new LiveRunRenderer(true).render([unsafe])[0]!;
    const structured = new LiveRunRenderer(false).render([unsafe])[0]!;
    expect(terminal).not.toContain("\u001b[31m");
    expect(terminal).not.toContain("\u202e");
    expect(terminal).toContain("progress�[31m�secret next");
    expect(JSON.parse(structured)).toEqual(unsafe);
    expect(terminalSafeText("a\tb\rc")).toBe("a b c");
    expect(terminalSafeText("a\u061cb\u200ec\u200fd\u2066e\u2069f")).toBe("a�b�c�d�e�f");
  });
});
