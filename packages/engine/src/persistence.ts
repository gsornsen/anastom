import type { WorkflowDefinition } from "@anastom/core";

import type { RunEvent } from "./events.js";

export interface PersistedRun {
  workflow: WorkflowDefinition;
  events: RunEvent[];
}

export interface RunPersistence {
  create(runId: string, run: PersistedRun): Promise<void>;
  append(runId: string, expectedSequence: number, events: readonly RunEvent[]): Promise<void>;
  load(runId: string): Promise<PersistedRun | null>;
}

export class PersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

export class InMemoryRunPersistence implements RunPersistence {
  private readonly runs = new Map<string, PersistedRun>();

  async create(runId: string, run: PersistedRun): Promise<void> {
    if (this.runs.has(runId)) throw new PersistenceConflictError(`Run ${runId} already exists`);
    this.runs.set(runId, structuredClone(run));
  }

  async append(runId: string, expectedSequence: number, events: readonly RunEvent[]): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new PersistenceConflictError(`Run ${runId} does not exist`);
    const actualSequence = run.events.at(-1)?.sequence ?? 0;
    if (actualSequence !== expectedSequence) {
      throw new PersistenceConflictError(
        `Run ${runId} is at sequence ${actualSequence}; expected ${expectedSequence}`,
      );
    }
    for (const [index, event] of events.entries()) {
      const expected = expectedSequence + index + 1;
      if (event.runId !== runId || event.sequence !== expected) {
        throw new PersistenceConflictError(`Event at offset ${index} is not sequence ${expected} for run ${runId}`);
      }
    }
    run.events.push(...structuredClone(events));
  }

  async load(runId: string): Promise<PersistedRun | null> {
    const run = this.runs.get(runId);
    return run === undefined ? null : structuredClone(run);
  }
}
