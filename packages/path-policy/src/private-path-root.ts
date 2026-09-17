import { randomUUID } from "node:crypto";
import { constants, lstatSync, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * A failure to preserve the private-state path ownership or bounded-I/O contract.
 * @public
 */
export class PrivatePathError extends Error {
  /** Classify invalid input separately from filesystem ownership and race failures. */
  constructor(
    readonly reason: "changed" | "invalid" | "limit" | "permissions" | "wrong-type",
    message: string,
  ) {
    super(message);
    this.name = "PrivatePathError";
  }
}

/** Fixed-segment access to current-user-owned private state beneath one canonical root. */
export interface PrivatePathRoot {
  readonly path: string;
  /** Create or validate private nonsymlinked directories beneath the root. */
  ensureDirectory(segments: readonly string[]): Promise<string>;
  /** Read one ordinary private file through a bounded descriptor and verify stable identity. */
  readFile(segments: readonly string[], options: { maxBytes: number }): Promise<Buffer>;
  /** Atomically replace one fixed private record and sync both file and parent. */
  writeFileAtomic(
    segments: readonly string[],
    bytes: Uint8Array,
    options: { maxBytes: number },
  ): Promise<void>;
  /** Atomically publish one immutable record, accepting only identical existing bytes. */
  writeFileExclusive(
    segments: readonly string[],
    bytes: Uint8Array,
    options: { maxBytes: number },
  ): Promise<void>;
  /** Build a contained fixed-segment socket path under an explicit UTF-8 byte limit. */
  socketPath(segments: readonly string[], options: { maxBytes: number }): string;
}

function currentUid(): number {
  if (!process.getuid) {
    throw new PrivatePathError("permissions", "Private state requires POSIX user ownership");
  }
  return process.getuid();
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new PrivatePathError("invalid", "Private path byte limit must be a safe integer");
  }
}

function validateSegments(segments: readonly string[], allowEmpty: boolean): string[] {
  if (!Array.isArray(segments) || (!allowEmpty && segments.length === 0)) {
    throw new PrivatePathError("invalid", "Private path requires fixed filename segments");
  }
  return segments.map((segment) => {
    if (
      typeof segment !== "string" ||
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\0") ||
      segment.includes("/") ||
      segment.includes("\\") ||
      isAbsolute(segment) ||
      basename(segment) !== segment
    ) {
      throw new PrivatePathError("invalid", "Private path segment must be one filename component");
    }
    return segment;
  });
}

function containedPath(root: string, segments: readonly string[], allowEmpty = false): string {
  const validated = validateSegments(segments, allowEmpty);
  const target = resolve(root, ...validated);
  const boundary = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(boundary)) {
    throw new PrivatePathError("invalid", "Private path escapes its root");
  }
  return target;
}

function assertPrivateOwner(metadata: BigIntStats): void {
  if (metadata.uid !== BigInt(currentUid())) {
    throw new PrivatePathError("permissions", "Private path must be owned by the current user");
  }
}

async function requirePrivateDirectory(path: string): Promise<BigIntStats> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PrivatePathError("wrong-type", "Private path parent must be an ordinary directory");
  }
  assertPrivateOwner(metadata);
  if ((metadata.mode & 0o777n) !== BigInt(PRIVATE_DIRECTORY_MODE)) {
    throw new PrivatePathError("permissions", "Private directory must have mode 0700");
  }
  return metadata;
}

function requirePrivateDirectorySync(path: string): void {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PrivatePathError("wrong-type", "Private path parent must be an ordinary directory");
  }
  assertPrivateOwner(metadata);
  if ((metadata.mode & 0o777n) !== BigInt(PRIVATE_DIRECTORY_MODE)) {
    throw new PrivatePathError("permissions", "Private directory must have mode 0700");
  }
}

async function validateParents(root: string, segments: readonly string[]): Promise<string> {
  await requirePrivateDirectory(root);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    await requirePrivateDirectory(parent);
  }
  return parent;
}

