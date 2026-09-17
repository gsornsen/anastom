import { runExecutionRuntimeHost } from "../../packages/execution-host/src/index.js";

import {
  DefinedSdlcAcceptanceRuntimeAdapter,
  parseDefinedSdlcAcceptanceDescriptor,
} from "./defined-sdlc-acceptance-runtime.js";

const probeRoot = process.argv[2];
if (!probeRoot) {
  throw new Error("Defined-SDLC acceptance runtime host requires a probe root");
}

await runExecutionRuntimeHost(async (descriptor) => {
  return new DefinedSdlcAcceptanceRuntimeAdapter(
    parseDefinedSdlcAcceptanceDescriptor(descriptor),
    probeRoot,
  );
});
