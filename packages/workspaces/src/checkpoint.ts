import { createHash, type Hash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import { canonicalJson, digestBytes } from "@anastom/core";
import { ensurePrivatePathRoot } from "@anastom/path-policy";
import {
  assertWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
  type WorkspaceDifference,
  type WorkspaceRef,
} from "@anastom/runtime-contract";

import { assertRunId, type GitWorkspaceManager } from "./index.js";

const exec = promisify(execFile);
const IGNORED_ENTRY_LIMIT = 4_096;
const IGNORED_BYTE_LIMIT = 64 * 1024 * 1024;
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const WORKSPACE_MANIFEST_MAX_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/** A stable checkpoint plus the binary-capable diff bytes it identifies. */
export interface WorkspaceCheckpointCapture {
  checkpoint: WorkspaceCheckpoint;
  diff: string;
}

/** Exact comparison result for every workspace recovery authorization dimension. */
export interface WorkspaceComparison {
  matches: boolean;
  differences: WorkspaceDifference[];
}

interface IgnoredEntry {
  path: string;
  target: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  size: number;
  symlinkBytes?: Buffer;
}

interface IgnoredCollection {
  entries: Map<string, IgnoredEntry>;
  byteCount: number;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await exec("git", args, {
      cwd,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      maxBuffer: GIT_OUTPUT_LIMIT,
    })
  ).stdout;
}

