import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { digestBytes } from "@anastom/core";
import type { ArtifactStore, ArtifactWrite } from "@anastom/engine";
import type { ArtifactRef } from "@anastom/runtime-contract";

/**
 * Immutable filesystem evidence with confined producer paths and SHA-256 integrity verification.
 */
export class FileArtifactStore implements ArtifactStore {
  /**
   * Select the evidence root; files are created only when write is called.
   */
  constructor(readonly stateDir: string) {}
  /**
   * Write immutable evidence using confined producer paths, private permissions, and content digests.
   * @throws If identity is unsafe, a path crosses a symlink, or existing bytes differ.
   */
  async write(artifact: ArtifactWrite): Promise<ArtifactRef> {
    if (!Number.isSafeInteger(artifact.attempt) || artifact.attempt < 1) {
      throw new Error("Invalid artifact attempt");
    }
    for (const id of [artifact.runId, artifact.nodeId, artifact.type]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
        throw new Error("Invalid artifact identity");
      }
    }
    const digest = digestBytes(artifact.bytes);
    const id =
      artifact.nodeId + "-" + artifact.attempt + "-" + artifact.type + "-" + digest.slice(7);
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(this.stateDir);
    const authoredDir = resolve(stateRoot, "runs", artifact.runId, "artifacts");
    await mkdir(authoredDir, { recursive: true, mode: 0o700 });
    if ((await lstat(authoredDir)).isSymbolicLink()) {
      throw new Error("Artifact directory must not be a symlink");
    }
    const dir = await realpath(authoredDir);
    if (dir !== authoredDir) {
      throw new Error("Artifact parent must not be a symlink");
    }
    const uri = resolve(dir, id);
    try {
      await writeFile(uri, artifact.bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      if ((await lstat(uri)).isSymbolicLink()) {
        throw new Error("Artifact file must not be a symlink", { cause: error });
      }
      if (digestBytes(await readFile(uri)) !== digest) {
        throw new Error("Existing artifact digest mismatch", { cause: error });
      }
    }
    return {
      id,
      type: artifact.type,
      mediaType: artifact.mediaType,
      uri,
      digest,
      producer: { runId: artifact.runId, nodeId: artifact.nodeId, attempt: artifact.attempt },
    };
  }
  /**
   * Read referenced evidence within the configured root and verify its SHA-256 digest.
   */
  async read(artifact: ArtifactRef): Promise<Buffer> {
    const runId = artifact.producer.runId;
    const id = artifact.id;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)
    ) {
      throw new Error("Invalid artifact identity");
    }
    const stateRoot = await realpath(this.stateDir);
    const authoredDir = resolve(stateRoot, "runs", runId, "artifacts");
    const boundary = stateRoot.endsWith(sep) ? stateRoot : stateRoot + sep;
    if (!authoredDir.startsWith(boundary)) {
      throw new Error("Artifact parent escapes the configured state root");
    }
    // No run-owned ancestor may redirect the read outside the state root.
    if ((await realpath(authoredDir)) !== authoredDir) {
      throw new Error("Artifact parent is a symlink");
    }
    const expectedFile = resolve(authoredDir, id);
    if (resolve(artifact.uri) !== expectedFile) {
      throw new Error("Invalid artifact path");
    }
    const metadata = await lstat(expectedFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Artifact file must be an ordinary file");
    }
    const bytes = await readFile(expectedFile);
    if (digestBytes(bytes) !== artifact.digest) {
      throw new Error("Artifact digest mismatch");
    }
    return bytes;
  }
}
