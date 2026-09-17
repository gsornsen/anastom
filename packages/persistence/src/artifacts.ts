import { join, resolve } from "node:path";
import { digestBytes } from "@anastom/core";
import type { ArtifactStore, ArtifactWrite } from "@anastom/engine";
import { ensurePrivatePathRoot } from "@anastom/path-policy";
import type { ArtifactRef } from "@anastom/runtime-contract";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

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
    const bytes = Buffer.from(artifact.bytes);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error("Artifact exceeds the 16 MiB limit");
    }
    const digest = digestBytes(bytes);
    const id =
      artifact.nodeId + "-" + artifact.attempt + "-" + artifact.type + "-" + digest.slice(7);
    const state = await ensurePrivatePathRoot(this.stateDir);
    const dir = await state.ensureDirectory(["runs", artifact.runId, "artifacts"]);
    await state.writeFileExclusive(["runs", artifact.runId, "artifacts", id], bytes, {
      maxBytes: MAX_ARTIFACT_BYTES,
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
    const state = await ensurePrivatePathRoot(this.stateDir);
    const segments = ["runs", runId, "artifacts", id] as const;
    const expectedFile = join(state.path, ...segments);
    if (resolve(artifact.uri) !== expectedFile) {
      throw new Error("Invalid artifact path");
    }
    const bytes = await state.readFile(segments, { maxBytes: MAX_ARTIFACT_BYTES });
    if (digestBytes(bytes) !== artifact.digest) {
      throw new Error("Artifact digest mismatch");
    }
    return bytes;
  }
}
