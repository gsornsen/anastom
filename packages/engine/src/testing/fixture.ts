import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const exec = promisify(execFile);
export const endpointFixtureDirectory = resolve("examples/demo-repos/health-endpoint");
export const healthEndpointTaskPath = resolve(endpointFixtureDirectory, "tasks/add-endpoint.md");
export async function createEndpointRepository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "anastom-endpoint-test-")));
  await cp(endpointFixtureDirectory, root, { recursive: true });
  await exec("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
  await exec("git", ["config", "user.name", "Anastom Fixture"], { cwd: root });
  await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}
export async function removeEndpointRepository(root: string): Promise<void> {
  if (!root.includes("anastom-endpoint-test-")) {
    throw new Error("Refusing unowned test directory");
  }
  await rm(root, { recursive: true, force: true });
}
