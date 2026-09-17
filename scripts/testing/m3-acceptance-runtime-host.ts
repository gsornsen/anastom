import { runExecutionRuntimeHost } from "../../packages/execution-host/src/index.js";

import {
  M3AcceptanceRuntimeAdapter,
  parseM3AcceptanceDescriptor,
} from "./m3-acceptance-runtime.js";

const probeRoot = process.argv[2];
if (!probeRoot) {
  throw new Error("M3 acceptance runtime host requires a probe root");
}

await runExecutionRuntimeHost(async (descriptor) => {
  return new M3AcceptanceRuntimeAdapter(parseM3AcceptanceDescriptor(descriptor), probeRoot);
});
