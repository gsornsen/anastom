/** Fatal UTF-8, newline-terminated, bounded native JSONL; opaque frames are short-lived. */
export class ClaudeJsonlDecoder {
  private pending = Buffer.alloc(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  /** Limit every frame independently of the adapter's total stdout bound. */
  constructor(private readonly maxFrameBytes = 1_048_576) {}

  /** Parse newline-terminated frames, including split UTF-8 byte sequences. */
  push(chunk: Buffer): unknown[] {
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.pending.length + part.length > this.maxFrameBytes) {
        throw new Error("Claude Code native JSONL frame exceeds limit");
      }
      this.pending = Buffer.concat([this.pending, part]);
      if (newline < 0) {
        break;
      }
      frames.push(this.parse());
      offset = newline + 1;
    }
    return frames;
  }

  /** Reject a truncated final native frame. */
  finish(): void {
    if (this.pending.length) {
      throw new Error("Claude Code native JSONL frame ended prematurely");
    }
  }

  private parse(): unknown {
    const decoded = this.decoder.decode(this.pending);
    this.pending = Buffer.alloc(0);
    if (!decoded.trim()) {
      throw new Error("Empty Claude Code native JSONL frame");
    }
    return JSON.parse(decoded) as unknown;
  }
}
