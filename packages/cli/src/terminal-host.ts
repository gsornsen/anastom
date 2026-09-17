import type { ReadStream, WriteStream } from "node:tty";

/** Normalized keys understood by the terminal attachment controller. */
export type TerminalKey = "pause" | "cancel" | "resume" | "detach";

/** Minimal terminal capability used by the interactive CLI and recorded acceptance tests. */
export interface TerminalHost {
  /** Return the current terminal dimensions. */
  size(): { columns: number; rows: number };
  /** Whether presentation color is enabled for this terminal. */
  color(): boolean;
  /** Write terminal bytes without adding a newline. */
  write(value: string): void;
  /** Enter key/resize capture and return an idempotent restoration callback. */
  open(onKey: (key: TerminalKey) => void, onResize: () => void): () => void;
}

/** Node process terminal host with paired raw-mode and listener restoration. */
export class ProcessTerminalHost implements TerminalHost {
  /** Bind the current process TTY streams without exposing them to the view renderer. */
  constructor(
    private readonly input: ReadStream = process.stdin,
    private readonly output: WriteStream = process.stdout,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Report whether both input and output support an interactive terminal session. */
  interactive(): boolean {
    return this.input.isTTY === true && this.output.isTTY === true;
  }

  /** Read current dimensions with conservative fallbacks for incomplete terminal metadata. */
  size(): { columns: number; rows: number } {
    return {
      columns: this.output.columns || 80,
      rows: this.output.rows || 24,
    };
  }

  /** Honor NO_COLOR and terminals that explicitly identify themselves as noninteractive. */
  color(): boolean {
    return this.environment.NO_COLOR === undefined && this.environment.TERM !== "dumb";
  }

  /** Write exact terminal bytes. */
  write(value: string): void {
    this.output.write(value);
  }

  /** Capture normalized single-key controls while preserving the stream's prior raw/flow state. */
  open(onKey: (key: TerminalKey) => void, onResize: () => void): () => void {
    if (!this.interactive()) {
      throw new Error("Interactive terminal input and output are required");
    }
    const wasRaw = this.input.isRaw === true;
    const wasFlowing = this.input.readableFlowing;
    const data = (value: Buffer | string): void => {
      const characters = [...value.toString("utf8")];
      if (characters.length !== 1) {
        return;
      }
      const key = normalizedKey(characters[0] ?? "");
      if (key) {
        onKey(key);
      }
    };
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", data);
    this.output.on("resize", onResize);
    let closed = false;
    return () => {
      if (closed) {
        return;
      }
      closed = true;
      this.input.off("data", data);
      this.output.off("resize", onResize);
      this.input.setRawMode(wasRaw);
      if (wasFlowing === true) {
        this.input.resume();
      } else {
        this.input.pause();
      }
    };
  }
}

function normalizedKey(character: string): TerminalKey | undefined {
  if (character === "p" || character === "P") {
    return "pause";
  }
  if (character === "c" || character === "C") {
    return "cancel";
  }
  if (character === "r" || character === "R") {
    return "resume";
  }
  if (character === "d" || character === "D" || character === "q" || character === "Q") {
    return "detach";
  }
  return character === "\u0003" ? "detach" : undefined;
}
