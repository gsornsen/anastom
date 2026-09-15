/** Strict bounded UTF-8 JSONL framing; opaque payloads are retained only until one frame is handled. */
export class JsonlDecoder {
  private pending = Buffer.alloc(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  /** Bind the maximum frame bytes; partial UTF-8 code points remain buffered as bytes. */
  constructor(private readonly maxBytes = 1_048_576) {}

  /** Decode complete frames and fail closed on oversized frames, invalid UTF-8 or invalid JSON. */
  push(chunk: Buffer): unknown[] {
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.pending.length + part.length > this.maxBytes) {
        throw new Error("Native JSONL frame exceeds limit");
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

  /** Require newline-terminated frames at EOF, preventing an incomplete required outcome. */
  finish(): void {
    if (this.pending.length) {
      throw new Error("Incomplete native JSONL frame");
    }
  }

  private parse(): unknown {
    const text = this.decoder.decode(this.pending);
    this.pending = Buffer.alloc(0);
    if (!text.trim()) {
      throw new Error("Empty native JSONL frame");
    }
    return JSON.parse(text) as unknown;
  }
}
