import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { digestBytes } from "@anastom/core";
import type { ArtifactStore, ArtifactWrite } from "@anastom/engine";
import { ensurePrivatePathRoot } from "@anastom/path-policy";
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
    for (const id of [artifact.runId, artifact.type]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
        throw new Error("Invalid artifact identity");
      }
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(artifact.nodeId)) {
      throw new Error("Invalid artifact producer node identity");
    }
    const digest = digestBytes(artifact.bytes);
    const id =
      artifact.nodeId + "-" + artifact.attempt + "-" + artifact.type + "-" + digest.slice(7);
    const state = await ensurePrivatePathRoot(this.stateDir);
    const dir = await state.ensureDirectory(["runs", artifact.runId, "artifacts"]);
    const bytes = Buffer.from(artifact.bytes);
    await state.writeFileExclusive(["runs", artifact.runId, "artifacts", id], bytes, {
      maxBytes: bytes.byteLength,
    });
    const uri = join(dir, id);
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
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)
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
