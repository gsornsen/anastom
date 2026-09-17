#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [behavior = "hold"] = process.argv.slice(2);
if (!["hold", "exit-leader"].includes(behavior)) {
  throw new Error("Usage: m3-attempt-worker.mjs <hold|exit-leader>");
}
const root = realpathSync(".");

const descendant = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
descendant.unref();
const record = join(root, "worker.json");
const temporary = join(root, `.worker.${process.pid}.tmp`);
try {
  writeFileSync(
    temporary,
    JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid }),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  renameSync(temporary, record);
} catch (error) {
  descendant.kill("SIGKILL");
  throw error;
} finally {
  rmSync(temporary, { force: true });
}

if (behavior === "exit-leader") {
  setInterval(() => {
    if (existsSync(join(root, "release-leader"))) {
      process.exit(0);
    }
  }, 10);
} else {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
