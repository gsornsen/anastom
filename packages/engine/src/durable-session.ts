import { canonicalJson, type WorkflowDefinition } from "@anastom/core";

import {
  createRunSnapshotFromState,
  extendEventHistoryDigest,
  type DurableRunStore,
  type LoadedRun,
  type RunLeaseToken,
} from "./durable-store.js";
import { materializeEvents, type RunEvent, type RunEventPayload, type RunState } from "./events.js";

const RENEWAL_INTERVAL_MS = 5_000;

interface CommitOptions {
  operationId?: string;
  handlesControlOperationId?: string;
  snapshot?: boolean;
}

interface OwnedRunSessionOptions {
  store: DurableRunStore;
  lease: RunLeaseToken;
  workflow: WorkflowDefinition;
  loaded: Pick<LoadedRun, "state" | "eventPrefixDigest">;
  createOperationId: () => string;
}

/**
 * Serialize one owner's event mutations while an independent heartbeat keeps its fence current.
 * This class is internal so storage and scheduling details do not become a second public engine API.
 */
export class OwnedRunSession {
  private currentState: RunState;
  private prefixDigest: string;
  private mutationTail: Promise<void> = Promise.resolve();
  private stopped = false;
  private heartbeatFailure: unknown;
  private mutationFailure: unknown;
  private readonly heartbeatSignal: Promise<void>;
  private resolveHeartbeatFailure!: () => void;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeHeartbeat: (() => void) | undefined;
  private readonly heartbeatWork: Promise<void>;

  private readonly store: DurableRunStore;
  readonly lease: RunLeaseToken;
  readonly workflow: WorkflowDefinition;
  private readonly createOperationId: () => string;

  /** Start serialized mutation and heartbeat ownership for one already acquired lease. */
  constructor(options: OwnedRunSessionOptions) {
    this.store = options.store;
    this.lease = options.lease;
    this.workflow = options.workflow;
    this.createOperationId = options.createOperationId;
    this.currentState = structuredClone(options.loaded.state);
    this.prefixDigest = options.loaded.eventPrefixDigest;
    this.heartbeatSignal = new Promise<void>((resolve) => {
      this.resolveHeartbeatFailure = resolve;
    });
    this.heartbeatWork = this.runHeartbeat();
  }

  /** Return a defensive copy of the latest folded state. */
  get state(): RunState {
    return structuredClone(this.currentState);
  }

  /** Reject promptly when lease renewal fails while the supplied operation is in progress. */
  async guard<T>(operation: () => Promise<T>): Promise<T> {
    this.assertHealthy();
    const work = operation();
    const outcome = await Promise.race([
      work.then((value) => ({ kind: "value" as const, value })),
      this.heartbeatSignal.then(() => ({ kind: "heartbeat" as const })),
    ]);
    if (outcome.kind === "heartbeat") {
      this.assertHealthy();
      throw new Error("Run lease heartbeat stopped without a failure");
    }
    this.assertHealthy();
    return outcome.value;
  }

  /** Append one typed transition under the current fence and update local folded state. */
  async commit(
    payloads: readonly RunEventPayload[],
    options: CommitOptions = {},
  ): Promise<RunState> {
    if (payloads.length === 0) {
      return this.state;
    }
    let result: RunState | undefined;
    const work = this.mutationTail.then(async () => {
      this.assertHealthy();
      const initial = this.currentState;
      const transition = materializeEvents(initial, this.lease.runId, payloads);
      const nextPrefix = extendPrefix(this.prefixDigest, transition.events);
      const snapshot = options.snapshot
        ? createRunSnapshotFromState(this.workflow, transition.state, nextPrefix)
        : undefined;
      await this.guard(() =>
        this.store.commit({
          lease: this.lease,
          operationId: options.operationId ?? this.createOperationId(),
          expectedSequence: initial.sequence,
          events: transition.events,
          ...(snapshot ? { snapshot } : {}),
          ...(options.handlesControlOperationId
            ? { handlesControlOperationId: options.handlesControlOperationId }
            : {}),
        }),
      );
      this.currentState = transition.state;
      this.prefixDigest = nextPrefix;
      result = this.state;
    });
    this.mutationTail = work.then(
      () => undefined,
      (error: unknown) => {
        this.mutationFailure = error;
      },
    );
    await work;
    if (!result) {
      throw new Error("Durable mutation completed without folded state");
    }
    return result;
  }

  /** Stop heartbeat work after the caller has terminated or handed off every owned execution. */
  async stop(): Promise<void> {
    if (this.stopped) {
      await this.heartbeatWork;
      return;
    }
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.wakeHeartbeat?.();
    await this.heartbeatWork;
    await this.mutationTail;
  }

  private assertHealthy(): void {
    if (this.heartbeatFailure !== undefined) {
      throw new Error("Run lease heartbeat failed", { cause: this.heartbeatFailure });
    }
    if (this.mutationFailure !== undefined) {
      throw new Error("Run mutation session failed", { cause: this.mutationFailure });
    }
    if (this.stopped) {
      throw new Error("Run lease session is stopped");
    }
  }

  private async runHeartbeat(): Promise<void> {
    while (!this.stopped) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          this.wakeHeartbeat = undefined;
          resolve();
        };
        this.wakeHeartbeat = finish;
        this.heartbeatTimer = setTimeout(finish, RENEWAL_INTERVAL_MS);
      });
      if (this.heartbeatTimer) {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
      if (this.stopped) {
        return;
      }
      try {
        await this.store.renew(this.lease);
      } catch (error) {
        this.heartbeatFailure = error;
        this.resolveHeartbeatFailure();
        return;
      }
    }
  }
}

function extendPrefix(previous: string, events: readonly RunEvent[]): string {
  let current = previous;
  for (const event of events) {
    current = extendEventHistoryDigest({
      previous: current,
      runId: event.runId,
      sequence: event.sequence,
      eventType: event.type,
      eventJson: canonicalJson(event),
    }).historyDigest;
  }
  return current;
}