async function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  return (
    await exec("git", args, {
      cwd,
      encoding: "buffer",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      maxBuffer: GIT_OUTPUT_LIMIT,
    })
  ).stdout;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Workspace contains ${label} that is not valid UTF-8`);
  }
}

function decodeGitPaths(bytes: Buffer): string[] {
  return decodeUtf8(bytes, "a Git path").split("\0").filter(Boolean);
}

function lexicalChild(root: string, child: string): string {
  if (!child || child.includes("\0") || isAbsolute(child)) {
    throw new Error("Git returned an invalid workspace-relative path");
  }
  const target = resolve(root, child);
  const boundary = root.endsWith(sep) ? root : root + sep;
  if (!target.startsWith(boundary)) {
    throw new Error("Git returned a path outside the workspace");
  }
  return target;
}

function isWithin(root: string, path: string): boolean {
  const boundary = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(boundary);
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

function addIgnoredEntry(collection: IgnoredCollection, entry: IgnoredEntry): void {
  if (collection.entries.has(entry.path)) {
    return;
  }
  if (collection.entries.size >= IGNORED_ENTRY_LIMIT) {
    throw new Error("Ignored workspace content exceeds the checkpoint entry limit");
  }
  collection.byteCount += entry.size;
  if (collection.byteCount > IGNORED_BYTE_LIMIT) {
    throw new Error("Ignored workspace content exceeds the checkpoint byte limit");
  }
  collection.entries.set(entry.path, entry);
}

async function collectIgnoredEntry(
  workspacePath: string,
  path: string,
  collection: IgnoredCollection,
): Promise<void> {
  const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;
  if (collection.entries.has(normalizedPath)) {
    return;
  }
  const target = lexicalChild(workspacePath, normalizedPath);
  const metadata = await lstat(target, { bigint: true });
  const mode = Number(metadata.mode & 0o7777n);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    addIgnoredEntry(collection, { path: normalizedPath, target, type: "directory", mode, size: 0 });
    const children = await readdir(target, { encoding: "buffer", withFileTypes: true });
    for (const child of children) {
      await collectIgnoredEntry(
        workspacePath,
        `${normalizedPath}/${decodeUtf8(child.name, "a filesystem path")}`,
        collection,
      );
    }
    return;
  }
  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Ignored workspace file is too large to checkpoint");
    }
    addIgnoredEntry(collection, {
      path: normalizedPath,
      target,
      type: "file",
      mode,
      size: Number(metadata.size),
    });
    return;
  }
  if (metadata.isSymbolicLink()) {
    const bytes = await readlink(target, { encoding: "buffer" });
    const current = await lstat(target, { bigint: true });
    if (!sameIdentity(metadata, current)) {
      throw new Error("Ignored workspace symlink changed during checkpoint capture");
    }
    addIgnoredEntry(collection, {
      path: normalizedPath,
      target,
      type: "symlink",
      mode,
      size: bytes.byteLength,
      symlinkBytes: bytes,
    });
    return;
  }
  throw new Error("Ignored workspace content contains an unsupported file type");
}

async function hashFile(entry: IgnoredEntry, hash: Hash): Promise<void> {
  const initial = await lstat(entry.target, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size !== BigInt(entry.size)) {
    throw new Error("Ignored workspace file changed during checkpoint capture");
  }
  const handle = await open(entry.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(initial, opened)) {
      throw new Error("Ignored workspace file changed during checkpoint capture");
    }
    let total = 0;
    while (total <= entry.size) {
      const capacity = Math.min(READ_CHUNK_BYTES, entry.size + 1 - total);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, total);
      if (bytesRead === 0) {
        break;
      }
      hash.update(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    const current = await lstat(entry.target, { bigint: true });
    if (total !== entry.size || !sameIdentity(opened, final) || !sameIdentity(final, current)) {
      throw new Error("Ignored workspace file changed during checkpoint capture");
    }
  } finally {
    await handle.close();
  }
}

async function ignoredFingerprint(workspacePath: string): Promise<{
  digest: string;
  entryCount: number;
  byteCount: number;
}> {
  const roots = decodeGitPaths(
    await gitBytes(workspacePath, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]),
  ).sort();
  const collection: IgnoredCollection = { entries: new Map(), byteCount: 0 };
  for (const root of roots) {
    await collectIgnoredEntry(workspacePath, root, collection);
  }
  const hash = createHash("sha256");
  const entries = [...collection.entries.values()].sort((left, right) => {
    if (left.path < right.path) {
      return -1;
    }
    return left.path > right.path ? 1 : 0;
  });
  for (const entry of entries) {
    hash.update(
      canonicalJson({ path: entry.path, type: entry.type, mode: entry.mode, size: entry.size }),
    );
    hash.update("\0");
    if (entry.type === "file") {
      await hashFile(entry, hash);
    } else if (entry.type === "symlink") {
      hash.update(entry.symlinkBytes!);
    }
    hash.update("\0");
  }
  return {
    digest: `sha256:${hash.digest("hex")}`,
    entryCount: entries.length,
    byteCount: collection.byteCount,
  };
}

async function canonicalGitDirectory(workspacePath: string, flag: string): Promise<string> {
  const value = (await git(workspacePath, ["rev-parse", flag])).trim();
  return realpath(resolve(workspacePath, value));
}

async function collectOwnership(
  manager: GitWorkspaceManager,
  workspace: Exclude<WorkspaceRef, { mode: "memory" }>,
): Promise<WorkspaceCheckpoint["ownership"]> {
  assertRunId(workspace.id);
  const state = await ensurePrivatePathRoot(manager.stateDir);
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      (
        await state.readFile(["runs", workspace.id, "workspace.json"], {
          maxBytes: WORKSPACE_MANIFEST_MAX_BYTES,
        })
      ).toString("utf8"),
    );
  } catch {
    throw new Error("Missing or corrupt workspace ownership manifest");
  }
  if (!isDeepStrictEqual(manifest, workspace)) {
    throw new Error("Workspace ownership manifest does not match");
  }
  const repositoryRoot = await realpath(workspace.repoRoot);
  const workspacePath = await realpath(workspace.path);
  if (repositoryRoot !== workspace.repoRoot || workspacePath !== workspace.path) {
    throw new Error("Workspace roots must be canonical and nonsymlinked");
  }
  if (workspace.mode === "readonly" && isWithin(workspacePath, state.path)) {
    throw new Error("Readonly workspace checkpoints require private state outside the repository");
  }
  const rootFromGit = await realpath(
    (await git(workspace.path, ["rev-parse", "--show-toplevel"])).trim(),
  );
  let branch: string;
  try {
    branch = (await git(workspace.path, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    branch = "(detached)";
  }
  if (
    rootFromGit !== workspacePath ||
    (workspace.mode === "isolated" && branch !== workspace.branch)
  ) {
    throw new Error("Git workspace ownership changed");
  }
  const registration = (await git(repositoryRoot, ["worktree", "list", "--porcelain"]))
    .split("\n\n")
    .find((block) => block.startsWith(`worktree ${workspacePath}\n`));
  const expectedRegistration =
    branch === "(detached)" ? "\ndetached" : `\nbranch refs/heads/${branch}`;
  if (!registration || !registration.includes(expectedRegistration)) {
    throw new Error("Git worktree registration changed");
  }
  return {
    repositoryRoot,
    repositoryCommonDirectory: await canonicalGitDirectory(workspace.path, "--git-common-dir"),
    workspacePath,
    workspaceGitDirectory: await canonicalGitDirectory(workspace.path, "--git-dir"),
    branch,
    manifestDigest: digestBytes(canonicalJson(manifest)),
    registrationDigest: digestBytes(canonicalJson(registration)),
  };
}

/** Capture the same owned workspace twice and reject unstable or unauthenticated evidence. */
export async function captureWorkspaceCheckpoint(
  manager: GitWorkspaceManager,
  workspace: WorkspaceRef,
): Promise<WorkspaceCheckpointCapture> {
  if (workspace.mode === "memory") {
    throw new Error("Workspace checkpoints require a filesystem workspace");
  }
  const ownershipBefore = await collectOwnership(manager, workspace);
  const first = await manager.capture(workspace);
  const firstIgnored = await ignoredFingerprint(workspace.path);
  const second = await manager.capture(workspace);
  const secondIgnored = await ignoredFingerprint(workspace.path);
  const ownershipAfter = await collectOwnership(manager, workspace);
  if (
    !isDeepStrictEqual(first, second) ||
    !isDeepStrictEqual(firstIgnored, secondIgnored) ||
    !isDeepStrictEqual(ownershipBefore, ownershipAfter)
  ) {
    throw new Error("Workspace changed while its checkpoint was being captured");
  }
  const checkpoint: WorkspaceCheckpoint = {
    version: "anastom.dev/workspace-checkpoint/v1alpha1",
    workspaceId: workspace.id,
    baseCommit: workspace.baseCommit,
    headCommit: first.headCommit,
    diffDigest: digestBytes(first.diff),
    changedFiles: structuredClone(first.changedFiles),
    ignoredDigest: firstIgnored.digest,
    ignoredEntryCount: firstIgnored.entryCount,
    ignoredByteCount: firstIgnored.byteCount,
    ownership: ownershipBefore,
  };
  assertWorkspaceCheckpoint(checkpoint);
  return { checkpoint, diff: first.diff };
}

function pushDifference(
  differences: WorkspaceDifference[],
  difference: WorkspaceDifference,
  matches: boolean,
): void {
  if (!matches) {
    differences.push(difference);
  }
}

/** Compare every workspace field that can authorize an automatic replacement attempt. */
export function compareWorkspaceCheckpoints(
  expected: WorkspaceCheckpoint,
  observed: WorkspaceCheckpoint,
): WorkspaceComparison {
  assertWorkspaceCheckpoint(expected);
  assertWorkspaceCheckpoint(observed);
  const differences: WorkspaceDifference[] = [];
  pushDifference(differences, "version", expected.version === observed.version);
  pushDifference(differences, "workspace-id", expected.workspaceId === observed.workspaceId);
  pushDifference(differences, "base-commit", expected.baseCommit === observed.baseCommit);
  pushDifference(differences, "head-commit", expected.headCommit === observed.headCommit);
  pushDifference(differences, "diff-digest", expected.diffDigest === observed.diffDigest);
  pushDifference(
    differences,
    "changed-files",
    isDeepStrictEqual(expected.changedFiles, observed.changedFiles),
  );
  pushDifference(
    differences,
    "ignored-content",
    expected.ignoredDigest === observed.ignoredDigest &&
      expected.ignoredEntryCount === observed.ignoredEntryCount &&
      expected.ignoredByteCount === observed.ignoredByteCount,
  );
  pushDifference(
    differences,
    "repository",
    expected.ownership.repositoryRoot === observed.ownership.repositoryRoot &&
      expected.ownership.repositoryCommonDirectory === observed.ownership.repositoryCommonDirectory,
  );
  pushDifference(
    differences,
    "workspace-path",
    expected.ownership.workspacePath === observed.ownership.workspacePath &&
      expected.ownership.workspaceGitDirectory === observed.ownership.workspaceGitDirectory,
  );
  pushDifference(differences, "branch", expected.ownership.branch === observed.ownership.branch);
  pushDifference(
    differences,
    "ownership-manifest",
    expected.ownership.manifestDigest === observed.ownership.manifestDigest,
  );
  pushDifference(
    differences,
    "worktree-registration",
    expected.ownership.registrationDigest === observed.ownership.registrationDigest,
  );
  return { matches: differences.length === 0, differences };
}
