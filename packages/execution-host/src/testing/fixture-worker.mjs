import { spawn } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const [scenario, owner] = process.argv.slice(2);
if (
  !scenario ||
  !owner ||
  !["success", "hold", "pressure", "unresponsive-cancel"].includes(scenario)
) {
  throw new Error("Fixture worker requires an owner and supported scenario");
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

await writeFile(join(process.cwd(), "side-effect.json"), JSON.stringify({ owner, scenario }), {
  flag: "wx",
  mode: 0o600,
});

if (scenario === "success" || scenario === "pressure") {
  await writeJsonAtomic(join(process.cwd(), "processes.json"), {
    leader: process.pid,
    descendant: null,
  });
  process.stdout.write(JSON.stringify({ descendant: null }) + "\n");
} else {
  const descendant = spawn(
    process.execPath,
    [fileURLToPath(new URL("fixture-descendant.mjs", import.meta.url))],
    {
      stdio: "ignore",
    },
  );
  if (descendant.pid === undefined) {
    throw new Error("Fixture descendant did not expose a process identifier");
  }
  await writeJsonAtomic(join(process.cwd(), "processes.json"), {
    leader: process.pid,
    descendant: descendant.pid,
  });
  process.stdout.write(JSON.stringify({ descendant: descendant.pid }) + "\n");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
