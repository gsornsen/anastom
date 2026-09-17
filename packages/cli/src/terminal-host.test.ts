import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";

import { describe, expect, it } from "vitest";

import { ProcessTerminalHost, type TerminalKey } from "./terminal-host.js";

class FixtureInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  pauses = 0;
  resumes = 0;

  constructor(public readableFlowing: boolean | null) {
    super();
  }

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  pause(): this {
    this.pauses++;
    this.readableFlowing = false;
    return this;
  }

  resume(): this {
    this.resumes++;
    this.readableFlowing = true;
    return this;
  }
}

class FixtureOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 100;
  rows = 30;
  output = "";

  write(value: string): boolean {
    this.output += value;
    return true;
  }
}

function processHost(input: FixtureInput, output = new FixtureOutput()): ProcessTerminalHost {
  return new ProcessTerminalHost(
    input as unknown as ReadStream,
    output as unknown as WriteStream,
    {},
  );
}

describe("process terminal host", () => {
  it("restores an initially nonflowing input so a detached CLI can exit", () => {
    for (const initial of [null, false] as const) {
      const input = new FixtureInput(initial);
      const close = processHost(input).open(
        () => undefined,
        () => undefined,
      );
      expect(input.isRaw).toBe(true);
      close();
      expect(input.isRaw).toBe(false);
      expect(input.pauses).toBe(1);
    }
  });

  it("restores an input that was already flowing before attachment", () => {
    const input = new FixtureInput(true);
    const close = processHost(input).open(
      () => undefined,
      () => undefined,
    );
    close();
    expect(input.pauses).toBe(0);
    expect(input.resumes).toBe(2);
  });

  it("ignores pasted multi-character input and normalizes deliberate control keys", () => {
    const input = new FixtureInput(null);
    const keys: TerminalKey[] = [];
    const close = processHost(input).open(
      (key) => keys.push(key),
      () => undefined,
    );
    input.emit("data", Buffer.from("copy"));
    input.emit("data", Buffer.from("p"));
    input.emit("data", Buffer.from("\u0003"));
    close();
    expect(keys).toEqual(["pause", "detach"]);
  });
});
