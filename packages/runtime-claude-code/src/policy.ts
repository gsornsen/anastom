import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { RuntimePreflightError } from "@anastom/runtime-contract";

const execFileAsync = promisify(execFile);
const MAC_MANAGED_DIRECTORY = "/Library/Application Support/ClaudeCode";
const MAC_MANAGED_PREFERENCES = "/Library/Managed Preferences";
const LINUX_MANAGED_DIRECTORY = "/etc/claude-code";

function unavailable(): RuntimePreflightError {
  return new RuntimePreflightError(
    "policy-violation",
    "Claude Code managed-policy absence could not be established for this device",
  );
}

/**
 * Reject every endpoint-managed artifact, including hooks and organization-wide CLAUDE.md.
 * @internal
 */
export async function rejectManagedDirectory(directory: string): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw unavailable();
    }
    if ((await readdir(directory)).length) {
      throw new RuntimePreflightError(
        "policy-violation",
        "Claude Code endpoint-managed files are incompatible with this worker profile",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    if (error instanceof RuntimePreflightError) {
      throw error;
    }
    throw unavailable();
  }
}

/**
 * Inventory the macOS preference-file source by domain name without reading values.
 * @internal
 */
export async function rejectManagedPreferenceFiles(directory: string): Promise<void> {
  const pending = [{ path: directory, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const item = pending.pop()!;
    let names: string[];
    try {
      names = await readdir(item.path);
    } catch (error) {
      if (item.depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw unavailable();
    }
    for (const name of names) {
      if (++entries > 4096) {
        throw unavailable();
      }
      const path = `${item.path}/${name}`;
      let metadata;
      try {
        metadata = await lstat(path);
      } catch {
        throw unavailable();
      }
      if (metadata.isSymbolicLink()) {
        throw unavailable();
      }
      if (name.toLowerCase().includes("com.anthropic.claudecode")) {
        throw new RuntimePreflightError(
          "policy-violation",
          "Claude Code managed preference files are incompatible with this worker profile",
        );
      }
      if (metadata.isDirectory()) {
        if (item.depth >= 2) {
          throw unavailable();
        }
        pending.push({ path, depth: item.depth + 1 });
      }
    }
  }
}

/**
 * A conservative model-free gate. On macOS, reject the effective Claude Code preference
 * domain, any matching managed-preference file, and managed system files; unrelated OS
 * profiles are allowed only when all relevant inspection sources are available. On Linux,
 * reject managed system files. Remote policy is excluded only by the separately verified
 * personal-plan or bare API-key authentication selection.
 */
export async function inspectClaudeManagedPolicy(): Promise<void> {
  if (process.platform === "linux") {
    await rejectManagedDirectory(LINUX_MANAGED_DIRECTORY);
    return;
  }
  if (process.platform !== "darwin") {
    throw unavailable();
  }
  await rejectManagedDirectory(MAC_MANAGED_DIRECTORY);
  await rejectManagedPreferenceFiles(MAC_MANAGED_PREFERENCES);
  try {
    const profiles = await execFileAsync(
      "/usr/bin/profiles",
      ["status", "-type", "configuration"],
      {
        timeout: 2_000,
        maxBuffer: 8_192,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      },
    );
    if (!macProfilesStatusRecognized(profiles.stdout)) {
      throw unavailable();
    }
    try {
      await execFileAsync("/usr/bin/defaults", ["read", "com.anthropic.claudecode"], {
        timeout: 2_000,
        maxBuffer: 8_192,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
      throw new RuntimePreflightError(
        "policy-violation",
        "Claude Code managed preferences are incompatible with this worker profile",
      );
    } catch (error) {
      if (error instanceof RuntimePreflightError) {
        throw error;
      }
      const exit = error as Error & { code?: string | number; stderr?: string };
      if (!missingMacManagedDomain(exit.code, exit.stderr)) {
        throw unavailable();
      }
    }
  } catch (error) {
    if (error instanceof RuntimePreflightError) {
      throw error;
    }
    throw unavailable();
  }
}

/**
 * Recognize only the OS tool's affirmative no-profile result; unknown output fails closed.
 * @internal
 */
export function noMacProfiles(output: string): boolean {
  return output.trim() === "There are no configuration profiles installed on this system";
}

/**
 * A generic OS inventory count is accepted; Claude-specific preference sources remain gated.
 * @internal
 */
export function macProfilesStatusRecognized(output: string): boolean {
  return /^There are (?:no|[0-9]+) configuration profiles installed on this system$/.test(
    output.trim(),
  );
}

/**
 * Recognize only absence of the Claude Code preference domain.
 * @internal
 */
export function missingMacManagedDomain(
  code: string | number | undefined,
  stderr?: string,
): boolean {
  return code === 1 && !!stderr?.includes("Domain com.anthropic.claudecode does not exist");
}
