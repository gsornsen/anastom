import { isAbsolute, posix } from "node:path";

/** Normalize and validate repository-relative paths before Feature compilation. */
export function normalizeProtectedPaths(paths: readonly string[] | undefined): string[] {
  const normalized = (paths ?? []).map((path) => posix.normalize(path).replace(/^\.\//, ""));
  if (
    normalized.some(
      (path) =>
        !path ||
        path === "." ||
        isAbsolute(path) ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.split("/").includes("..") ||
        path.split("/")[0] === ".git",
    )
  ) {
    throw new TypeError(
      "Protected paths must be normalized repository-relative paths outside .git",
    );
  }
  return [...new Set(normalized)].sort();
}
