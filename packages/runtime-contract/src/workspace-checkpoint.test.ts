import { describe, expect, it } from "vitest";

import { assertWorkspaceCheckpoint } from "./index.js";

const digest = `sha256:${"0".repeat(64)}`;
const checkpoint = {
  version: "anastom.dev/workspace-checkpoint/v1alpha1",
  workspaceId: "run-1",
  baseCommit: "base",
  headCommit: "head",
  diffDigest: digest,
  changedFiles: ["src/index.ts"],
  ignoredDigest: digest,
  ignoredEntryCount: 1,
  ignoredByteCount: 10,
  ownership: {
    repositoryRoot: "/repo",
    repositoryCommonDirectory: "/repo/.git",
    workspacePath: "/state/worktrees/run-1",
    workspaceGitDirectory: "/repo/.git/worktrees/run-1",
    branch: "anastom/run-1",
    manifestDigest: digest,
    registrationDigest: digest,
  },
};

describe("workspace checkpoint schema", () => {
  it("accepts exact bounded evidence", () => {
    expect(() => assertWorkspaceCheckpoint(checkpoint)).not.toThrow();
    expect(() =>
      assertWorkspaceCheckpoint({ ...checkpoint, diffArtifactId: `artifact-${"a".repeat(190)}` }),
    ).not.toThrow();
  });

  it("rejects unknown, malformed, and out-of-bound evidence", () => {
    expect(() => assertWorkspaceCheckpoint({ ...checkpoint, credential: "secret" })).toThrow();
    expect(() => assertWorkspaceCheckpoint({ ...checkpoint, ignoredEntryCount: 4_097 })).toThrow();
    expect(() =>
      assertWorkspaceCheckpoint({
        ...checkpoint,
        ownership: { ...checkpoint.ownership, repoRoot: "/alias" },
      }),
    ).toThrow();
    expect(() =>
      assertWorkspaceCheckpoint({ ...checkpoint, diffArtifactId: "a".repeat(256) }),
    ).toThrow();
  });
});
