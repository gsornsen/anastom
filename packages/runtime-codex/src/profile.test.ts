import { mkdtemp, mkdir, readFile, realpath, stat, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conformanceRequest } from "../../runtime-contract/src/testing/conformance.js";
import {
  createCodexProfile,
  disabledSkillPaths,
  resolveAuthFile,
  resolveCodexExecutable,
  validateSelection,
} from "./profile.js";

const retained: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of retained.splice(0)) {
    await dispose();
  }
});

describe("bounded Codex execution profile", () => {
  it("resolves only the exact project-installed executable", async () => {
    expect(await resolveCodexExecutable()).toMatch(/@openai\+codex@0\.154\.0/);
  });
  it("requires normal file-backed auth without reading or copying its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "anastom-codex-auth-"));
    retained.push(async () => {
      await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
    });
    await expect(resolveAuthFile(root)).rejects.toMatchObject({ category: "policy-violation" });
    const auth = join(root, "auth.json");
    await writeFile(auth, "PRIVATE_SENTINEL", { mode: 0o600 });
    expect(await resolveAuthFile(root)).toBe(await realpath(auth));
    validateSelection("openai", "gpt-5.6-terra", "medium");
    expect(() => validateSelection("other", "gpt-5.6-terra")).toThrow();
  });
  it("creates fresh discovery roots, linked original auth and owned schema/catalog without ambient files", async () => {
    const root = await mkdtemp(join(tmpdir(), "anastom-codex-profile-"));
    retained.push(async () => {
      await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
    });
    const auth = join(root, "auth.json");
    await writeFile(auth, "PRIVATE_SENTINEL", { mode: 0o600 });
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const profile = await createCodexProfile({
      request: conformanceRequest(workspace),
      authFile: auth,
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    retained.push(profile.dispose);
    expect(await realpath(join(profile.env.CODEX_HOME!, "auth.json"))).toBe(await realpath(auth));
    const refresh = await open(join(profile.env.CODEX_HOME!, "auth.json"), "w");
    await refresh.writeFile("SYNTHETIC_REFRESH");
    await refresh.close();
    expect(await readFile(auth, "utf8")).toBe("SYNTHETIC_REFRESH");
    expect(profile.env.HOME).not.toBe(process.env.HOME);
    expect(profile.args).toContain("--ephemeral");
    expect(profile.args).toContain("--ignore-user-config");
    expect(profile.args).toContain("--ignore-rules");
    expect(profile.args.join(" ")).toContain('model_reasoning_effort="medium"');
    expect(profile.args.join(" ")).not.toContain("PRIVATE_SENTINEL");
    expect(profile.prompt).not.toContain("PRIVATE_SENTINEL");
    expect(await stat(join(profile.root, "output-schema.json"))).toBeDefined();
    const catalog = JSON.parse(
      await readFile(join(profile.root, "model-catalog.json"), "utf8"),
    ) as { models: Array<{ context_window: unknown; slug: string }> };
    expect(catalog.models).toMatchObject([{ slug: "gpt-5.6-terra", context_window: null }]);
  });
  it("inventories canonical skill selectors without reading their bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "anastom-codex-skills-"));
    retained.push(async () => {
      await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
    });
    const skill = join(root, ".agents", "skills", "fixture");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "PRIVATE_SENTINEL");
    const selectors = await disabledSkillPaths(root);
    expect(selectors).toContain(await realpath(join(skill, "SKILL.md")));
    expect(JSON.stringify(selectors)).not.toContain("PRIVATE_SENTINEL");
  });
});
