import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, digestBytes } from "../packages/core/src/index.js";

const taskIdPattern = /^[a-z][a-z0-9-]{0,47}$/;

interface PlanTask {
  id: string;
  dependsOn: readonly string[];
  scopes: readonly string[];
}

interface ExpansionNode {
  id: string;
  kind: "agent" | "integration" | "command";
  needs: readonly string[];
  taskId?: string;
}

interface Expansion {
  version: "anastom.dev/workflow-expansion/v1alpha1";
  sourceDigest: string;
  nodeOrder: readonly string[];
  nodes: Readonly<Record<string, ExpansionNode>>;
}

interface SimulationResult {
  completionOrder: string[];
  integrationOrder: string[];
  maxActive: number;
}

/** Normalize the bounded repository-relative scope used by the graph probe. */
function normalizeScope(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`Invalid task scope: ${value}`);
  }
  const normalized = posix.normalize(value).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === ".") {
    throw new Error(`Invalid task scope: ${value}`);
  }
  return normalized;
}

function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function taskWaves(tasks: readonly PlanTask[]): string[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) {
    throw new Error("Plan task IDs must be unique");
  }
  for (const task of tasks) {
    if (!taskIdPattern.test(task.id)) {
      throw new Error(`Invalid plan task ID: ${task.id}`);
    }
    if (new Set(task.dependsOn).size !== task.dependsOn.length) {
      throw new Error(`Task ${task.id} has duplicate dependencies`);
    }
    for (const dependency of task.dependsOn) {
      if (dependency === task.id || !byId.has(dependency)) {
        throw new Error(`Task ${task.id} has an invalid dependency`);
      }
    }
  }

  const remaining = new Set(tasks.map((task) => task.id));
  const completed = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = tasks
      .filter(
        (task) =>
          remaining.has(task.id) && task.dependsOn.every((dependency) => completed.has(dependency)),
      )
      .map((task) => task.id);
    if (wave.length === 0) {
      throw new Error("Plan task graph contains a cycle");
    }
    for (const taskId of wave) {
      remaining.delete(taskId);
      completed.add(taskId);
    }
    waves.push(wave);
  }
  return waves;
}

/** Validate bounded plan data and create one deterministic generic graph expansion. */
function expandFeasibilityPlan(tasks: readonly PlanTask[]): Expansion {
  if (tasks.length < 2 || tasks.length > 8) {
    throw new Error("Plan must contain between two and eight tasks");
  }
  const normalized = tasks.map((task) => ({
    id: task.id,
    dependsOn: [...task.dependsOn],
    scopes: task.scopes.map(normalizeScope),
  }));
  for (const task of normalized) {
    if (task.scopes.length === 0 || new Set(task.scopes).size !== task.scopes.length) {
      throw new Error(`Task ${task.id} must have unique mutation scopes`);
    }
  }
  const waves = taskWaves(normalized);
  for (const wave of waves) {
    for (let left = 0; left < wave.length; left += 1) {
      for (let right = left + 1; right < wave.length; right += 1) {
        const leftTask = normalized.find((task) => task.id === wave[left])!;
        const rightTask = normalized.find((task) => task.id === wave[right])!;
        if (
          leftTask.scopes.some((first) =>
            rightTask.scopes.some((second) => scopesOverlap(first, second)),
          )
        ) {
          throw new Error(`Ready tasks ${leftTask.id} and ${rightTask.id} have overlapping scopes`);
        }
      }
    }
  }

  const nodes: Record<string, ExpansionNode> = {};
  let priorIntegration = "plan";
  waves.forEach((wave, index) => {
    for (const taskId of wave) {
      const id = `implement.${taskId}`;
      nodes[id] = { id, kind: "agent", needs: [priorIntegration], taskId };
    }
    const integrationId = `integrate.wave-${index + 1}`;
    nodes[integrationId] = {
      id: integrationId,
      kind: "integration",
      needs: [
        ...(priorIntegration === "plan" ? [] : [priorIntegration]),
        ...wave.map((id) => `implement.${id}`),
      ],
    };
    priorIntegration = integrationId;
  });
  nodes.integrator = { id: "integrator", kind: "agent", needs: [priorIntegration] };
  nodes["review.specification"] = {
    id: "review.specification",
    kind: "agent",
    needs: ["integrator"],
  };
  nodes["review.quality"] = {
    id: "review.quality",
    kind: "agent",
    needs: ["integrator"],
  };
  nodes.verify = {
    id: "verify",
    kind: "command",
    needs: ["review.specification", "review.quality"],
  };
  const sourceDigest = digestBytes(canonicalJson(normalized));
  const nodeOrder = Object.keys(nodes);
  return {
    version: "anastom.dev/workflow-expansion/v1alpha1",
    sourceDigest,
    nodeOrder,
    nodes,
  };
}

