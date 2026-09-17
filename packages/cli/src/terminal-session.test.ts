import { describe, expect, it } from "vitest";

import type { TerminalHost, TerminalKey } from "./terminal-host.js";
import { runTerminalSession } from "./terminal-session.js";
import { terminalInspection } from "./testing/terminal-fixture.js";

type TerminalRunOperations = Parameters<typeof runTerminalSession>[0]["operations"];

class RecordedTerminal implements TerminalHost {
  readonly writes: string[] = [];
  restored = false;
  private paint = 0;
  private columns = 90;
  private onKey: ((key: TerminalKey) => void) | undefined;
  private onResize: (() => void) | undefined;

  size(): { columns: number; rows: number } {
    return { columns: this.columns, rows: 18 };
  }

  color(): boolean {
    return false;
  }

  write(value: string): void {
    this.writes.push(value);
    if (!value.startsWith("\u001b[H\u001b[2J")) {
      return;
    }
    this.paint++;
    queueMicrotask(() => {
      if (this.paint === 1) {
        this.onKey?.("pause");
      } else if (this.paint === 2) {
        this.columns = 64;
        this.onResize?.();
        this.onKey?.("cancel");
      } else if (this.paint === 3) {
        this.onKey?.("resume");
      } else {
        this.onKey?.("detach");
      }
    });
  }

  open(onKey: (key: TerminalKey) => void, onResize: () => void): () => void {
    this.onKey = onKey;
    this.onResize = onResize;
    return () => {
      this.restored = true;
    };
  }
}

class DetachAfterPaintTerminal implements TerminalHost {
  frame = "";
  restored = false;
  private onKey: ((key: TerminalKey) => void) | undefined;

  constructor(
    private readonly keys: TerminalKey[] = ["detach"],
    private readonly columns = 80,
  ) {}

  size(): { columns: number; rows: number } {
    return { columns: this.columns, rows: 16 };
  }

  color(): boolean {
    return false;
  }

  write(value: string): void {
    if (value.startsWith("\u001b[H\u001b[2J")) {
      this.frame = value;
      const key = this.keys.shift();
      if (key) {
        queueMicrotask(() => this.onKey?.(key));
      }
    }
  }

  open(onKey: (key: TerminalKey) => void): () => void {
    this.onKey = onKey;
    return () => {
      this.restored = true;
    };
  }
}

describe("recorded terminal attachment", () => {
  it("maps controls to durable operations, repaints after resize, and restores on detach", async () => {
    const host = new RecordedTerminal();
    const operations: string[] = [];
    const source: TerminalRunOperations = {
      load: async () => terminalInspection(),
      async submit(action, operationId) {
        operations.push(`${action}:${operationId}`);
        return { replayed: false };
      },
      async launchResume(operationId) {
        operations.push(`resume:${operationId}`);
      },
    };
    let operation = 0;
    await runTerminalSession({
      host,
      operations: source,
      createOperationId: () => `operation-${++operation}`,
      refreshMs: 5_000,
    });

    expect(operations).toEqual(["pause:operation-1", "cancel:operation-2", "resume:operation-3"]);
    expect(host.restored).toBe(true);
    expect(host.writes[0]).toBe("\u001b[?1049h\u001b[?25l");
    expect(host.writes.at(-1)).toBe("\u001b[?25h\u001b[?1049l");
    expect(host.writes.filter((value) => value.startsWith("\u001b[H\u001b[2J"))).toHaveLength(4);
    expect(host.writes.join("")).not.toContain("\u001b[32m");
  });

  it("restores the terminal when a control operation fails", async () => {
    const host = new RecordedTerminal();
    const source: TerminalRunOperations = {
      load: async () => terminalInspection(),
      submit: async () => {
        throw new Error("fixture refusal");
      },
      launchResume: async () => undefined,
    };
    await runTerminalSession({
      host,
      operations: source,
      createOperationId: () => "operation",
      refreshMs: 5_000,
    });
    expect(host.writes.join("")).toContain("Control failed: fixture refusal");
    expect(host.restored).toBe(true);
  });

  it("reports a coordinator launch failure after preserving an accepted control", async () => {
    const host = new DetachAfterPaintTerminal(["pause", "detach"], 180);
    await runTerminalSession({
      host,
      operations: {
        load: async () => terminalInspection(),
        submit: async () => ({
          replayed: false,
          coordinatorLaunchError: "entry point unavailable",
        }),
        launchResume: async () => undefined,
      },
      createOperationId: () => "accepted-operation",
      refreshMs: 5_000,
    });

    expect(host.frame).toContain("Control accepted: action=pause");
    expect(host.frame).toContain("coordinator launch failed: entry point unavailable");
    expect(host.restored).toBe(true);
  });

  it("reconstructs the same first frame after detach and reconnect", async () => {
    const source: TerminalRunOperations = {
      load: async () => terminalInspection(),
      submit: async () => ({ replayed: false }),
      launchResume: async () => undefined,
    };
    const first = new DetachAfterPaintTerminal();
    const second = new DetachAfterPaintTerminal();
    await runTerminalSession({
      host: first,
      operations: source,
      createOperationId: () => "unused",
    });
    await runTerminalSession({
      host: second,
      operations: source,
      createOperationId: () => "unused",
    });
    expect(second.frame).toBe(first.frame);
    expect(first.restored && second.restored).toBe(true);
  });
});
