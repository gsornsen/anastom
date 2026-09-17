import { execFile } from "node:child_process";
import { cp, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const source = fileURLToPath(
  new URL("../examples/demo-repos/parallel-normalizers/", import.meta.url),
);
const repository = await realpath(await mkdtemp(join(tmpdir(), "anastom-parallel-normalizers-")));

await cp(source, repository, { recursive: true });
await executeFile("git", ["init", "-q", "--initial-branch=main"], { cwd: repository });
await executeFile("git", ["config", "user.name", "Anastom Fixture"], { cwd: repository });
await executeFile("git", ["config", "user.email", "fixture@example.invalid"], {
  cwd: repository,
});
await executeFile("git", ["add", "."], { cwd: repository });
await executeFile(
  "git",
  ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "fixture"],
  { cwd: repository },
);

process.stdout.write(repository + "\n");
