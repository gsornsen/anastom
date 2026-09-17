import type { DurableRunInspection } from "./durable.js";
import { renderTerminalFrame } from "./terminal-frame.js";
import type { TerminalHost, TerminalKey } from "./terminal-host.js";
import { projectTerminalRunView, type TerminalRunView } from "./terminal-view.js";

const enterTerminal = "\u001b[?1049h\u001b[?25l";
const leaveTerminal = "\u001b[?25h\u001b[?1049l";
const paintTerminal = "\u001b[H\u001b[2J";

/** Operations delegated by the terminal to existing durable control and coordinator boundaries. */
interface TerminalRunOperations {
  load(): Promise<DurableRunInspection | null>;
  submit(
    action: "pause" | "cancel",
    operationId: string,
  ): Promise<{ replayed: boolean; coordinatorLaunchError?: string }>;
  launchResume(operationId: string): Promise<void>;
}

/** Injectable session dependencies used by production attach and recorded terminal acceptance. */
export interface TerminalSessionOptions {
  host: TerminalHost;
  operations: TerminalRunOperations;
  createOperationId(): string;
  refreshMs?: number;
}

/** Run one full-screen attachment until the operator explicitly detaches. */
export async function runTerminalSession(options: TerminalSessionOptions): Promise<void> {
  const refreshMs = options.refreshMs ?? 500;
  let detached = false;
  let resized = true;
  let inFlight: Exclude<TerminalKey, "detach"> | undefined;
  const pending: Exclude<TerminalKey, "detach">[] = [];
  let notification: string | undefined;
  let latest: TerminalRunView | undefined;
  let wake: (() => void) | undefined;
  const closeInput = options.host.open(
    (key) => {
      if (key === "detach") {
        detached = true;
      } else if (key !== inFlight && !pending.includes(key)) {
        pending.push(key);
      }
      wake?.();
    },
    () => {
      resized = true;
      wake?.();
    },
  );
  options.host.write(enterTerminal);
  try {
    while (!detached) {
      const action = pending.shift();
      if (action) {
        inFlight = action;
        try {
          notification = await applyTerminalAction(action, latest, options);
        } catch (error) {
          notification = `Control failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
          inFlight = undefined;
        }
      }
      const inspection = await options.operations.load();
      if (!inspection) {
        throw new Error("Attached run no longer exists in durable storage");
      }
      if (detached) {
        break;
      }
      const next = projectTerminalRunView(inspection);
      if (resized || notification || frameChanged(latest, next)) {
        const size = options.host.size();
        options.host.write(
          paintTerminal +
            renderTerminalFrame(next, {
              ...size,
              color: options.host.color(),
              ...(notification ? { notification } : {}),
            }),
        );
        resized = false;
        notification = undefined;
      }
      latest = next;
      if (detached) {
        break;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, refreshMs);
        wake = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    closeInput();
    options.host.write(leaveTerminal);
  }
}

async function applyTerminalAction(
  action: Exclude<TerminalKey, "detach">,
  view: TerminalRunView | undefined,
  options: TerminalSessionOptions,
): Promise<string> {
  if (!view) {
    return "Run state is still loading; control was not submitted";
  }
  const operationId = options.createOperationId();
  if (action === "resume") {
    if (["succeeded", "failed", "blocked", "cancelled"].includes(view.status)) {
      return `Resume unavailable while run is ${view.status}`;
    }
    await options.operations.launchResume(operationId);
    return `Resume launched: operation=${operationId}`;
  }
  if (action === "pause" && view.status === "paused") {
    return "Run is already paused";
  }
  if (action === "cancel" && view.status === "cancelled") {
    return "Run is already cancelled";
  }
  if (["succeeded", "failed", "blocked", "cancelled"].includes(view.status)) {
    return `${action} unavailable while run is ${view.status}`;
  }
  const receipt = await options.operations.submit(action, operationId);
  const accepted = `Control accepted: action=${action} operation=${operationId} replayed=${receipt.replayed}`;
  return receipt.coordinatorLaunchError
    ? `${accepted}; coordinator launch failed: ${receipt.coordinatorLaunchError}`
    : accepted;
}

function frameChanged(previous: TerminalRunView | undefined, next: TerminalRunView): boolean {
  return previous === undefined || JSON.stringify(previous) !== JSON.stringify(next);
}
