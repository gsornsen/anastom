import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { canonicalJson, digestBytes } from "../packages/core/src/index.js";
import type { WorkspaceCapture, WorkspaceRef } from "../packages/runtime-contract/src/index.js";
import { assertRunId, type GitWorkspaceManager } from "../packages/workspaces/src/index.js";

const execFileAsync = promisify(execFile);
const ignoredEntryLimit = 4_096;
const ignoredByteLimit = 67_108_864;

interface M3WorkspaceOwnership {
  repoRoot: string;
  repositoryCommonDir: string;
  workspacePath: string;
  workspaceGitDir: string;
  branch: string;
  manifestDigest: string;
  registrationDigest: string;
}

/** Exact pre-attempt workspace identity evaluated by the M3 feasibility probe. */
export interface M3WorkspaceCheckpoint {
  version: "anastom.dev/m3-workspace-checkpoint/v1alpha1";
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  diffDigest: string;
  changedFiles: string[];
  ignoredDigest: string;
  ignoredEntryCount: number;
  ignoredByteCount: number;
  ownership: M3WorkspaceOwnership;
}

/** Binary-capable diff bytes retained alongside one feasibility checkpoint. */
export interface M3WorkspaceCheckpointCapture {
  checkpoint: M3WorkspaceCheckpoint;
  diff: string;
}

/** Classified exact-checkpoint fields that differ during recovery reconciliation. */
type M3WorkspaceDifference =
  | "version"
  | "workspace-id"
  | "base-commit"
  | "head-commit"
  | "diff-digest"
  | "changed-files"
  | "ignored-content"
  | "repository"
  | "workspace-path"
  | "branch"
  | "ownership-manifest"
  | "worktree-registration";

/** Exact comparison outcome used by the workspace feasibility probe. */
export interface M3WorkspaceComparison {
  matches: boolean;
  differences: M3WorkspaceDifference[];
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      maxBuffer: 16_777_216,
    })
  ).stdout;
}

async function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    maxBuffer: 16_777_216,
  });
  return result.stdout;
}

function decodeGitPaths(bytes: Buffer): string[] {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Workspace contains a Git path that is not valid UTF-8");
  }
  return decoded.split("\0").filter(Boolean);
}

function decodePathComponent(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Workspace contains a filesystem path that is not valid UTF-8");
  }
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

interface IgnoredEntry {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  bytes: Buffer;
}

function addIgnoredEntry(entries: Map<string, IgnoredEntry>, entry: IgnoredEntry): void {
  if (!entries.has(entry.path) && entries.size >= ignoredEntryLimit) {
    throw new Error("Ignored workspace content exceeds the checkpoint entry limit");
  }
  entries.set(entry.path, entry);
}

function compareEntryPaths(left: IgnoredEntry, right: IgnoredEntry): number {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return 0;
}

