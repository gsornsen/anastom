import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, digestBytes } from "../packages/core/src/index.js";

const execute = promisify(execFile);

interface PreparedIntegration {
  version: "anastom.dev/integration-preparation/v1alpha1";
  branch: string;
  parentCommit: string;
  patchDigests: readonly string[];
  tree: string;
  expectedCommit: string;
}

async function git(cwd: string, args: readonly string[], env = process.env): Promise<string> {
  return (await execute("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

async function gitRaw(cwd: string, args: readonly string[], env = process.env): Promise<string> {
  return (await execute("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

async function initializeRepository(
  root: string,
): Promise<{ repository: string; baseCommit: string }> {
  const repository = join(root, "repository");
  await mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Anastom Feasibility"]);
  await git(repository, ["config", "user.email", "feasibility@anastom.invalid"]);
  await mkdir(join(repository, "src"));
  await mkdir(join(repository, "test"));
  await writeFile(join(repository, "src", "server.ts"), "export const status = 'base';\n");
  await writeFile(join(repository, "test", "server.test.ts"), "export const expected = 'base';\n");
  await git(repository, ["add", "--", "."]);
  await git(repository, ["commit", "-m", "fixture base"]);
  return { repository, baseCommit: await git(repository, ["rev-parse", "HEAD"]) };
}

async function taskPatch(options: {
  repository: string;
  root: string;
  baseCommit: string;
  taskId: string;
  relativePath: string;
  contents: string;
}): Promise<{ path: string; digest: string }> {
  const { repository, root, baseCommit, taskId, relativePath, contents } = options;
  const workspace = join(root, `task-${taskId}`);
  const branch = `anastom/feasibility/${taskId}`;
  await git(repository, ["worktree", "add", "-b", branch, workspace, baseCommit]);
  await writeFile(join(workspace, ...relativePath.split("/")), contents);
  const patch = await gitRaw(workspace, ["diff", "--binary", baseCommit, "--"]);
  const path = join(root, `${taskId}.patch`);
  await writeFile(path, patch);
  return { path, digest: digestBytes(patch) };
}

async function prepareIntegration(options: {
  repository: string;
  root: string;
  branch: string;
  parentCommit: string;
  patches: readonly { path: string; digest: string }[];
}): Promise<PreparedIntegration> {
  const { repository, root, branch, parentCommit, patches } = options;
  const indexRoot = await mkdtemp(join(root, "index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(indexRoot, "index") };
  try {
    await git(repository, ["read-tree", parentCommit], env);
    for (const patch of patches) {
      await git(
        repository,
        ["apply", "--cached", "--binary", "--whitespace=nowarn", patch.path],
        env,
      );
    }
    const tree = await git(repository, ["write-tree"], env);
    const commitEnv = {
      ...env,
      GIT_AUTHOR_NAME: "Anastom",
      GIT_AUTHOR_EMAIL: "integration@anastom.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Anastom",
      GIT_COMMITTER_EMAIL: "integration@anastom.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const expectedCommit = await git(
      repository,
      ["commit-tree", tree, "-p", parentCommit, "-m", "Integrate accepted Anastom task diffs"],
      commitEnv,
    );
    return {
      version: "anastom.dev/integration-preparation/v1alpha1",
      branch,
      parentCommit,
      patchDigests: patches.map(({ digest }) => digest),
      tree,
      expectedCommit,
    };
  } finally {
    await rm(indexRoot, { recursive: true, force: true });
  }
}

async function reconcileIntegration(
  repository: string,
  workspace: string,
  preparation: PreparedIntegration,
): Promise<"committed" | "refused"> {
  const reference = `refs/heads/${preparation.branch}`;
  const observed = await git(repository, ["rev-parse", reference]);
  if (observed === preparation.parentCommit) {
    await git(repository, [
      "update-ref",
      reference,
      preparation.expectedCommit,
      preparation.parentCommit,
    ]);
  } else if (observed !== preparation.expectedCommit) {
    return "refused";
  }
  await git(workspace, ["reset", "--hard", preparation.expectedCommit]);
  if (
    (await git(workspace, ["rev-parse", "HEAD"])) !== preparation.expectedCommit ||
    (await git(workspace, ["status", "--porcelain"])) !== ""
  ) {
    throw new Error("Integration worktree did not synchronize to the prepared commit");
  }
  return "committed";
}

async function restoreIntegration(
  repository: string,
  workspace: string,
  preparation: PreparedIntegration,
): Promise<void> {
  const reference = `refs/heads/${preparation.branch}`;
  const current = await git(repository, ["rev-parse", reference]);
  await git(repository, ["update-ref", reference, preparation.parentCommit, current]);
  await git(workspace, ["reset", "--hard", preparation.parentCommit]);
}

/** Run a real-Git matrix across every prepared-integration crash boundary. */
export async function runM4GitIntegrationFeasibility(): Promise<{
  deterministicCommit: boolean;
  recoveredBeforeRefUpdate: boolean;
  recoveredAfterRefUpdate: boolean;
  recoveredAfterWorktreeSync: boolean;
  unexpectedRefRefused: boolean;
  integratedContentExact: boolean;
  sourceCheckoutClean: boolean;
  preparationDigest: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "anastom-m4-integration-"));
  try {
    const { repository, baseCommit } = await initializeRepository(root);
    const branch = "anastom/feasibility/integration";
    const workspace = join(root, "integration");
    await git(repository, ["worktree", "add", "-b", branch, workspace, baseCommit]);
    const patches = await Promise.all([
      taskPatch({
        repository,
        root,
        baseCommit,
        taskId: "server",
        relativePath: "src/server.ts",
        contents: "export const status = 'ready';\n",
      }),
      taskPatch({
        repository,
        root,
        baseCommit,
        taskId: "tests",
        relativePath: "test/server.test.ts",
        contents: "export const expected = 'ready';\n",
      }),
    ]);
    const preparation = await prepareIntegration({
      repository,
      root,
      branch,
      parentCommit: baseCommit,
      patches,
    });
    const repeated = await prepareIntegration({
      repository,
      root,
      branch,
      parentCommit: baseCommit,
      patches,
    });
    await writeFile(join(root, "integration-prepared.json"), canonicalJson(preparation));

    const recoveredBeforeRefUpdate =
      (await reconcileIntegration(repository, workspace, preparation)) === "committed";
    await restoreIntegration(repository, workspace, preparation);

    await git(repository, [
      "update-ref",
      `refs/heads/${branch}`,
      preparation.expectedCommit,
      baseCommit,
    ]);
    const recoveredAfterRefUpdate =
      (await reconcileIntegration(repository, workspace, preparation)) === "committed";
    await restoreIntegration(repository, workspace, preparation);

    await reconcileIntegration(repository, workspace, preparation);
    const recoveredAfterWorktreeSync =
      (await reconcileIntegration(repository, workspace, preparation)) === "committed";

    const unexpected = await git(repository, [
      "commit-tree",
      preparation.tree,
      "-p",
      preparation.expectedCommit,
      "-m",
      "unexpected integration mutation",
    ]);
    await git(repository, [
      "update-ref",
      `refs/heads/${branch}`,
      unexpected,
      preparation.expectedCommit,
    ]);
    const unexpectedRefRefused =
      (await reconcileIntegration(repository, workspace, preparation)) === "refused";

    const integratedContentExact =
      (await readFile(join(workspace, "src", "server.ts"), "utf8")) ===
        "export const status = 'ready';\n" &&
      (await readFile(join(workspace, "test", "server.test.ts"), "utf8")) ===
        "export const expected = 'ready';\n";
    return {
      deterministicCommit: preparation.expectedCommit === repeated.expectedCommit,
      recoveredBeforeRefUpdate,
      recoveredAfterRefUpdate,
      recoveredAfterWorktreeSync,
      unexpectedRefRefused,
      integratedContentExact,
      sourceCheckoutClean: (await git(repository, ["status", "--porcelain"])) === "",
      preparationDigest: digestBytes(canonicalJson(preparation)),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(await runM4GitIntegrationFeasibility(), null, 2));
}
