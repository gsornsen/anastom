#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenario] = process.argv.slice(2);
if (!["success", "hold"].includes(scenario)) {
  throw new Error("Usage: m3-protocol-command.mjs <success|hold>");
}

if (scenario === "success") {
  process.stdout.write(
    JSON.stringify({ summary: "Command fixture completed", changedFiles: [], notes: [] }) + "\n",
  );
  process.exit(0);
}

const root = realpathSync(".");
const descendant = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
descendant.unref();
const target = join(root, "worker.json");
const temporary = join(root, `.protocol-command.${process.pid}.tmp`);
try {
  writeFileSync(
    temporary,
    JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid }),
    { flag: "wx", mode: 0o600 },
  );
  renameSync(temporary, target);
} catch (error) {
  descendant.kill("SIGKILL");
  throw error;
} finally {
  rmSync(temporary, { force: true });
}
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
