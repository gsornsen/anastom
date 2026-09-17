import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { GitWorkspaceManager } from "../packages/workspaces/src/index.js";
import {
  createEndpointRepository,
  removeEndpointRepository,
} from "../packages/engine/src/testing/fixture.js";
import type { WorkspaceRef } from "../packages/runtime-contract/src/index.js";
import {
  captureM3WorkspaceCheckpoint,
  compareM3WorkspaceCheckpoints,
  type M3WorkspaceCheckpoint,
  type M3WorkspaceCheckpointCapture,
} from "./m3-workspace-checkpoint.js";

const execFileAsync = promisify(execFile);

/** Model-free evidence for exact M3 workspace checkpoint and ownership comparisons. */
export interface M3WorkspaceCheckpointEvidence {
  version: "anastom.dev/m3-workspace-checkpoint-evidence/v1alpha1";
  platform: NodeJS.Platform;
  architecture: string;
  capture: {
    repeatable: boolean;
    stagingPreserved: boolean;
    stagingStateNonAuthoritative: boolean;
    committedCaptured: boolean;
    trackedCaptured: boolean;
    untrackedCaptured: boolean;
    stagedCaptured: boolean;
    binaryCaptured: boolean;
    symlinkCapturedWithoutFollowing: boolean;
    ignoredContentFingerprinted: boolean;
    invalidUtf8PathRejected: boolean;
  };
  contentConflicts: {
    trackedDetected: boolean;
    untrackedDetected: boolean;
    binaryDetected: boolean;
    symlinkTargetDetected: boolean;
    ignoredDetected: boolean;
    ignoredDirectoryDetected: boolean;
    headCommitDetected: boolean;
  };
  ownershipConflicts: {
    branchRejected: boolean;
    manifestMismatchRejected: boolean;
    manifestSymlinkRejected: boolean;
    workspaceSymlinkRejected: boolean;
    registrationChangeRejected: boolean;
    repositoryIdentityDetectedWithSameGitContent: boolean;
  };
  restoration: {
    exactAfterContentRestoration: boolean;
    exactAfterOwnershipRestoration: boolean;
    sourceCheckoutUnchanged: boolean;
  };
  conclusion: {
    temporaryIndexCheckpoint: "feasible";
    ignoredFingerprint: "required";
    stagingState: "non-authoritative";
    ownershipIdentity: "required";
    publicWorkspaceApiFrozen: false;
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      maxBuffer: 16_777_216,
    })
  ).stdout.trim();
}

function requiredIsolated(workspace: WorkspaceRef): Extract<WorkspaceRef, { mode: "isolated" }> {
  if (workspace.mode !== "isolated") {
    throw new Error("Workspace checkpoint probe requires an isolated workspace");
  }
  return workspace;
}

