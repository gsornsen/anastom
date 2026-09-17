import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** The trust boundary required before interpreting a caller's child path. */
export class PathPolicyError extends Error {
  /** Distinguish root escape from malformed input or unexpected file type. */
  constructor(
    readonly reason: "outside-root" | "invalid" | "wrong-type",
    message: string,
  ) {
    super(message);
    this.name = "PathPolicyError";
  }
}

/** Canonicalize a caller-selected trusted directory before checking children. */
export async function canonicalExistingRoot(path: string): Promise<string> {
  const root = await realpath(resolve(path));
  if (!(await stat(root)).isDirectory()) {
    throw new PathPolicyError("wrong-type", "Trusted path root must be an existing directory");
  }
  return root;
}

/**
 * Resolve one existing child of a canonical trusted root. An internal symlink is allowed;
 * lexical traversal and a symlink target outside the root are rejected. Callers still own
 * their input grammar, creation policy, and authorization of the trusted root itself.
 */
export async function resolveExistingChild(
  root: string,
  input: string,
  expectedType: "file" | "directory",
): Promise<string> {
  if (!input || input.includes("\0")) {
    throw new PathPolicyError("invalid", "Child path is empty or contains a null byte");
  }
  const lexical = resolve(root, input);
  if (lexical === root) {
    if (expectedType !== "directory") {
      throw new PathPolicyError("wrong-type", "Child is not an existing file");
    }
    return root;
  }
  const boundary = root.endsWith(sep) ? root : root + sep;
  if (!lexical.startsWith(boundary)) {
    throw new PathPolicyError("outside-root", "Child path escapes its trusted root");
  }
  const canonical = await realpath(lexical);
  if (canonical !== root && !canonical.startsWith(boundary)) {
    throw new PathPolicyError("outside-root", "Child symlink target escapes its trusted root");
  }
  const metadata = await stat(canonical);
  if (
    (expectedType === "file" && !metadata.isFile()) ||
    (expectedType === "directory" && !metadata.isDirectory())
  ) {
    throw new PathPolicyError("wrong-type", `Child path must be an existing ${expectedType}`);
  }
  return canonical;
}

export { ensurePrivatePathRoot, type PrivatePathRoot } from "./private-path-root.js";

/**
 * Public classified failure for private-state ownership and bounded-I/O violations.
 * @public
 */
export { PrivatePathError } from "./private-path-root.js";
