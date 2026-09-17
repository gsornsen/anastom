import { access } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "@anastom/core";
import { ensurePrivatePathRoot } from "@anastom/path-policy";

import { LocalExecutionHost, localProcessIdentity } from "../index.js";
import { waitForCondition } from "../process.js";
import { fixturePrepare, fixtureRuntimeHost, type FixtureOwner } from "./fixtures.js";

const [owner] = process.argv.slice(2);
if (!owner || !["pi", "codex", "claude-code", "command"].includes(owner)) {
  throw new Error("Fixture coordinator requires a current execution owner");
}

const root = await ensurePrivatePathRoot(process.cwd());
const stateDir = await root.ensureDirectory(["state"]);
const workspace = await root.ensureDirectory(["workspace"]);
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
const record = Buffer.from(
  canonicalJson({ coordinator, execution, sideEffectBeforeAuthorization }),
);
await root.writeFileAtomic(["coordinator-ready.json"], record, { maxBytes: 64 * 1024 });
await new Promise<void>(() => {});
