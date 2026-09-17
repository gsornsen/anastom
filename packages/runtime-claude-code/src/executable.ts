import { createReadStream, constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RuntimePreflightError } from "@anastom/runtime-contract";

/** Anthropic's signed 2.1.268 native release manifest, verified with its published GPG key. */
export const CLAUDE_CODE_VERSION = "2.1.268";
const NATIVE_SHA256: Readonly<Record<string, readonly string[]>> = {
  "darwin-arm64": ["06a96d5423f83770f120859f1c58e60d7252cc4c122aa13043b7e7cd716bc76a"],
  "darwin-x64": ["f94c0d5ab0ab79f28e8dc9129ae7c980c2c1af65f3ea67ee6e9256bed3da67e9"],
  "linux-arm64": [
    "116fd031f939ef1e09edf170d62c489e1cc28ed6bfbda49f948773ba168c8f62",
    "a1cb086b8b65ff5e2068eb764d2aff7c8a48f914df4741dd9bdb2d3aa5db971b",
  ],
  "linux-x64": [
    "9691a2b7bd796712ca8cffb8e32e54ff7fc45b662540233171a16a94a0425653",
    "1e9b0013268c023266438653eb4beac34d71311a451a9f45988e5f176fdf2e24",
  ],
};

/**
 * Resolve only the operator's official native-installer release path, then attest bytes.
 */
export async function resolveClaudeCodeExecutable(): Promise<string> {
  const hashes = NATIVE_SHA256[`${process.platform}-${process.arch}`];
  if (!hashes) {
    throw new RuntimePreflightError(
      "runtime-unavailable",
      "Claude Code process ownership supports Linux/macOS arm64/x64 only",
    );
  }
  const executable = resolve(
    join(homedir(), ".local", "share", "claude", "versions", CLAUDE_CODE_VERSION),
  );
  try {
    const metadata = await lstat(executable);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (await realpath(executable)) !== executable
    ) {
      throw new Error("Native release path is not an ordinary file");
    }
    await access(executable, constants.X_OK);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(executable)) {
      digest.update(chunk as Buffer);
    }
    if (!hashes.includes(digest.digest("hex"))) {
      throw new Error("Native release checksum does not match the signed manifest");
    }
    return executable;
  } catch {
    throw new RuntimePreflightError(
      "runtime-unavailable",
      `Install the unmodified official Claude Code ${CLAUDE_CODE_VERSION} native release with Anthropic's installer`,
    );
  }
}
