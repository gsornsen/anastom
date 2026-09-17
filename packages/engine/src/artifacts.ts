import type { ArtifactRef } from "@anastom/runtime-contract";

/**
 * Artifact bytes and producer identity supplied to an immutable artifact store.
 */
export interface ArtifactWrite {
  runId: string;
  nodeId: string;
  attempt: number;
  type: string;
  mediaType: string;
  bytes: string | Uint8Array;
}
/**
 * Persist evidence bytes and return a content-digested reference.
 */
export interface ArtifactStore {
  /** Persist immutable producer-owned bytes and return a content-digested reference. */
  write(artifact: ArtifactWrite): Promise<ArtifactRef>;
  /** Read immutable evidence bytes and verify the supplied reference before use. */
  read?(artifact: ArtifactRef): Promise<Uint8Array>;
}
