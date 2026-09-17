#!/usr/bin/env node
import { runExecutionRuntimeHost } from "@anastom/execution-host";

import { resolveDurableRuntime } from "./runtime-registry.js";

await runExecutionRuntimeHost(resolveDurableRuntime);