function validateParentsSync(root: string, segments: readonly string[]): void {
  requirePrivateDirectorySync(root);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    requirePrivateDirectorySync(parent);
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertBoundedBytes(bytes: Uint8Array, maxBytes: number): void {
  validateLimit(maxBytes);
  if (!(bytes instanceof Uint8Array)) {
    throw new PrivatePathError("invalid", "Private record bytes must be a Uint8Array");
  }
  if (bytes.byteLength > maxBytes) {
    throw new PrivatePathError("limit", "Private record exceeds its byte limit");
  }
}

async function writeTemporary(parent: string, bytes: Uint8Array): Promise<string> {
  const temporary = join(parent, `.anastom-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function boundedDescriptorRead(path: string, maxBytes: number): Promise<Buffer> {
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new PrivatePathError("wrong-type", "Private record must be an ordinary file");
  }
  assertPrivateOwner(initial);
  if ((initial.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE)) {
    throw new PrivatePathError("permissions", "Private record must have mode 0600");
  }
  if (initial.size > BigInt(maxBytes)) {
    throw new PrivatePathError("limit", "Private record exceeds its byte limit");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(initial, opened)) {
      throw new PrivatePathError("changed", "Private record changed while it was opened");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const capacity = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, total);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new PrivatePathError("limit", "Private record exceeds its byte limit");
    }
    const final = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!sameIdentity(opened, final) || !sameIdentity(final, current)) {
      throw new PrivatePathError("changed", "Private record changed while it was read");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

class PrivatePathRootImplementation implements PrivatePathRoot {
  constructor(readonly path: string) {}

  async ensureDirectory(segments: readonly string[]): Promise<string> {
    const validated = validateSegments(segments, true);
    await requirePrivateDirectory(this.path);
    let current = this.path;
    for (const segment of validated) {
      current = join(current, segment);
      try {
        await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
        await chmod(current, PRIVATE_DIRECTORY_MODE);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
      }
      await requirePrivateDirectory(current);
    }
    return current;
  }

  async readFile(segments: readonly string[], options: { maxBytes: number }): Promise<Buffer> {
    validateLimit(options.maxBytes);
    const validated = validateSegments(segments, false);
    await validateParents(this.path, validated);
    return boundedDescriptorRead(containedPath(this.path, validated), options.maxBytes);
  }

  async writeFileAtomic(
    segments: readonly string[],
    bytes: Uint8Array,
    options: { maxBytes: number },
  ): Promise<void> {
    assertBoundedBytes(bytes, options.maxBytes);
    const validated = validateSegments(segments, false);
    const parent = await validateParents(this.path, validated);
    const target = containedPath(this.path, validated);
    try {
      const existing = await lstat(target, { bigint: true });
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new PrivatePathError("wrong-type", "Private record target must be an ordinary file");
      }
      assertPrivateOwner(existing);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    let temporary: string | undefined;
    let published = false;
    try {
      temporary = await writeTemporary(parent, bytes);
      await requirePrivateDirectory(parent);
      await rename(temporary, target);
      published = true;
      await syncDirectory(parent);
      const observed = await boundedDescriptorRead(target, options.maxBytes);
      if (!observed.equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) {
        throw new PrivatePathError("changed", "Private record bytes changed during publication");
      }
    } finally {
      if (!published && temporary) {
        await unlink(temporary).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        });
      }
    }
  }

  async writeFileExclusive(
    segments: readonly string[],
    bytes: Uint8Array,
    options: { maxBytes: number },
  ): Promise<void> {
    assertBoundedBytes(bytes, options.maxBytes);
    const validated = validateSegments(segments, false);
    const parent = await validateParents(this.path, validated);
    const target = containedPath(this.path, validated);
    const temporary = await writeTemporary(parent, bytes);
    let created = false;
    try {
      await requirePrivateDirectory(parent);
      try {
        await link(temporary, target);
        created = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
      }
      await unlink(temporary);
      if (created) {
        await syncDirectory(parent);
      }
      const observed = await boundedDescriptorRead(target, options.maxBytes);
      if (!observed.equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) {
        throw new PrivatePathError("changed", "Existing private record bytes differ");
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      });
    }
  }

  socketPath(segments: readonly string[], options: { maxBytes: number }): string {
    validateLimit(options.maxBytes);
    const validated = validateSegments(segments, false);
    validateParentsSync(this.path, validated);
    const target = containedPath(this.path, validated);
    if (Buffer.byteLength(target) > options.maxBytes) {
      throw new PrivatePathError("limit", "Private socket path exceeds its byte limit");
    }
    return target;
  }
}

/**
 * Create or validate one canonical current-user-owned private state root.
 * Existing owner-controlled roots are tightened to mode 0700 before use.
 */
export async function ensurePrivatePathRoot(path: string): Promise<PrivatePathRoot> {
  if (!path || path.includes("\0")) {
    throw new PrivatePathError("invalid", "Private state root is empty or contains a null byte");
  }
  const lexical = resolve(path);
  const parent = await realpath(dirname(lexical));
  const canonical = join(parent, basename(lexical));
  if (!basename(lexical) || lexical === dirname(lexical)) {
    throw new PrivatePathError("invalid", "Private state root must name a leaf directory");
  }
  try {
    await mkdir(canonical, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  const metadata = await lstat(canonical, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PrivatePathError("wrong-type", "Private state root must be an ordinary directory");
  }
  assertPrivateOwner(metadata);
  await chmod(canonical, PRIVATE_DIRECTORY_MODE);
  if ((await realpath(canonical)) !== canonical) {
    throw new PrivatePathError("invalid", "Private state root must be canonical and nonsymlinked");
  }
  await requirePrivateDirectory(canonical);
  return new PrivatePathRootImplementation(canonical);
}
