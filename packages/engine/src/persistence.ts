import type { WorkflowDefinition } from "@anastom/core";

import type { RunEvent } from "./events.js";

/**
 * The immutable workflow snapshot and its complete ordered event history.
 */
export interface PersistedRun {
  workflow: WorkflowDefinition;
  events: RunEvent[];
}

/**
 * Append-only run storage; append must atomically compare the expected sequence and persist a batch.
 */
export interface RunPersistence {
  /** Atomically persist a new immutable definition and validated initial events. */
  create(runId: string, run: PersistedRun): Promise<void>;
  /** Atomically compare the current sequence and append the complete event batch. */
  append(runId: string, expectedSequence: number, events: readonly RunEvent[]): Promise<void>;
  /** Return the workflow and complete history, or null if absent; never invoke a worker. */
  load(runId: string): Promise<PersistedRun | null>;
}

/**
 * Signals duplicate creation or a stale expected event sequence; callers must reload state.
 * @public
 */
export class PersistenceConflictError extends Error {
  /**
   * Construct a classified optimistic concurrency error.
   */
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

/**
 * Process-local append-only storage for deterministic workflow execution and tests.
 */
export class InMemoryRunPersistence implements RunPersistence {
  private readonly runs = new Map<string, PersistedRun>();

  /**
   * Persist a new immutable workflow and validated event batch; reject duplicate run IDs.
   */
  async create(runId: string, run: PersistedRun): Promise<void> {
    if (this.runs.has(runId)) {
      throw new PersistenceConflictError(`Run ${runId} already exists`);
    }
    this.runs.set(runId, structuredClone(run));
  }

  /**
   * Atomically verify the current sequence and append a validated event batch.
   */
  async append(
    runId: string,
    expectedSequence: number,
    events: readonly RunEvent[],
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new PersistenceConflictError(`Run ${runId} does not exist`);
    }
    const actualSequence = run.events.at(-1)?.sequence ?? 0;
    if (actualSequence !== expectedSequence) {
      throw new PersistenceConflictError(
        `Run ${runId} is at sequence ${actualSequence}; expected ${expectedSequence}`,
      );
    }
    for (const [index, event] of events.entries()) {
      const expected = expectedSequence + index + 1;
      if (event.runId !== runId || event.sequence !== expected) {
        throw new PersistenceConflictError(
          `Event at offset ${index} is not sequence ${expected} for run ${runId}`,
        );
      }
    }
    run.events.push(...structuredClone(events));
  }

  /**
   * Return a defensive copy of the workflow and events, or null if absent.
   */
  async load(runId: string): Promise<PersistedRun | null> {
    const run = this.runs.get(runId);
    return run === undefined ? null : structuredClone(run);
  }
}
