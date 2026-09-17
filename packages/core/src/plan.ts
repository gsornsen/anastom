import { isAbsolute, posix } from "node:path";
import Ajv from "ajv";

import featurePlanJsonSchema from "../schemas/feature-plan.v1alpha1.json" with { type: "json" };
import reviewReportJsonSchema from "../schemas/review-report.v1alpha1.json" with { type: "json" };
import { canonicalJson, digestJson } from "./canonical.js";
import { formatSchemaErrors, SdlcValidationError, type FeaturePolicies } from "./feature.js";

const ajv = new Ajv({ allErrors: true });

/** Planner-produced task data before trusted graph normalization. */
interface PlannedTaskDocument {
  id: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  mutationScopes: string[];
}

/** Bounded planner output; it contains no executable commands or runtime selection. */
interface FeaturePlanDocument {
  summary: string;
  tasks: PlannedTaskDocument[];
  risks: string[];
}

/** A trusted task with canonical repository-relative scopes and stable dependencies. */
interface PlannedTask {
  id: string;
  title: string;
  objective: string;
  acceptanceCriteria: readonly string[];
  dependsOn: readonly string[];
  mutationScopes: readonly string[];
}

/** A replayable bounded plan whose waves and digest are independent of completion timing. */
export interface NormalizedFeaturePlan {
  summary: string;
  taskOrder: readonly string[];
  tasks: Readonly<Record<string, PlannedTask>>;
  waves: readonly (readonly string[])[];
  risks: readonly string[];
  planDigest: string;
}

/**
 * Structured independent-review output consumed by the control plane.
 * @public
 */
export interface ReviewReport {
  approved: boolean;
  summary: string;
  findings: readonly {
    severity: "blocking" | "advisory";
    summary: string;
    evidence: readonly string[];
  }[];
}

const validateFeaturePlan = ajv.compile<FeaturePlanDocument>(featurePlanJsonSchema);
const validateReview = ajv.compile<ReviewReport>(reviewReportJsonSchema);

function normalizeScope(scope: string, taskId: string): string {
  if (isAbsolute(scope) || scope.includes("\\") || scope.includes("\0")) {
    throw new SdlcValidationError("Feature plan", [
      `task ${JSON.stringify(taskId)} has a non-portable mutation scope ${JSON.stringify(scope)}`,
    ]);
  }
  const normalized = posix.normalize(scope).replace(/^\.\//, "").replace(/\/$/, "");
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized === "" ||
    segments.includes("..") ||
    segments[0] === ".git"
  ) {
    throw new SdlcValidationError("Feature plan", [
      `task ${JSON.stringify(taskId)} has an unsafe mutation scope ${JSON.stringify(scope)}`,
    ]);
  }
  return normalized;
}

function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}

function firstScopeOverlap(
  left: PlannedTask,
  right: PlannedTask,
): { left: string; right: string } | undefined {
  for (const leftScope of left.mutationScopes) {
    const rightScope = right.mutationScopes.find((candidate) =>
      scopesOverlap(leftScope, candidate),
    );
    if (rightScope !== undefined) {
      return { left: leftScope, right: rightScope };
    }
  }
  return undefined;
}

