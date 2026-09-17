import { describe, expect, it } from "vitest";
import type { LiveRunEvent } from "@anastom/runtime-contract";

import { LiveRunRenderer } from "./live.js";

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

  it("does not duplicate replayed observations after its cursor advances", () => {
    const renderer = new LiveRunRenderer(false);
    expect(renderer.render([event])).toHaveLength(1);
    expect(renderer.render([event])).toEqual([]);
    expect(renderer.render([{ ...event, sequence: 5, message: "next" }])).toHaveLength(1);
  });
});
