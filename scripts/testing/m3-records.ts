import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type M3RecordName =
  | "attempt-plan.json"
  | "contention-a-ready.json"
  | "contention-a-request.json"
  | "contention-b-ready.json"
  | "contention-b-request.json"
  | "contention-gate.json"
  | "execution-control.json"
  | "execution-manifest.json"
  | "execution-probe.json"
  | "execution-terminal.json"
  | "protocol-coordinator.json"
  | "protocol-terminal.json"
  | "record.json"
  | "side-effect.json"
  | "start-authority.json"
  | "start-release.json"
  | "worker.json"
  | "supervisor-owner.json"
  | "supervisor-ready.json"
  | "supervisor-cleaned.json";

/** Read one fixed-name M3 fixture record after its atomic publication. */
export async function readM3Record<T>(root: string, name: M3RecordName): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(root, name), "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Publish one fixed-name M3 fixture record without exposing partial JSON to a reader. */
export async function writeM3Record(
  root: string,
  name: M3RecordName,
  value: unknown,
): Promise<void> {
  const temporary = join(root, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, join(root, name));
  } finally {
    await rm(temporary, { force: true });
  }
}