async function collectIgnoredEntry(
  workspacePath: string,
  path: string,
  entries: Map<string, IgnoredEntry>,
): Promise<void> {
  const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;
  if (entries.has(normalizedPath)) {
    return;
  }
  const target = lexicalChild(workspacePath, normalizedPath);
  const metadata = await lstat(target);
  if (metadata.isDirectory()) {
    addIgnoredEntry(entries, {
      path: normalizedPath,
      type: "directory",
      mode: metadata.mode & 0o7777,
      bytes: Buffer.alloc(0),
    });
    const children = await readdir(target, { encoding: "buffer", withFileTypes: true });
    for (const child of children) {
      await collectIgnoredEntry(
        workspacePath,
        `${normalizedPath}/${decodePathComponent(child.name)}`,
        entries,
      );
    }
    return;
  }
  if (metadata.isFile()) {
    addIgnoredEntry(entries, {
      path: normalizedPath,
      type: "file",
      mode: metadata.mode & 0o7777,
      bytes: await readFile(target),
    });
    return;
  }
  if (metadata.isSymbolicLink()) {
    addIgnoredEntry(entries, {
      path: normalizedPath,
      type: "symlink",
      mode: metadata.mode & 0o7777,
      bytes: await readlink(target, { encoding: "buffer" }),
    });
    return;
  }
  throw new Error("Ignored workspace content contains an unsupported file type");
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
  const entries = new Map<string, IgnoredEntry>();
  for (const root of roots) {
    await collectIgnoredEntry(workspacePath, root, entries);
  }
  const hash = createHash("sha256");
  let byteCount = 0;
  const orderedEntries = [...entries.values()].sort(compareEntryPaths);
  for (const entry of orderedEntries) {
    byteCount += entry.bytes.length;
    if (byteCount > ignoredByteLimit) {
      throw new Error("Ignored workspace content exceeds the checkpoint byte limit");
    }
    hash.update(
      canonicalJson({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        size: entry.bytes.length,
      }),
    );
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return {
    digest: `sha256:${hash.digest("hex")}`,
    entryCount: orderedEntries.length,
    byteCount,
  };
}

async function canonicalGitDirectory(workspacePath: string, flag: string): Promise<string> {
  const value = (await git(workspacePath, ["rev-parse", flag])).trim();
  return realpath(resolve(workspacePath, value));
}

async function requireOrdinaryFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary file`);
  }
}

async function collectOwnership(
  manager: GitWorkspaceManager,
  workspace: Extract<WorkspaceRef, { mode: "isolated" }>,
): Promise<M3WorkspaceOwnership> {
  assertRunId(workspace.id);
  const lexicalStateDir = resolve(manager.stateDir);
  const canonicalStateDir = await realpath(lexicalStateDir);
  const stateMetadata = await lstat(lexicalStateDir);
  if (!stateMetadata.isDirectory() || stateMetadata.isSymbolicLink()) {
    throw new Error("Workspace state directory must be an ordinary directory");
  }
  const runs = join(canonicalStateDir, "runs");
  const runDirectory = join(runs, workspace.id);
  const manifestPath = join(runDirectory, "workspace.json");
  for (const [path, label] of [
    [runs, "Workspace runs directory"],
    [runDirectory, "Workspace run directory"],
  ] as const) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} must be an ordinary directory`);
    }
  }
  await requireOrdinaryFile(manifestPath, "Workspace ownership manifest");
  const rawManifest = await readFile(manifestPath, "utf8");
  let manifest: unknown;
  try {
    manifest = JSON.parse(rawManifest) as unknown;
  } catch {
    throw new Error("Workspace ownership manifest is invalid JSON");
  }
  const repoRoot = await realpath(workspace.repoRoot);
  const workspacePath = await realpath(workspace.path);
  if (repoRoot !== workspace.repoRoot || workspacePath !== workspace.path) {
    throw new Error("Workspace roots must be canonical and nonsymlinked");
  }
  const rootFromGit = await realpath(
    (await git(workspace.path, ["rev-parse", "--show-toplevel"])).trim(),
  );
  if (rootFromGit !== workspacePath) {
    throw new Error("Git workspace root changed");
  }
  const branch = (await git(workspace.path, ["symbolic-ref", "--short", "HEAD"])).trim();
  const registration = (await git(repoRoot, ["worktree", "list", "--porcelain"]))
    .split("\n\n")
    .find((block) => block.startsWith(`worktree ${workspacePath}\n`));
  if (!registration || !registration.includes(`\nbranch refs/heads/${branch}`)) {
    throw new Error("Git worktree registration changed");
  }
  return {
    repoRoot,
    repositoryCommonDir: await canonicalGitDirectory(workspace.path, "--git-common-dir"),
    workspacePath,
    workspaceGitDir: await canonicalGitDirectory(workspace.path, "--git-dir"),
    branch,
    manifestDigest: digestBytes(canonicalJson(manifest)),
    registrationDigest: digestBytes(canonicalJson(registration)),
  };
}

function changedNamesExistInRawWorkspace(capture: WorkspaceCapture, rawNames: string[]): boolean {
  const observed = new Set(rawNames);
  return capture.changedFiles.every((name) => observed.has(name));
}

/** Capture the same workspace twice and reject unstable or unauthenticated observations. */
export async function captureM3WorkspaceCheckpoint(
  manager: GitWorkspaceManager,
  workspace: WorkspaceRef,
): Promise<M3WorkspaceCheckpointCapture> {
  if (workspace.mode !== "isolated") {
    throw new Error("M3 workspace checkpoints require an owned isolated workspace");
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
  const rawWorkspaceNames = decodeGitPaths(
    await gitBytes(workspace.path, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  );
  if (!changedNamesExistInRawWorkspace(first, rawWorkspaceNames)) {
    throw new Error("Workspace changed-file names are not stable UTF-8 evidence");
  }
  return {
    checkpoint: {
      version: "anastom.dev/m3-workspace-checkpoint/v1alpha1",
      workspaceId: workspace.id,
      baseCommit: workspace.baseCommit,
      headCommit: first.headCommit,
      diffDigest: digestBytes(first.diff),
      changedFiles: structuredClone(first.changedFiles),
      ignoredDigest: firstIgnored.digest,
      ignoredEntryCount: firstIgnored.entryCount,
      ignoredByteCount: firstIgnored.byteCount,
      ownership: ownershipBefore,
    },
    diff: first.diff,
  };
}

function pushDifference(
  differences: M3WorkspaceDifference[],
  difference: M3WorkspaceDifference,
  matches: boolean,
): void {
  if (!matches) {
    differences.push(difference);
  }
}

/** Compare every field that can authorize an automatic replacement attempt. */
export function compareM3WorkspaceCheckpoints(
  expected: M3WorkspaceCheckpoint,
  observed: M3WorkspaceCheckpoint,
): M3WorkspaceComparison {
  const differences: M3WorkspaceDifference[] = [];
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
    expected.ownership.repoRoot === observed.ownership.repoRoot &&
      expected.ownership.repositoryCommonDir === observed.ownership.repositoryCommonDir,
  );
  pushDifference(
    differences,
    "workspace-path",
    expected.ownership.workspacePath === observed.ownership.workspacePath &&
      expected.ownership.workspaceGitDir === observed.ownership.workspaceGitDir,
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
