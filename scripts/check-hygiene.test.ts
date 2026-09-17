import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHygiene } from "./check-hygiene.js";

const repositories: string[] = [];
afterEach(async () => {
  for (const root of repositories.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "anastom-hygiene-"));
  repositories.push(root);
  await mkdir(join(root, "packages", "sample"), { recursive: true });
  await mkdir(join(root, ".changeset"));
  await writeFile(
    join(root, "packages/sample/package.json"),
    JSON.stringify({
      name: "@anastom/sample",
      version: "0.0.0",
      private: true,
      license: "AGPL-3.0-only",
    }),
  );
  for (const name of ["README.md", "CHANGELOG.md"]) {
    await writeFile(
      join(root, "packages/sample", name),
      "# Sample package\n\nA documented package describing its public API, invariants, development commands, and unreleased changes.\n",
    );
  }
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Anastom Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["add", "."]);
  git(["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
  await writeFile(join(root, "packages/sample/index.ts"), "export const feature = true;\n");
  return root;
}

async function addPlan(root: string, content = '"@anastom/sample": minor') {
  await writeFile(
    join(root, ".changeset", "new-feature.md"),
    `---\n${content}\n---\n\nAdd the documented feature.\n`,
  );
}

describe("Contributor hygiene gate", () => {
  it("accepts reviewed version increments only with a package changelog change", async () => {
    const root = await repositoryFixture();
    await writeFile(
      join(root, "packages/sample/package.json"),
      JSON.stringify({
        name: "@anastom/sample",
        version: "0.1.0",
        private: true,
        license: "AGPL-3.0-only",
      }),
    );
    expect(() => checkHygiene(root, "main")).toThrow("add a new Changeset");
    await writeFile(
      join(root, "packages/sample/CHANGELOG.md"),
      "# Sample changelog\n\n## 0.1.0\n\nAdd a documented, reviewed initial feature release with compatible public behavior.\n",
    );
    expect(() => checkHygiene(root, "main")).not.toThrow();
    await writeFile(
      join(root, "packages/sample/package.json"),
      JSON.stringify({
        name: "@anastom/sample",
        version: "0.0.0+metadata",
        private: true,
        license: "AGPL-3.0-only",
      }),
    );
    expect(() => checkHygiene(root, "main")).toThrow("add a new Changeset");
  });
  it("accepts an empty Changeset for documentation-only work", async () => {
    const root = await repositoryFixture();
    await rm(join(root, "packages/sample/index.ts"));
    await writeFile(
      join(root, ".changeset", "documentation.md"),
      "---\n---\n\nClarify contributor documentation.\n",
    );
    expect(() => checkHygiene(root, "main")).not.toThrow();
  });

  it("rejects changed package code without a release plan and accepts a valid plan", async () => {
    const root = await repositoryFixture();
    expect(() => checkHygiene(root, "main")).toThrow("add a new Changeset");
    await addPlan(root);
    expect(() => checkHygiene(root, "main")).not.toThrow();
  });

  it.each(['"@anastom/sample": huge', '"@anastom/unknown": minor'])(
    "rejects an invalid release plan: %s",
    async (content) => {
      const root = await repositoryFixture();
      await addPlan(root, content);
      expect(() => checkHygiene(root, "main")).toThrow("Invalid package or SemVer change");
    },
  );

  it("requires package documentation and canonical SemVer metadata", async () => {
    const root = await repositoryFixture();
    await addPlan(root);
    await rm(join(root, "packages/sample/README.md"));
    expect(() => checkHygiene(root, "main")).toThrow("README.md");
    await writeFile(
      join(root, "packages/sample/README.md"),
      "Useful package documentation. ".repeat(5),
    );
    await writeFile(
      join(root, "packages/sample/package.json"),
      JSON.stringify({
        name: "@anastom/sample",
        version: "01.0.0",
        license: "AGPL-3.0-only",
        private: true,
      }),
    );
    expect(() => checkHygiene(root, "main")).toThrow("SemVer");
  });

  it("rejects planning labels in package source and test names", async () => {
    const root = await repositoryFixture();
    await addPlan(root);
    await mkdir(join(root, "packages/sample/src"));
    const testPath = join(root, "packages/sample/src/m3-recovery.test.ts");
    await writeFile(testPath, 'describe("M3 recovery", () => {});\n');
    expect(() => checkHygiene(root, "main")).toThrow("durable capability name");
    await rm(testPath);
    const sourcePath = join(root, "packages/sample/src/recovery.test.ts");
    await writeFile(sourcePath, '// M3 recovery behavior\ndescribe("recovery", () => {});\n');
    expect(() => checkHygiene(root, "main")).toThrow("describe the durable behavior");
    await writeFile(sourcePath, 'describe("durable crash recovery", () => {});\n');
    const fixturePath = join(root, "packages/sample/src/recovery.fixture.json");
    await writeFile(fixturePath, '{"phase":"M3"}\n');
    expect(() => checkHygiene(root, "main")).toThrow("describe the durable behavior");
    await writeFile(fixturePath, '{"phase":"durable-recovery"}\n');
    expect(() => checkHygiene(root, "main")).not.toThrow();
  });

  it("fails clearly when the selected comparison base is unavailable", async () => {
    const root = await repositoryFixture();
    await addPlan(root);
    expect(() => checkHygiene(root, "missing-base")).toThrow();
  });
});
