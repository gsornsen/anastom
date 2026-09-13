import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digestBytes } from "@anastom/core";
import type { ArtifactStore, ArtifactWrite } from "@anastom/engine";
import type { ArtifactRef } from "@anastom/runtime-contract";

export class FileArtifactStore implements ArtifactStore {
  constructor(readonly stateDir: string) {}
  async write(artifact: ArtifactWrite): Promise<ArtifactRef> {
    if (!Number.isSafeInteger(artifact.attempt) || artifact.attempt < 1) throw new Error("Invalid artifact attempt");
    for (const id of [artifact.runId, artifact.nodeId, artifact.type]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid artifact identity");
    }
    const digest = digestBytes(artifact.bytes);
    const id = artifact.nodeId + "-" + artifact.attempt + "-" + artifact.type + "-" + digest.slice(7);
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(this.stateDir);
    const authoredDir = resolve(stateRoot, "runs", artifact.runId, "artifacts");
    await mkdir(authoredDir, { recursive: true, mode: 0o700 });
    if ((await lstat(authoredDir)).isSymbolicLink()) throw new Error("Artifact directory must not be a symlink");
    const dir = await realpath(authoredDir);
    if (dir !== authoredDir) throw new Error("Artifact parent must not be a symlink");
    const uri = resolve(dir, id);
    try { await writeFile(uri, artifact.bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if ((await lstat(uri)).isSymbolicLink()) throw new Error("Artifact file must not be a symlink", { cause: error });
      if (digestBytes(await readFile(uri)) !== digest) throw new Error("Existing artifact digest mismatch", { cause: error });
    }
    return { id, type: artifact.type, mediaType: artifact.mediaType, uri, digest, producer: { runId: artifact.runId, nodeId: artifact.nodeId, attempt: artifact.attempt } };
  }
  async read(artifact: ArtifactRef): Promise<Buffer> {
    if (![artifact.producer.runId, artifact.id].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))) throw new Error("Invalid artifact identity");
    const expectedDir = await realpath(resolve(this.stateDir, "runs", artifact.producer.runId, "artifacts"));
    if (resolve(artifact.uri) !== resolve(expectedDir, artifact.id) || await realpath(artifact.uri) !== artifact.uri) throw new Error("Invalid artifact path");
    const bytes = await readFile(artifact.uri);
    if (digestBytes(bytes) !== artifact.digest) throw new Error("Artifact digest mismatch");
    return bytes;
  }
}
