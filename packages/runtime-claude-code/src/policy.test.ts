import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  macProfilesStatusRecognized,
  missingMacManagedDomain,
  noMacProfiles,
  rejectManagedDirectory,
  rejectManagedPreferenceFiles,
} from "./policy.js";

describe("conservative managed-policy absence", () => {
  it("rejects conflicting managed hooks/instructions and unavailable inventory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anastom-claude-managed-"));
    try {
      await expect(rejectManagedDirectory(directory)).resolves.toBeUndefined();
      await writeFile(
        join(directory, "managed-settings.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "PRIVATE_SENTINEL" }] }] },
          permissions: { allow: ["Bash"] },
        }),
      );
      await expect(rejectManagedDirectory(directory)).rejects.toMatchObject({
        category: "policy-violation",
      });
      await expect(
        rejectManagedDirectory(join(directory, "managed-settings.json")),
      ).rejects.toMatchObject({
        category: "policy-violation",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("treats unknown macOS profile/domain evidence as policy unavailable", () => {
    expect(noMacProfiles("There are no configuration profiles installed on this system\n")).toBe(
      true,
    );
    expect(noMacProfiles("Installed configuration profile: com.anthropic.claudecode")).toBe(false);
    expect(noMacProfiles("unexpected OS response")).toBe(false);
    expect(
      macProfilesStatusRecognized("There are 8 configuration profiles installed on this system\n"),
    ).toBe(true);
    expect(macProfilesStatusRecognized("unexpected OS response")).toBe(false);
    expect(missingMacManagedDomain(1, "Domain com.anthropic.claudecode does not exist")).toBe(true);
    expect(missingMacManagedDomain(1, "permission denied")).toBe(false);
    expect(missingMacManagedDomain(2, "Domain com.anthropic.claudecode does not exist")).toBe(
      false,
    );
  });
  it("rejects Claude Code managed-preference files without reading their contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anastom-managed-prefs-"));
    try {
      await expect(rejectManagedPreferenceFiles(directory)).resolves.toBeUndefined();
      await writeFile(join(directory, "com.anthropic.claudecode.plist"), "PRIVATE_SENTINEL");
      await expect(rejectManagedPreferenceFiles(directory)).rejects.toMatchObject({
        category: "policy-violation",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
