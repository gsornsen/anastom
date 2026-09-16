#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, behavior = "hold"] = process.argv.slice(2);
if (!root || !["hold", "exit-leader"].includes(behavior)) {
  throw new Error("Usage: m3-attempt-worker.mjs <record-directory> <hold|exit-leader>");
}

const descendant = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
descendant.unref();
writeFileSync(
  join(root, "worker.json"),
  JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid }),
  { mode: 0o600 },
);

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
