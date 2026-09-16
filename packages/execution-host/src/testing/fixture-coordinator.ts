import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LocalExecutionHost, localProcessIdentity } from "../index.js";
import { waitForCondition } from "../process.js";
import { fixturePrepare, fixtureRuntimeHost, type FixtureOwner } from "./fixtures.js";

const [root, owner] = process.argv.slice(2);
if (!root || !owner || !["pi", "codex", "claude-code", "command"].includes(owner)) {
  throw new Error("Fixture coordinator requires a root and current execution owner");
}

const stateDir = join(root, "state");
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
const coordinator = await localProcessIdentity();
const host = new LocalExecutionHost({ stateDir, runtimeHost: fixtureRuntimeHost() });
const input = fixturePrepare(workspace, owner as FixtureOwner, "hold", coordinator);
const execution = await host.prepare(input);
let sideEffectBeforeAuthorization = true;
try {
  await access(join(workspace, "side-effect.json"));
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    sideEffectBeforeAuthorization = false;
  } else {
    throw error;
  }
}
await host.authorize(execution);
await waitForCondition(
  "fixture execution readiness",
  async () => {
    try {
      await access(join(workspace, "processes.json"));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  },
  10_000,
);
const record = JSON.stringify({ coordinator, execution, sideEffectBeforeAuthorization });
const temporary = join(root, ".coordinator-ready.tmp");
await writeFile(temporary, record, { flag: "wx", mode: 0o600 });
await rename(temporary, join(root, "coordinator-ready.json"));
await new Promise<void>(() => {});