function deriveWaves(tasks: readonly PlannedTask[]): string[][] {
  const remaining = new Set(tasks.map(({ id }) => id));
  const completed = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = tasks
      .filter(
        ({ id, dependsOn }) => remaining.has(id) && dependsOn.every((id) => completed.has(id)),
      )
      .map(({ id }) => id);
    if (wave.length === 0) {
      throw new SdlcValidationError("Feature plan", ["task dependencies contain a cycle"]);
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return waves;
}

function assertDisjointWaves(
  waves: readonly (readonly string[])[],
  tasks: Map<string, PlannedTask>,
) {
  for (const wave of waves) {
    for (let leftIndex = 0; leftIndex < wave.length; leftIndex += 1) {
      const left = tasks.get(wave[leftIndex]!)!;
      for (let rightIndex = leftIndex + 1; rightIndex < wave.length; rightIndex += 1) {
        const right = tasks.get(wave[rightIndex]!)!;
        const overlap = firstScopeOverlap(left, right);
        if (overlap !== undefined) {
          throw new SdlcValidationError("Feature plan", [
            `ready tasks ${JSON.stringify(left.id)} and ${JSON.stringify(right.id)} have overlapping mutation scopes ${JSON.stringify(overlap.left)} and ${JSON.stringify(overlap.right)}`,
          ]);
        }
      }
    }
  }
}

/**
 * Validate planner output, derive dependency waves, and reject ambiguous write ownership.
 * @public
 */
export function normalizeFeaturePlan(
  value: unknown,
  policies: Pick<FeaturePolicies, "maxTasks" | "maxParallel">,
): NormalizedFeaturePlan {
  if (!validateFeaturePlan(value)) {
    throw new SdlcValidationError("Feature plan", formatSchemaErrors(validateFeaturePlan.errors));
  }
  if (value.tasks.length > policies.maxTasks) {
    throw new SdlcValidationError("Feature plan", [
      `plan contains ${value.tasks.length} tasks; the Feature permits ${policies.maxTasks}`,
    ]);
  }
  if (policies.maxParallel > policies.maxTasks) {
    throw new SdlcValidationError("Feature plan", ["maxParallel cannot exceed maxTasks"]);
  }
  const originalOrder = new Map(value.tasks.map(({ id }, index) => [id, index]));
  if (originalOrder.size !== value.tasks.length) {
    throw new SdlcValidationError("Feature plan", ["task IDs must be unique"]);
  }
  const issues: string[] = [];
  const tasks = new Map<string, PlannedTask>();
  for (const task of value.tasks) {
    for (const dependency of task.dependsOn) {
      if (!originalOrder.has(dependency)) {
        issues.push(
          `task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`,
        );
      }
      if (dependency === task.id) {
        issues.push(`task ${JSON.stringify(task.id)} cannot depend on itself`);
      }
    }
    const mutationScopes = task.mutationScopes.map((scope) => normalizeScope(scope, task.id));
    if (new Set(mutationScopes).size !== mutationScopes.length) {
      issues.push(`task ${JSON.stringify(task.id)} has duplicate normalized mutation scopes`);
    }
    tasks.set(task.id, {
      ...task,
      acceptanceCriteria: [...task.acceptanceCriteria],
      dependsOn: [...task.dependsOn].sort(
        (left, right) => (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0),
      ),
      mutationScopes,
    });
  }
  if (issues.length > 0) {
    throw new SdlcValidationError("Feature plan", issues);
  }
  const waves = deriveWaves([...tasks.values()]);
  assertDisjointWaves(waves, tasks);
  const taskOrder = waves.flat();
  const normalized = {
    summary: value.summary,
    taskOrder,
    tasks: Object.fromEntries(taskOrder.map((id) => [id, tasks.get(id)!])),
    waves,
    risks: [...value.risks],
  };
  return { ...normalized, planDigest: digestJson(normalized) };
}

/**
 * Validate a normalized planner result and reproduce its canonical waves and digest.
 * @throws SdlcValidationError when stored normalized data differs from planner normalization.
 * @public
 */
export function assertNormalizedFeaturePlan(
  value: unknown,
): asserts value is NormalizedFeaturePlan {
  if (
    value === null ||
    typeof value !== "object" ||
    !("taskOrder" in value) ||
    !Array.isArray(value.taskOrder) ||
    !("tasks" in value) ||
    value.tasks === null ||
    typeof value.tasks !== "object"
  ) {
    throw new SdlcValidationError("normalized Feature plan", ["normalized shape is invalid"]);
  }
  const plan = value as NormalizedFeaturePlan;
  let normalized: NormalizedFeaturePlan;
  try {
    normalized = normalizeFeaturePlan(
      {
        summary: plan.summary,
        tasks: plan.taskOrder.map((id) => structuredClone(plan.tasks[id])),
        risks: [...plan.risks],
      },
      { maxTasks: 8, maxParallel: 1 },
    );
  } catch (error) {
    if (error instanceof SdlcValidationError) {
      throw error;
    }
    throw new SdlcValidationError("normalized Feature plan", ["normalized shape is invalid"]);
  }
  if (canonicalJson(normalized) !== canonicalJson(plan)) {
    throw new SdlcValidationError("normalized Feature plan", [
      "canonical tasks, waves, or digest do not match",
    ]);
  }
}

/**
 * Validate a structured independent-review report without trusting extra fields.
 * @public
 */
export function parseReviewReport(value: unknown): ReviewReport {
  if (!validateReview(value)) {
    throw new SdlcValidationError("review report", formatSchemaErrors(validateReview.errors));
  }
  const hasBlockingFinding = value.findings.some(({ severity }) => severity === "blocking");
  if (value.approved === hasBlockingFinding) {
    throw new SdlcValidationError("review report", [
      value.approved
        ? "an approved review cannot contain blocking findings"
        : "a rejected review requires at least one blocking finding",
    ]);
  }
  return structuredClone(value);
}
