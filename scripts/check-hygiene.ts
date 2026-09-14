import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { valid, gt } from "semver";
import { parse } from "yaml";

interface PackageMetadata {
  name: string;
  version: string;
  license: string;
  private: boolean;
}

function isCanonicalVersion(value: unknown): value is string {
  return (
    typeof value === "string" && /^[0-9]/.test(value) && !/\s/.test(value) && valid(value) !== null
  );
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function changedFiles(root: string, base: string): string[] {
  const committed = git(root, ["diff", "--name-only", `${base}...HEAD`]);
  const working = git(root, ["diff", "--name-only", "HEAD"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  return [...new Set((committed + working + untracked).split("\n").filter(Boolean))];
}

function releasePlans(root: string, files: string[], names: Set<string>): Set<string> {
  const covered = new Set<string>();
  for (const file of files.filter((path) => /^\.changeset\/[^/]+\.md$/.test(path))) {
    if (!existsSync(join(root, file)) || file === ".changeset/README.md") {
      continue;
    }
    const text = readFileSync(join(root, file), "utf8");
    const lines = text.split(/\r?\n/);
    const closing = lines.indexOf("---", 1);
    if (lines[0] !== "---" || closing < 1) {
      throw new Error(`Invalid Changesets front matter: ${file}`);
    }
    if (
      !lines
        .slice(closing + 1)
        .join("\n")
        .trim()
    ) {
      throw new Error(`Release plan needs a useful summary: ${file}`);
    }
    const header: unknown = parse(lines.slice(1, closing).join("\n")) ?? {};
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      throw new Error(`Invalid Changesets front matter: ${file}`);
    }
    for (const [name, level] of Object.entries(header)) {
      if (!names.has(name) || !["major", "minor", "patch"].includes(String(level))) {
        throw new Error(`Invalid package or SemVer change in ${file}: ${name}`);
      }
      covered.add(name);
    }
  }
  return covered;
}

/** Validate package documentation, SemVer metadata, and release plans for changed package code. */
export function checkHygiene(root: string, base: string): void {
  const packages = new Map<string, PackageMetadata>();
  for (const directory of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!directory.isDirectory()) {
      continue;
    }
    const path = join(root, "packages", directory.name);
    const metadata = JSON.parse(
      readFileSync(join(path, "package.json"), "utf8"),
    ) as PackageMetadata;
    if (
      metadata.name !== `@anastom/${directory.name}` ||
      !isCanonicalVersion(metadata.version) ||
      metadata.license !== "AGPL-3.0-only" ||
      metadata.private !== true
    ) {
      throw new Error(
        `Invalid package identity, SemVer, license, or private status: ${directory.name}`,
      );
    }
    for (const document of ["README.md", "CHANGELOG.md"]) {
      if (
        !existsSync(join(path, document)) ||
        readFileSync(join(path, document), "utf8").trim().length < 80
      ) {
        throw new Error(`Package ${metadata.name} needs a useful ${document}`);
      }
    }
    packages.set(directory.name, metadata);
  }
  const files = changedFiles(root, base);
  const covered = releasePlans(root, files, new Set([...packages.values()].map((pkg) => pkg.name)));
  for (const [directory, metadata] of packages) {
    const prefix = `packages/${directory}/`;
    const changed = files.some(
      (file) =>
        file.startsWith(prefix) &&
        !/\.(md)$/.test(file) &&
        !file.endsWith(".test.ts") &&
        !file.includes("/testing/"),
    );
    const versionChanged = isVersioningChange({
      root,
      base,
      prefix,
      files,
      version: metadata.version,
    });
    if (changed && !covered.has(metadata.name) && !versionChanged) {
      throw new Error(
        `${metadata.name} changed: add a new Changeset with a reviewed major/minor/patch plan`,
      );
    }
  }
}

function isVersioningChange(options: {
  root: string;
  base: string;
  prefix: string;
  files: string[];
  version: string;
}): boolean {
  const { root, base, prefix, files, version } = options;
  if (!files.includes(prefix + "package.json") || !files.includes(prefix + "CHANGELOG.md")) {
    return false;
  }
  try {
    const previous = JSON.parse(
      git(root, ["show", `${base}:${prefix}package.json`]),
    ) as PackageMetadata;
    return gt(version, previous.version);
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.env.ANASTOM_HYGIENE_BASE ?? "origin/main";
  try {
    checkHygiene(process.cwd(), base);
    console.log("Package documentation, SemVer, and release plans are valid.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