async function commitFixture(cwd: string, message: string): Promise<void> {
  await git(cwd, [
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

async function captureRejected(
  manager: GitWorkspaceManager,
  workspace: WorkspaceRef,
): Promise<boolean> {
  try {
    await captureM3WorkspaceCheckpoint(manager, workspace);
    return false;
  } catch {
    return true;
  }
}

function checkpointMatches(
  expected: M3WorkspaceCheckpoint,
  observed: M3WorkspaceCheckpointCapture,
): boolean {
  return compareM3WorkspaceCheckpoints(expected, observed.checkpoint).matches;
}

function checkpointDetects(
  expected: M3WorkspaceCheckpoint,
  observed: M3WorkspaceCheckpointCapture,
  difference: ReturnType<typeof compareM3WorkspaceCheckpoints>["differences"][number],
): boolean {
  return compareM3WorkspaceCheckpoints(expected, observed.checkpoint).differences.includes(
    difference,
  );
}

function contentEquivalent(first: M3WorkspaceCheckpoint, second: M3WorkspaceCheckpoint): boolean {
  return (
    first.workspaceId === second.workspaceId &&
    first.baseCommit === second.baseCommit &&
    first.headCommit === second.headCommit &&
    first.diffDigest === second.diffDigest &&
    JSON.stringify(first.changedFiles) === JSON.stringify(second.changedFiles) &&
    first.ignoredDigest === second.ignoredDigest &&
    first.ignoredEntryCount === second.ignoredEntryCount &&
    first.ignoredByteCount === second.ignoredByteCount
  );
}

async function createIdentityClone(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anastom-workspace-clone-"));
  await git(root, ["clone", "-q", source, "."]);
  await git(root, ["config", "user.name", "Anastom Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  return root;
}

async function prepareRichWorkspace(workspace: Extract<WorkspaceRef, { mode: "isolated" }>) {
  const serverPath = join(workspace.path, "server.mjs");
  const packagePath = join(workspace.path, "package.json");
  const committedPath = join(workspace.path, "committed.txt");
  const untrackedPath = join(workspace.path, "untracked.txt");
  const binaryPath = join(workspace.path, "binary.dat");
  const symlinkPath = join(workspace.path, "linked.txt");
  const ignoredPath = join(workspace.path, "node_modules", "checkpoint.txt");
  const ignoredDirectory = join(workspace.path, "node_modules", "empty");

  await writeFile(committedPath, "committed checkpoint content\n");
  await git(workspace.path, ["add", "committed.txt"]);
  await commitFixture(workspace.path, "checkpoint fixture commit");

  const server = await readFile(serverPath, "utf8");
  const packageJson = await readFile(packagePath, "utf8");
  const packageValue = JSON.parse(packageJson) as Record<string, unknown>;
  packageValue.checkpointFixture = true;
  await writeFile(serverPath, `${server}\n// tracked checkpoint change\n`);
  await writeFile(packagePath, `${JSON.stringify(packageValue, null, 2)}\n`);
  await git(workspace.path, ["add", "package.json"]);
  await writeFile(untrackedPath, "untracked checkpoint content\n");
  const binary = Buffer.from([0, 1, 2, 3, 255, 0, 127, 64]);
  await writeFile(binaryPath, binary);
  await symlink("../outside-checkpoint-target", symlinkPath);
  await mkdir(join(workspace.path, "node_modules"), { recursive: true });
  await mkdir(ignoredDirectory);
  await writeFile(ignoredPath, "ignored checkpoint baseline\n");
  return {
    serverPath,
    packagePath,
    untrackedPath,
    binaryPath,
    symlinkPath,
    ignoredPath,
    ignoredDirectory,
    binary,
    original: { server, packageJson },
  };
}

function allEvidencePassed(evidence: M3WorkspaceCheckpointEvidence): boolean {
  return [
    evidence.capture,
    evidence.contentConflicts,
    evidence.ownershipConflicts,
    evidence.restoration,
  ].every((section) => Object.values(section).every(Boolean));
}

/** Run the exact-content and ownership-boundary workspace feasibility matrix. */
export async function runM3WorkspaceCheckpointProbe(): Promise<M3WorkspaceCheckpointEvidence> {
  const sourceRoot = await createEndpointRepository();
  const cloneRoot = await createIdentityClone(sourceRoot);
  try {
    const sourceManager = new GitWorkspaceManager(join(sourceRoot, ".anastom"));
    const cloneManager = new GitWorkspaceManager(join(cloneRoot, ".anastom"));
    const sourceIdentity = requiredIsolated(await sourceManager.create(sourceRoot, "identity"));
    const cloneIdentity = requiredIsolated(await cloneManager.create(cloneRoot, "identity"));
    const sourceIdentityCheckpoint = await captureM3WorkspaceCheckpoint(
      sourceManager,
      sourceIdentity,
    );
    const cloneIdentityCheckpoint = await captureM3WorkspaceCheckpoint(cloneManager, cloneIdentity);
    const identityComparison = compareM3WorkspaceCheckpoints(
      sourceIdentityCheckpoint.checkpoint,
      cloneIdentityCheckpoint.checkpoint,
    );

    const workspace = requiredIsolated(await sourceManager.create(sourceRoot, "checkpoint"));
    const paths = await prepareRichWorkspace(workspace);
    const stagedBefore = await git(workspace.path, ["diff", "--cached", "--name-only", "-z"]);
    const expected = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    const repeated = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    const stagedAfter = await git(workspace.path, ["diff", "--cached", "--name-only", "-z"]);

    await git(workspace.path, ["reset", "-q", "HEAD", "--", "package.json"]);
    const unstagedEquivalent = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    await git(workspace.path, ["add", "package.json"]);

    await writeFile(paths.serverPath, `${paths.original.server}\n// changed again\n`);
    const trackedConflict = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    await writeFile(paths.serverPath, `${paths.original.server}\n// tracked checkpoint change\n`);

    await writeFile(paths.untrackedPath, "different untracked content\n");
    const untrackedConflict = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    await writeFile(paths.untrackedPath, "untracked checkpoint content\n");

    await writeFile(paths.binaryPath, Buffer.from([...paths.binary, 9]));
    const binaryConflict = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    await writeFile(paths.binaryPath, paths.binary);

    await unlink(paths.symlinkPath);
    await symlink("../another-checkpoint-target", paths.symlinkPath);
    const symlinkConflict = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    await unlink(paths.symlinkPath);
    await symlink("../outside-checkpoint-target", paths.symlinkPath);

    await writeFile(paths.ignoredPath, "changed ignored content\n");
    const ignoredConflict = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    await writeFile(paths.ignoredPath, "ignored checkpoint baseline\n");

    const additionalIgnoredDirectory = `${paths.ignoredDirectory}-added`;
    await mkdir(additionalIgnoredDirectory);
    const ignoredDirectoryConflict = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    await rm(additionalIgnoredDirectory, { recursive: true });

    const invalidUtf8Path = Buffer.concat([
      Buffer.from(`${workspace.path}/invalid-`),
      Buffer.from([0xff]),
    ]);
    let invalidUtf8PathRejected: boolean;
    try {
      await writeFile(invalidUtf8Path, "invalid path encoding\n");
      invalidUtf8PathRejected = await captureRejected(sourceManager, workspace);
      await unlink(invalidUtf8Path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EILSEQ")) {
        throw error;
      }
      invalidUtf8PathRejected = true;
    }

    const originalHead = await git(workspace.path, ["rev-parse", "HEAD"]);
    const tree = await git(workspace.path, ["rev-parse", "HEAD^{tree}"]);
    const nextHead = await git(workspace.path, [
      "commit-tree",
      tree,
      "-p",
      originalHead,
      "-m",
      "head change",
    ]);
    await git(workspace.path, ["update-ref", "HEAD", nextHead, originalHead]);
    const headConflict = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    await git(workspace.path, ["update-ref", "HEAD", originalHead, nextHead]);

    const restoredContent = await captureM3WorkspaceCheckpoint(sourceManager, workspace);

    const unexpectedBranch = "unexpected-checkpoint-branch";
    await git(workspace.path, ["branch", unexpectedBranch, originalHead]);
    await git(workspace.path, ["symbolic-ref", "HEAD", `refs/heads/${unexpectedBranch}`]);
    const branchRejected = await captureRejected(sourceManager, workspace);
    await git(workspace.path, ["symbolic-ref", "HEAD", `refs/heads/${workspace.branch}`]);

    const manifestPath = join(sourceManager.stateDir, "runs", workspace.id, "workspace.json");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, JSON.stringify({ ...workspace, branch: unexpectedBranch }));
    const manifestMismatchRejected = await captureRejected(sourceManager, workspace);
    await writeFile(manifestPath, manifest);

    const manifestBackup = join(resolve(manifestPath, ".."), "workspace.backup.json");
    await rename(manifestPath, manifestBackup);
    await symlink(basename(manifestBackup), manifestPath);
    const manifestSymlinkRejected = await captureRejected(sourceManager, workspace);
    await unlink(manifestPath);
    await rename(manifestBackup, manifestPath);

    const movedWorkspace = `${workspace.path}-moved`;
    await rename(workspace.path, movedWorkspace);
    await symlink(movedWorkspace, workspace.path, "dir");
    const workspaceSymlinkRejected = await captureRejected(sourceManager, workspace);
    await unlink(workspace.path);
    await rename(movedWorkspace, workspace.path);

    const registeredMove = `${workspace.path}-registered`;
    await git(sourceRoot, ["worktree", "move", workspace.path, registeredMove]);
    await rename(registeredMove, workspace.path);
    const registrationChangeRejected = await captureRejected(sourceManager, workspace);
    await rename(workspace.path, registeredMove);
    await git(sourceRoot, ["worktree", "move", registeredMove, workspace.path]);

    const restoredOwnership = await captureM3WorkspaceCheckpoint(sourceManager, workspace);
    const expectedNames = [
      "binary.dat",
      "committed.txt",
      "linked.txt",
      "package.json",
      "server.mjs",
      "untracked.txt",
    ];
    const sourceStatus = await git(sourceRoot, ["status", "--porcelain"]);
    const evidence: M3WorkspaceCheckpointEvidence = {
      version: "anastom.dev/m3-workspace-checkpoint-evidence/v1alpha1",
      platform: process.platform,
      architecture: process.arch,
      capture: {
        repeatable: checkpointMatches(expected.checkpoint, repeated),
        stagingPreserved: stagedBefore === stagedAfter && stagedBefore.includes("package.json"),
        stagingStateNonAuthoritative: checkpointMatches(expected.checkpoint, unstagedEquivalent),
        committedCaptured: expected.diff.includes("committed checkpoint content"),
        trackedCaptured: expected.diff.includes("tracked checkpoint change"),
        untrackedCaptured: expected.diff.includes("untracked checkpoint content"),
        stagedCaptured: expected.checkpoint.changedFiles.includes("package.json"),
        binaryCaptured: expected.diff.includes("GIT binary patch"),
        symlinkCapturedWithoutFollowing:
          expected.diff.includes("new file mode 120000") &&
          expected.diff.includes("../outside-checkpoint-target"),
        ignoredContentFingerprinted:
          expected.checkpoint.ignoredEntryCount === 3 &&
          expected.checkpoint.ignoredByteCount > 0 &&
          !expected.checkpoint.changedFiles.includes("node_modules/checkpoint.txt"),
        invalidUtf8PathRejected,
      },
      contentConflicts: {
        trackedDetected: checkpointDetects(expected.checkpoint, trackedConflict, "diff-digest"),
        untrackedDetected: checkpointDetects(expected.checkpoint, untrackedConflict, "diff-digest"),
        binaryDetected: checkpointDetects(expected.checkpoint, binaryConflict, "diff-digest"),
        symlinkTargetDetected: checkpointDetects(
          expected.checkpoint,
          symlinkConflict,
          "diff-digest",
        ),
        ignoredDetected: checkpointDetects(expected.checkpoint, ignoredConflict, "ignored-content"),
        ignoredDirectoryDetected: checkpointDetects(
          expected.checkpoint,
          ignoredDirectoryConflict,
          "ignored-content",
        ),
        headCommitDetected: checkpointDetects(expected.checkpoint, headConflict, "head-commit"),
      },
      ownershipConflicts: {
        branchRejected,
        manifestMismatchRejected,
        manifestSymlinkRejected,
        workspaceSymlinkRejected,
        registrationChangeRejected,
        repositoryIdentityDetectedWithSameGitContent:
          contentEquivalent(
            sourceIdentityCheckpoint.checkpoint,
            cloneIdentityCheckpoint.checkpoint,
          ) &&
          !identityComparison.matches &&
          identityComparison.differences.includes("repository"),
      },
      restoration: {
        exactAfterContentRestoration: checkpointMatches(expected.checkpoint, restoredContent),
        exactAfterOwnershipRestoration: checkpointMatches(expected.checkpoint, restoredOwnership),
        sourceCheckoutUnchanged: sourceStatus === "",
      },
      conclusion: {
        temporaryIndexCheckpoint: "feasible",
        ignoredFingerprint: "required",
        stagingState: "non-authoritative",
        ownershipIdentity: "required",
        publicWorkspaceApiFrozen: false,
      },
    };
    if (
      !allEvidencePassed(evidence) ||
      JSON.stringify(expected.checkpoint.changedFiles) !== JSON.stringify(expectedNames)
    ) {
      throw new Error("M3 workspace checkpoint evidence did not satisfy its contract");
    }
    return evidence;
  } finally {
    await Promise.all([
      removeEndpointRepository(sourceRoot),
      rm(cloneRoot, { recursive: true, force: true }),
    ]);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await runM3WorkspaceCheckpointProbe(), null, 2)}\n`);
}
