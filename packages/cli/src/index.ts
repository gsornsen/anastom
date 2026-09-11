import { loadWorkflow } from "@anastom/core";
import {
  InMemoryRunPersistence,
  WorkflowEngine,
  renderRunStatus,
  renderWorkflowGraph,
  type RunPersistence,
} from "@anastom/engine";
import { FakeRuntimeAdapter, loadFakeScenario } from "@anastom/runtime-fake";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliOptions {
  io?: CliIo;
  persistence?: RunPersistence;
}

const processLocalPersistence = new InMemoryRunPersistence();

function usage(): string {
  return [
    "Usage:",
    "  anastom validate <workflow>",
    "  anastom graph <workflow>",
    "  anastom run <workflow> --fake-scenario <file>",
    "  anastom inspect <run>",
  ].join("\n");
}

export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? {
    stdout: (message: string) => console.log(message),
    stderr: (message: string) => console.error(message),
  };
  const persistence = options.persistence ?? processLocalPersistence;

  try {
    const [command, target, ...rest] = args;
    if (command === "validate" && target !== undefined && rest.length === 0) {
      const workflow = await loadWorkflow(target);
      io.stdout(`valid ${workflow.metadata.id}@${workflow.metadata.version} (${workflow.nodeOrder.length} nodes)`);
      return 0;
    }
    if (command === "graph" && target !== undefined && rest.length === 0) {
      io.stdout(renderWorkflowGraph(await loadWorkflow(target)));
      return 0;
    }
    if (command === "run" && target !== undefined) {
      const scenarioFlag = rest.indexOf("--fake-scenario");
      const scenarioPath = scenarioFlag === -1 ? undefined : rest[scenarioFlag + 1];
      if (scenarioPath === undefined || rest.length !== 2 || scenarioFlag !== 0) {
        throw new Error("run requires exactly one --fake-scenario <file> option");
      }
      const workflow = await loadWorkflow(target);
      const runtime = new FakeRuntimeAdapter(await loadFakeScenario(scenarioPath));
      const engine = new WorkflowEngine({ runtime, persistence });
      const state = await engine.start(workflow);
      io.stdout(renderRunStatus(state, workflow));
      return state.status === "succeeded" ? 0 : 1;
    }
    if (command === "inspect" && target !== undefined && rest.length === 0) {
      const run = await persistence.load(target);
      if (run === null) throw new Error(`Run ${target} was not found in process-local storage`);
      const engine = new WorkflowEngine({ runtime: new FakeRuntimeAdapter({ nodes: {} }), persistence });
      const state = await engine.inspect(target);
      if (state === null) throw new Error(`Run ${target} was not found`);
      io.stdout(renderRunStatus(state, run.workflow));
      return 0;
    }
    io.stderr(usage());
    return 2;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
