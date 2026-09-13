import type { ArtifactRef } from "@anastom/runtime-contract";

export interface ArtifactWrite {
  runId: string; nodeId: string; attempt: number; type: string; mediaType: string; bytes: string | Uint8Array;
}
export interface ArtifactStore {
  write(artifact: ArtifactWrite): Promise<ArtifactRef>;
}
