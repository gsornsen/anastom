import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import { canonicalJson, digestBytes } from "@anastom/core";
import { ensurePrivatePathRoot } from "@anastom/path-policy";
import type { WorkspaceRef } from "@anastom/runtime-contract";

import type { GitWorkspaceManager } from "./index.js";

const execute = promisify(execFile);
const PATCH_MAX_BYTES = 16 * 1024 * 1024;
const INTEGRATION_MAX_BYTES = 64 * 1024 * 1024;
const TOPOLOGY_MAX_BYTES = 64 * 1024;
const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: "Anastom",
  GIT_AUTHOR_EMAIL: "integration@anastom.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Anastom",
  GIT_COMMITTER_EMAIL: "integration@anastom.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
} as const;

type IsolatedWorkspace = Extract<WorkspaceRef, { mode: "isolated" }>;

/** Run-owned integration workspace and immutable source base for one Feature execution. */
export interface FeatureWorkspaceTopology {
  version: "anastom.dev/feature-workspace-topology/v1alpha1";
  runId: string;
  repositoryRoot: string;
  sourceBaseCommit: string;
  protectedPaths: readonly string[];
  integration: IsolatedWorkspace;
}

/** Exact accepted patch bytes and scope evidence retained before integration. */
export interface AcceptedWorkspacePatch {
  version: "anastom.dev/accepted-workspace-patch/v1alpha1";
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: readonly string[];
  mutationScopes: readonly string[];
  patch: Uint8Array;
  patchDigest: string;
}

/** Prepared deterministic Git result persisted before an owned branch can move. */
export interface IntegrationPreparation {
  version: "anastom.dev/integration-preparation/v1alpha1";
  workspaceId: string;
  branch: string;
  parentCommit: string;
  patches: readonly { taskId: string; digest: string }[];
  tree: string;
  expectedCommit: string;
  preparationDigest: string;
}

/** Result of reconciling the only two accepted branch states with the owned worktree. */
export interface IntegrationReconciliation {
  outcome: "committed";
  movedReference: boolean;
  synchronizedWorktree: boolean;
  commit: string;
}

/**
 * Classified refusal for mutation scope, integration conflict, or recovery ambiguity.
 * @public
 */
export class WorkspaceIntegrationError extends Error {
  /** Preserve a stable reason without exposing Git command output as workflow policy. */
  constructor(
    readonly reason: "conflict" | "invalid" | "protected-path" | "scope" | "unexpected-state",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceIntegrationError";
  }
}

async function git(
  cwd: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return (
    await execute("git", args, {
      cwd,
      env: { ...process.env, LANG: "C", LC_ALL: "C", ...options.env },
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
    })
  ).stdout.trim();
}

