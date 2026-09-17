import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Read one already-authorized ordinary file without following a replaced final symlink. */
export async function readBoundedUtf8(
  path: string,
  options: { maxBytes: number; label: string },
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) {
      throw new Error(`${options.label} must be an ordinary file`);
    }
    if (initial.size > options.maxBytes) {
      throw new Error(`${options.label} exceeds ${options.maxBytes} bytes`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= options.maxBytes) {
      const capacity = Math.min(READ_CHUNK_BYTES, options.maxBytes + 1 - total);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, total);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > options.maxBytes) {
      throw new Error(`${options.label} exceeds ${options.maxBytes} bytes`);
    }
    const final = await handle.stat();
    if (!sameIdentity(initial, final)) {
      throw new Error(`${options.label} changed while it was read`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new Error(`${options.label} must contain valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}
