import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkspaceRef, WorkspaceCapture } from "@anastom/runtime-contract";

const exec = promisify(execFile);
async function git(cwd: string, args: string[], env = process.env): Promise<string> {
  return (await exec("git", args, { cwd, env, maxBuffer: 16_777_216 })).stdout;
}
/**
 * Reject identifiers that could escape run-owned filesystem paths.
 */
export function assertRunId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new Error("Invalid run ID");
  }
}
/**
 * Resolve a Git repository to its canonical root and current base commit.
 */
export async function resolveGitRepository(
  repo: string,
): Promise<{ repoRoot: string; baseCommit: string }> {
  const repoRoot = await realpath(
    (await git(resolve(repo), ["rev-parse", "--show-toplevel"])).trim(),
  );
  const baseCommit = (await git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  return { repoRoot, baseCommit };
}
/**
 * Create, observe, and safely clean owned Git workspaces while preserving source and worker edits.
 */
export class GitWorkspaceManager {
  /**
   * Select the state directory containing ownership manifests and isolated worktrees.
   */
  constructor(readonly stateDir: string) {}
  /**
   * Require a clean source repository and create either a readonly reference or an owned isolated worktree.
   */
  async create(
    repo: string,
    runId: string,
    mode: "readonly" | "isolated" = "isolated",
  ): Promise<WorkspaceRef> {
    assertRunId(runId);
    const { repoRoot, baseCommit } = await resolveGitRepository(repo);
    const id = runId;
    if (mode === "readonly") {
      if ((await git(repoRoot, ["status", "--porcelain"])).trim()) {
        throw new Error("Readonly workspace requires a clean source checkout");
      }
      return { id, mode, repoRoot, path: repoRoot, baseCommit };
    }
    const branch = "anastom/" + id;
    await mkdir(resolve(this.stateDir, "worktrees"), { recursive: true });
    if ((await lstat(resolve(this.stateDir, "worktrees"))).isSymbolicLink()) {
      throw new Error("Workspace parent must not be a symlink");
    }
    const parent = await realpath(resolve(this.stateDir, "worktrees"));
    const path = join(parent, id);
    await git(repoRoot, ["worktree", "add", "-b", branch, path, baseCommit]);
    const workspace: WorkspaceRef = { id, mode, repoRoot, path, branch, baseCommit };
    await mkdir(resolve(this.stateDir, "runs", id), { recursive: true });
    await writeFile(this.manifest(id), JSON.stringify(workspace), { flag: "wx", mode: 0o600 });
    return workspace;
  }
  /**
   * Capture tracked, new, and committed changes against the base using a temporary index; preserve worker staging.
   */
  async capture(workspace: WorkspaceRef): Promise<WorkspaceCapture> {
    if (workspace.mode === "memory") {
      throw new Error("Cannot capture an in-memory workspace");
    }
    if (workspace.mode === "isolated") {
      await this.assertOwned(workspace);
    }
    const temp = await mkdtemp(join(tmpdir(), "anastom-index-"));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
      await git(workspace.path, ["read-tree", workspace.baseCommit], env);
      await git(workspace.path, ["add", "-A", "--", "."], env);
      const diff = await git(
        workspace.path,
        ["diff", "--cached", "--binary", workspace.baseCommit, "--"],
        env,
      );
      const names = await git(
        workspace.path,
        ["diff", "--cached", "--name-only", "-z", workspace.baseCommit, "--"],
        env,
      );
      return {
        headCommit: (await git(workspace.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim(),
        diff,
        changedFiles: names.split("\0").filter(Boolean),
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  /**
   * Remove an owned clean worktree idempotently.
   * @throws If ownership differs, edits remain, or worker commits would be discarded; retained work requires operator review.
   */
  async cleanup(workspace: WorkspaceRef): Promise<void> {
    if (workspace.mode !== "isolated") {
      throw new Error("Cleanup requires an owned isolated workspace");
    }
    await this.assertManifest(workspace);
    try {
      await lstat(workspace.path);
      await this.assertOwned(workspace);
      if ((await git(workspace.path, ["rev-parse", "HEAD"])).trim() !== workspace.baseCommit) {
        throw new Error("Workspace contains worker commits; retain it for review");
      }
      // No force: dirty work or commits are retained rather than discarded.
      await git(workspace.repoRoot, ["worktree", "remove", workspace.path]);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    const branches = (await git(workspace.repoRoot, ["branch", "--list", workspace.branch])).trim();
    if (branches) {
      await git(workspace.repoRoot, ["branch", "-d", workspace.branch]);
    }
  }
  private manifest(id: string): string {
    assertRunId(id);
    return resolve(this.stateDir, "runs", id, "workspace.json");
  }
  private async assertManifest(
    workspace: Extract<WorkspaceRef, { mode: "isolated" }>,
  ): Promise<void> {
    const parent = await realpath(resolve(this.stateDir, "worktrees"));
    if (
      (await lstat(resolve(this.stateDir, "worktrees"))).isSymbolicLink() ||
      workspace.path !== join(parent, workspace.id) ||
      workspace.branch !== "anastom/" + workspace.id
    ) {
      throw new Error("Workspace is not owned by Anastom");
    }
    let recorded: unknown;
    try {
      recorded = JSON.parse(await readFile(this.manifest(workspace.id), "utf8"));
    } catch {
      throw new Error("Missing or corrupt workspace ownership manifest");
    }
    if (!isDeepStrictEqual(recorded, workspace)) {
      throw new Error("Workspace ownership manifest does not match");
    }
  }
  private async assertOwned(workspace: Extract<WorkspaceRef, { mode: "isolated" }>): Promise<void> {
    await this.assertManifest(workspace);
    if ((await realpath(workspace.path)) !== workspace.path) {
      throw new Error("Workspace path is a symlink");
    }
    const root = (await git(workspace.path, ["rev-parse", "--show-toplevel"])).trim();
    const branch = (await git(workspace.path, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (root !== workspace.path || branch !== workspace.branch) {
      throw new Error("Workspace registration or branch changed");
    }
    const listed = await git(workspace.repoRoot, ["worktree", "list", "--porcelain"]);
    if (
      !listed
        .split("\n\n")
        .some(
          (block) =>
            block.startsWith("worktree " + workspace.path + "\n") &&
            block.includes("\nbranch refs/heads/" + workspace.branch),
        )
    ) {
      throw new Error("Workspace is not registered");
    }
  }
}