function simulate(
  expansion: Expansion,
  chooseCompletion: (active: readonly string[]) => string,
): SimulationResult {
  const pending = new Set(expansion.nodeOrder);
  const active: string[] = [];
  const succeeded = new Set(["plan"]);
  const completionOrder: string[] = [];
  const integrationOrder: string[] = [];
  let maxActive = 0;
  while (pending.size > 0 || active.length > 0) {
    for (const nodeId of expansion.nodeOrder) {
      const node = expansion.nodes[nodeId]!;
      if (
        active.length < 2 &&
        pending.has(nodeId) &&
        node.needs.every((dependency) => succeeded.has(dependency))
      ) {
        pending.delete(nodeId);
        active.push(nodeId);
      }
    }
    maxActive = Math.max(maxActive, active.length);
    if (active.length === 0) {
      throw new Error("Expanded graph became unschedulable");
    }
    const completed = chooseCompletion(active);
    const index = active.indexOf(completed);
    if (index < 0) {
      throw new Error("Completion selector returned an inactive node");
    }
    active.splice(index, 1);
    succeeded.add(completed);
    completionOrder.push(completed);
    if (completed.startsWith("integrate.wave-")) {
      integrationOrder.push(
        ...expansion.nodes[completed]!.needs.filter((nodeId) => nodeId.startsWith("implement.")),
      );
    }
  }
  return { completionOrder, integrationOrder, maxActive };
}

/** Run the deterministic graph-expansion feasibility matrix. */
export function runM4GraphFeasibility(): {
  stableExpansion: boolean;
  alternateCompletionOrders: boolean;
  deterministicIntegrationOrder: boolean;
  boundedParallelism: boolean;
  cycleRejected: boolean;
  overlapRejected: boolean;
  traversalRejected: boolean;
} {
  const plan: PlanTask[] = [
    { id: "server", dependsOn: [], scopes: ["src/server.ts"] },
    { id: "tests", dependsOn: [], scopes: ["test/server.test.ts"] },
    { id: "documentation", dependsOn: ["server", "tests"], scopes: ["README.md"] },
  ];
  const expansion = expandFeasibilityPlan(plan);
  const repeated = expandFeasibilityPlan(structuredClone(plan));
  const first = simulate(expansion, (active) => active[0]!);
  const second = simulate(expansion, (active) => active.at(-1)!);

  let cycleRejected = false;
  let overlapRejected = false;
  let traversalRejected = false;
  try {
    expandFeasibilityPlan([
      { id: "first", dependsOn: ["second"], scopes: ["src/a.ts"] },
      { id: "second", dependsOn: ["first"], scopes: ["src/b.ts"] },
    ]);
  } catch {
    cycleRejected = true;
  }
  try {
    expandFeasibilityPlan([
      { id: "first", dependsOn: [], scopes: ["src"] },
      { id: "second", dependsOn: [], scopes: ["src/b.ts"] },
    ]);
  } catch {
    overlapRejected = true;
  }
  try {
    expandFeasibilityPlan([
      { id: "first", dependsOn: [], scopes: ["../outside"] },
      { id: "second", dependsOn: [], scopes: ["src/b.ts"] },
    ]);
  } catch {
    traversalRejected = true;
  }

  return {
    stableExpansion: canonicalJson(expansion) === canonicalJson(repeated),
    alternateCompletionOrders:
      canonicalJson(first.completionOrder) !== canonicalJson(second.completionOrder),
    deterministicIntegrationOrder:
      canonicalJson(first.integrationOrder) === canonicalJson(second.integrationOrder) &&
      canonicalJson(first.integrationOrder) ===
        canonicalJson(["implement.server", "implement.tests", "implement.documentation"]),
    boundedParallelism: first.maxActive === 2 && second.maxActive === 2,
    cycleRejected,
    overlapRejected,
    traversalRejected,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(runM4GraphFeasibility(), null, 2));
}