function workspaceId(runId: string, purpose: "integration" | "task", taskId?: string): string {
  const id =
    purpose === "integration" ? `${runId}--integration` : `${runId}--task--${taskId ?? ""}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new WorkspaceIntegrationError("invalid", "Feature workspace identity is invalid");
  }
  return id;
}

function normalizeRepositoryPath(path: string, label: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new WorkspaceIntegrationError("invalid", `${label} must be repository-relative`);
  }
  const normalized = posix.normalize(path).replace(/^\.\//, "").replace(/\/$/, "");
  if (normalized === "." || normalized === "" || normalized.split("/").includes("..")) {
    throw new WorkspaceIntegrationError("invalid", `${label} must stay inside the repository`);
  }
  return normalized;
}

function pathContains(scope: string, path: string): boolean {
  return scope === path || path.startsWith(scope + "/");
}

function scopesOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => key === actual[index]);
}

function assertMutationScope(
  changedFiles: readonly string[],
  mutationScopes: readonly string[],
  protectedPaths: readonly string[],
): string[] {
  const scopes = mutationScopes.map((path) => normalizeRepositoryPath(path, "Mutation scope"));
  const protectedEntries = protectedPaths.map((path) =>
    normalizeRepositoryPath(path, "Protected path"),
  );
  for (const changed of changedFiles) {
    const path = normalizeRepositoryPath(changed, "Changed path");
    if (protectedEntries.some((entry) => pathContains(entry, path))) {
      throw new WorkspaceIntegrationError(
        "protected-path",
        `Changed path ${JSON.stringify(path)} is protected`,
      );
    }
    if (!scopes.some((scope) => pathContains(scope, path))) {
      throw new WorkspaceIntegrationError(
        "scope",
        `Changed path ${JSON.stringify(path)} is outside the task mutation scopes`,
      );
    }
  }
  return scopes;
}

function assertAcceptedPatch(accepted: AcceptedWorkspacePatch): void {
  if (
    accepted.version !== "anastom.dev/accepted-workspace-patch/v1alpha1" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(accepted.workspaceId) ||
    !/^[0-9a-f]{40,64}$/.test(accepted.baseCommit) ||
    !/^[0-9a-f]{40,64}$/.test(accepted.headCommit) ||
    !(accepted.patch instanceof Uint8Array) ||
    accepted.patch.byteLength === 0 ||
    accepted.patch.byteLength > PATCH_MAX_BYTES ||
    digestBytes(accepted.patch) !== accepted.patchDigest
  ) {
    throw new WorkspaceIntegrationError("invalid", "Accepted patch contract is invalid");
  }
  const scopes = assertMutationScope(accepted.changedFiles, accepted.mutationScopes, []);
  if (!isDeepStrictEqual(scopes, accepted.mutationScopes)) {
    throw new WorkspaceIntegrationError("invalid", "Accepted patch scopes are not canonical");
  }
}

async function writeTopology(
  manager: GitWorkspaceManager,
  topology: FeatureWorkspaceTopology,
): Promise<void> {
  const state = await ensurePrivatePathRoot(manager.stateDir);
  await state.ensureDirectory(["runs", topology.runId]);
  await state.writeFileExclusive(
    ["runs", topology.runId, "feature-workspaces.json"],
    Buffer.from(canonicalJson(topology)),
    { maxBytes: TOPOLOGY_MAX_BYTES },
  );
}

async function assertTopology(
  manager: GitWorkspaceManager,
  topology: FeatureWorkspaceTopology,
): Promise<void> {
  const state = await ensurePrivatePathRoot(manager.stateDir);
  let stored: unknown;
  try {
    stored = JSON.parse(
      (
        await state.readFile(["runs", topology.runId, "feature-workspaces.json"], {
          maxBytes: TOPOLOGY_MAX_BYTES,
        })
      ).toString("utf8"),
    );
  } catch {
    throw new WorkspaceIntegrationError(
      "unexpected-state",
      "Feature topology is missing or corrupt",
    );
  }
  if (!isDeepStrictEqual(stored, topology)) {
    throw new WorkspaceIntegrationError("unexpected-state", "Feature topology identity changed");
  }
  await manager.assertOwnedWorkspace(topology.integration);
}

function isFeatureWorkspaceTopology(
  value: unknown,
  runId: string,
): value is FeatureWorkspaceTopology {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const integration = candidate.integration;
  return (
    hasExactKeys(value, [
      "integration",
      "protectedPaths",
      "repositoryRoot",
      "runId",
      "sourceBaseCommit",
      "version",
    ]) &&
    candidate.version === "anastom.dev/feature-workspace-topology/v1alpha1" &&
    candidate.runId === runId &&
    typeof candidate.repositoryRoot === "string" &&
    typeof candidate.sourceBaseCommit === "string" &&
    /^[0-9a-f]{40,64}$/.test(candidate.sourceBaseCommit) &&
    Array.isArray(candidate.protectedPaths) &&
    candidate.protectedPaths.every((path) => typeof path === "string") &&
    integration !== null &&
    typeof integration === "object" &&
    !Array.isArray(integration) &&
    hasExactKeys(integration, ["baseCommit", "branch", "id", "mode", "path", "repoRoot"]) &&
    (integration as Record<string, unknown>).mode === "isolated"
  );
}

/** Load and revalidate one persisted run topology for process-independent recovery. */
export async function loadFeatureWorkspaceTopology(
  manager: GitWorkspaceManager,
  runId: string,
): Promise<FeatureWorkspaceTopology> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new WorkspaceIntegrationError("invalid", "Feature run identity is invalid");
  }
  const state = await ensurePrivatePathRoot(manager.stateDir);
  let value: unknown;
  try {
    value = JSON.parse(
      (
        await state.readFile(["runs", runId, "feature-workspaces.json"], {
          maxBytes: TOPOLOGY_MAX_BYTES,
        })
      ).toString("utf8"),
    );
  } catch {
    throw new WorkspaceIntegrationError(
      "unexpected-state",
      "Feature topology is missing or corrupt",
    );
  }
  if (!isFeatureWorkspaceTopology(value, runId)) {
    throw new WorkspaceIntegrationError("unexpected-state", "Feature topology fields are invalid");
  }
  await assertTopology(manager, value);
  return structuredClone(value);
}

/** Create the run's integration branch at the clean source checkout's exact commit. */
export async function createFeatureWorkspaceTopology(
  manager: GitWorkspaceManager,
  repository: string,
  runId: string,
  protectedPaths: readonly string[] = [],
): Promise<FeatureWorkspaceTopology> {
  const source = await manager.create(repository, workspaceId(runId, "integration"));
  if (source.mode !== "isolated") {
    throw new WorkspaceIntegrationError(
      "unexpected-state",
      "Integration workspace is not isolated",
    );
  }
  const topology: FeatureWorkspaceTopology = {
    version: "anastom.dev/feature-workspace-topology/v1alpha1",
    runId,
    repositoryRoot: source.repoRoot,
    sourceBaseCommit: source.baseCommit,
    protectedPaths: [
      ...new Set(protectedPaths.map((path) => normalizeRepositoryPath(path, "Protected path"))),
    ].sort(),
    integration: source,
  };
  await writeTopology(manager, topology);
  return topology;
}

/** Create one task worktree at the exact current integration commit for its dependency wave. */
export async function createFeatureTaskWorkspace(
  manager: GitWorkspaceManager,
  topology: FeatureWorkspaceTopology,
  taskId: string,
  baseCommit: string,
): Promise<IsolatedWorkspace> {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(taskId)) {
    throw new WorkspaceIntegrationError("invalid", "Task identity is invalid");
  }
  await assertTopology(manager, topology);
  const integrationHead = await git(topology.integration.path, ["rev-parse", "HEAD"]);
  if (integrationHead !== baseCommit) {
    throw new WorkspaceIntegrationError(
      "unexpected-state",
      "Task base does not match the integration head",
    );
  }
  return manager.createIsolatedAtCommit(
    topology.repositoryRoot,
    workspaceId(topology.runId, "task", taskId),
    baseCommit,
  );
}

/** Capture exact patch bytes and reject changes outside the task's declared authority. */
export async function captureScopedWorkspacePatch(
  manager: GitWorkspaceManager,
  workspace: IsolatedWorkspace,
  options: { mutationScopes: readonly string[]; protectedPaths: readonly string[] },
): Promise<AcceptedWorkspacePatch> {
  const capture = await manager.capture(workspace);
  const scopes = assertMutationScope(
    capture.changedFiles,
    options.mutationScopes,
    options.protectedPaths,
  );
  const patch = Buffer.from(capture.diff, "utf8");
  if (patch.byteLength === 0) {
    throw new WorkspaceIntegrationError("invalid", "Accepted task patch must not be empty");
  }
  if (patch.byteLength > PATCH_MAX_BYTES) {
    throw new WorkspaceIntegrationError("invalid", "Accepted task patch exceeds 16 MiB");
  }
  return {
    version: "anastom.dev/accepted-workspace-patch/v1alpha1",
    workspaceId: workspace.id,
    baseCommit: workspace.baseCommit,
    headCommit: capture.headCommit,
    changedFiles: [...capture.changedFiles],
    mutationScopes: scopes,
    patch,
    patchDigest: digestBytes(patch),
  };
}

function preparationContent(preparation: IntegrationPreparation) {
  return {
    version: preparation.version,
    workspaceId: preparation.workspaceId,
    branch: preparation.branch,
    parentCommit: preparation.parentCommit,
    patches: preparation.patches,
    tree: preparation.tree,
    expectedCommit: preparation.expectedCommit,
  };
}

function isPreparedPatch(value: unknown): value is { taskId: string; digest: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const patch = value as Record<string, unknown>;
  return (
    hasExactKeys(value, ["digest", "taskId"]) &&
    typeof patch.taskId === "string" &&
    /^[a-z][a-z0-9-]{0,47}$/.test(patch.taskId) &&
    typeof patch.digest === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(patch.digest)
  );
}

function hasValidPreparationIdentity(candidate: Record<string, unknown>): boolean {
  return (
    candidate.version === "anastom.dev/integration-preparation/v1alpha1" &&
    typeof candidate.workspaceId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(candidate.workspaceId) &&
    candidate.branch === `anastom/${candidate.workspaceId}`
  );
}

function hasValidGitObjects(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate.parentCommit === "string" &&
    /^[0-9a-f]{40,64}$/.test(candidate.parentCommit) &&
    typeof candidate.tree === "string" &&
    /^[0-9a-f]{40,64}$/.test(candidate.tree) &&
    typeof candidate.expectedCommit === "string" &&
    /^[0-9a-f]{40,64}$/.test(candidate.expectedCommit)
  );
}

/** Verify a persisted integration preparation before any ref or worktree mutation. */
export function assertIntegrationPreparation(
  value: unknown,
): asserts value is IntegrationPreparation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceIntegrationError("invalid", "Integration preparation must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const patches = candidate.patches;
  if (
    !hasExactKeys(value, [
      "branch",
      "expectedCommit",
      "parentCommit",
      "patches",
      "preparationDigest",
      "tree",
      "version",
      "workspaceId",
    ]) ||
    !hasValidPreparationIdentity(candidate) ||
    !hasValidGitObjects(candidate) ||
    !Array.isArray(patches) ||
    patches.length === 0 ||
    !patches.every(isPreparedPatch) ||
    typeof candidate.preparationDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(candidate.preparationDigest)
  ) {
    throw new WorkspaceIntegrationError("invalid", "Integration preparation fields are invalid");
  }
  const preparation = candidate as unknown as IntegrationPreparation;
  const digest = digestBytes(canonicalJson(preparationContent(preparation)));
  if (digest !== candidate.preparationDigest) {
    throw new WorkspaceIntegrationError("invalid", "Integration preparation digest changed");
  }
}

/** Compute one deterministic integration commit without moving the owned branch. */
export async function prepareWorkspaceIntegration(
  manager: GitWorkspaceManager,
  integration: IsolatedWorkspace,
  patches: readonly { taskId: string; accepted: AcceptedWorkspacePatch }[],
): Promise<IntegrationPreparation> {
  await manager.assertOwnedWorkspace(integration);
  const parentCommit = await git(integration.path, ["rev-parse", "HEAD"]);
  if ((await git(integration.path, ["status", "--porcelain", "--untracked-files=all"])) !== "") {
    throw new WorkspaceIntegrationError("unexpected-state", "Integration workspace is not clean");
  }
  if (
    patches.length === 0 ||
    new Set(patches.map(({ taskId }) => taskId)).size !== patches.length
  ) {
    throw new WorkspaceIntegrationError(
      "invalid",
      "Integration requires unique ordered task patches",
    );
  }
  let totalBytes = 0;
  for (const { taskId, accepted } of patches) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(taskId)) {
      throw new WorkspaceIntegrationError("invalid", "Integration task identity is invalid");
    }
    assertAcceptedPatch(accepted);
    if (accepted.baseCommit !== parentCommit) {
      throw new WorkspaceIntegrationError("invalid", "Accepted patch identity or base changed");
    }
    totalBytes += accepted.patch.byteLength;
  }
  for (let leftIndex = 0; leftIndex < patches.length; leftIndex += 1) {
    const left = patches[leftIndex]!.accepted.mutationScopes;
    for (let rightIndex = leftIndex + 1; rightIndex < patches.length; rightIndex += 1) {
      const right = patches[rightIndex]!.accepted.mutationScopes;
      if (left.some((scope) => right.some((candidate) => scopesOverlap(scope, candidate)))) {
        throw new WorkspaceIntegrationError("conflict", "Same-wave task mutation scopes overlap");
      }
    }
  }
  if (totalBytes > INTEGRATION_MAX_BYTES) {
    throw new WorkspaceIntegrationError("invalid", "Integration patches exceed 64 MiB");
  }
  const temporary = await mkdtemp(join(tmpdir(), "anastom-integration-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
  try {
    await git(integration.repoRoot, ["read-tree", parentCommit], { env });
    for (const [index, { accepted }] of patches.entries()) {
      const patchPath = join(temporary, `patch-${index}.diff`);
      await writeFile(patchPath, accepted.patch, { mode: 0o600 });
      try {
        await git(
          integration.repoRoot,
          ["apply", "--cached", "--binary", "--whitespace=nowarn", patchPath],
          { env },
        );
      } catch {
        throw new WorkspaceIntegrationError("conflict", "Accepted task patches do not integrate");
      }
    }
    const tree = await git(integration.repoRoot, ["write-tree"], { env });
    const expectedCommit = await git(
      integration.repoRoot,
      ["commit-tree", tree, "-p", parentCommit, "-m", "Integrate accepted Anastom task patches"],
      { env: { ...env, ...FIXED_GIT_ENV } },
    );
    const content = {
      version: "anastom.dev/integration-preparation/v1alpha1" as const,
      workspaceId: integration.id,
      branch: integration.branch,
      parentCommit,
      patches: patches.map(({ taskId, accepted }) => ({
        taskId,
        digest: accepted.patchDigest,
      })),
      tree,
      expectedCommit,
    };
    return { ...content, preparationDigest: digestBytes(canonicalJson(content)) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function worktreeTree(workspace: IsolatedWorkspace, baseCommit: string): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "anastom-worktree-tree-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
  try {
    await git(workspace.path, ["read-tree", baseCommit], { env });
    await git(workspace.path, ["add", "-A", "--", "."], { env });
    return await git(workspace.path, ["write-tree"], { env });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Reconcile only the recorded parent/result states, refusing unrelated refs or workspace content. */
export async function reconcileWorkspaceIntegration(
  manager: GitWorkspaceManager,
  integration: IsolatedWorkspace,
  preparation: IntegrationPreparation,
): Promise<IntegrationReconciliation> {
  assertIntegrationPreparation(preparation);
  await manager.assertOwnedWorkspace(integration);
  if (preparation.workspaceId !== integration.id || preparation.branch !== integration.branch) {
    throw new WorkspaceIntegrationError(
      "unexpected-state",
      "Integration workspace identity changed",
    );
  }
  const expectedTree = await git(integration.repoRoot, [
    "rev-parse",
    `${preparation.expectedCommit}^{tree}`,
  ]);
  const parentTree = await git(integration.repoRoot, [
    "rev-parse",
    `${preparation.parentCommit}^{tree}`,
  ]);
  if (expectedTree !== preparation.tree) {
    throw new WorkspaceIntegrationError("unexpected-state", "Prepared commit tree changed");
  }
  const ignored = await git(integration.path, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
  ]);
  if (ignored !== "") {
    throw new WorkspaceIntegrationError(
      "unexpected-state",
      "Integration workspace has ignored content",
    );
  }
  const reference = `refs/heads/${integration.branch}`;
  const observedReference = await git(integration.repoRoot, ["rev-parse", reference]);
  if (
    observedReference !== preparation.parentCommit &&
    observedReference !== preparation.expectedCommit
  ) {
    throw new WorkspaceIntegrationError(
      "unexpected-state",
      "Integration branch moved unexpectedly",
    );
  }
  const indexTree = await git(integration.path, ["write-tree"]);
  const contentTree = await worktreeTree(integration, preparation.parentCommit);
  const allowedTrees =
    observedReference === preparation.parentCommit
      ? new Set([parentTree])
      : new Set([parentTree, preparation.tree]);
  if (!allowedTrees.has(indexTree) || indexTree !== contentTree) {
    throw new WorkspaceIntegrationError("unexpected-state", "Integration worktree content changed");
  }
  let movedReference = false;
  if (observedReference === preparation.parentCommit) {
    try {
      await git(integration.repoRoot, [
        "update-ref",
        reference,
        preparation.expectedCommit,
        preparation.parentCommit,
      ]);
      movedReference = true;
    } catch {
      throw new WorkspaceIntegrationError(
        "unexpected-state",
        "Integration branch compare-and-swap failed",
      );
    }
  }
  const synchronizedWorktree = contentTree !== preparation.tree;
  if (synchronizedWorktree) {
    await git(integration.path, ["reset", "--hard", preparation.expectedCommit]);
  }
  if (
    (await git(integration.path, ["rev-parse", "HEAD"])) !== preparation.expectedCommit ||
    (await git(integration.path, ["status", "--porcelain", "--untracked-files=all"])) !== ""
  ) {
    throw new WorkspaceIntegrationError(
      "unexpected-state",
      "Integration worktree did not synchronize",
    );
  }
  return {
    outcome: "committed",
    movedReference,
    synchronizedWorktree,
    commit: preparation.expectedCommit,
  };
}
