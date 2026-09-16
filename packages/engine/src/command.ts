import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { canonicalExistingRoot, resolveExistingChild } from "@anastom/path-policy";
import type { CommandDefinition } from "@anastom/core";
import type { ExecutionFailure, WorkspaceRef } from "@anastom/runtime-contract";

/**
 * Verifier exit status, timing, and output accounting; success requires an exit code of zero.
 */
export interface CommandReport {
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}
/**
 * A verifier report, bounded retained stdout/stderr bytes, and optional classified failure.
 */
export interface CommandExecution {
  output: CommandReport;
  stdout: Buffer;
  stderr: Buffer;
  failure?: ExecutionFailure;
}
/**
 * Execute a normalized command within its workspace and return verifiable evidence.
 */
export interface CommandExecutor {
  /** Execute exact argv under the workspace policy and return bounded independent evidence. */
  execute(command: CommandDefinition, workspace: WorkspaceRef): Promise<CommandExecution>;
}

/**
 * Build a small verifier environment allowlist, excluding provider credentials and unrelated process variables.
 */
export function verificationEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "COMSPEC",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}
/**
 * Run exact argv without a shell, confine cwd, bound output, and terminate overdue processes.
 */
export class LocalCommandExecutor implements CommandExecutor {
  /**
   * Set the bounded grace period between graceful process termination and forced kill.
   */
  constructor(private readonly cancellationGraceMs = 500) {}
  /**
   * Spawn exact argv in a confined real cwd, drain bounded output, and enforce the deadline on the process group.
   */
  async execute(command: CommandDefinition, workspace: WorkspaceRef): Promise<CommandExecution> {
    if (workspace.mode === "memory") {
      throw new Error("Commands require a filesystem workspace");
    }
    if (!command.argv.length || command.argv.some((arg) => !arg || arg.includes("\0"))) {
      throw new Error("Command requires a nonempty argument vector");
    }
    if (isAbsolute(command.cwd)) {
      throw new Error("Command cwd must be workspace-relative");
    }
    const root = await canonicalExistingRoot(workspace.path);
    const cwd = await resolveExistingChild(root, command.cwd, "directory");
    if (
      !Number.isSafeInteger(command.maxDurationMs) ||
      command.maxDurationMs <= 0 ||
      command.maxDurationMs > 2147483647 ||
      !Number.isSafeInteger(command.maxOutputBytes) ||
      command.maxOutputBytes <= 0 ||
      command.maxOutputBytes > 16777216
    ) {
      throw new Error("Invalid command limits");
    }
    return new Promise((done) => {
      const started = performance.now();
      const child = spawn(command.argv[0] as string, [...command.argv.slice(1)], {
        cwd,
        env: verificationEnvironment(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdoutBytes = 0,
        stderrBytes = 0,
        stdoutKept = 0,
        stderrKept = 0;
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        const kept = chunk.subarray(0, Math.max(0, command.maxOutputBytes - stdoutKept));
        stdoutKept += kept.length;
        if (kept.length) {
          stdout.push(Buffer.from(kept));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        const kept = chunk.subarray(0, Math.max(0, command.maxOutputBytes - stderrKept));
        stderrKept += kept.length;
        if (kept.length) {
          stderr.push(Buffer.from(kept));
        }
      });
      let timedOut = false;
      let failedToStart = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid !== undefined) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            failedToStart = true;
          }
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        grace = setTimeout(() => kill("SIGKILL"), this.cancellationGraceMs);
      }, command.maxDurationMs);
      child.on("error", () => {
        failedToStart = true;
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        if (grace) {
          clearTimeout(grace);
        }
        const passed = !timedOut && !failedToStart && exitCode === 0;
        let failureMessage = "Verification command exited with code " + exitCode;
        if (failedToStart) {
          failureMessage = "Verification command could not start or terminate";
        }
        if (timedOut) {
          failureMessage = "Verification command exceeded its duration limit";
        }
        done({
          output: {
            passed,
            exitCode,
            signal,
            durationMs: performance.now() - started,
            stdoutBytes,
            stderrBytes,
            stdoutTruncated: stdoutBytes > stdoutKept,
            stderrTruncated: stderrBytes > stderrKept,
          },
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          ...(passed
            ? {}
            : {
                failure: {
                  category: timedOut ? "budget-exhausted" : "tool",
                  message: failureMessage,
                },
              }),
        });
      });
    });
  }
}
