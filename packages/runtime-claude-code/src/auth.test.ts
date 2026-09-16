import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeProcessEnvironment, inspectClaudeAuthentication } from "./auth.js";
import { syntheticClaudeCode } from "./testing/fixture.js";

afterEach(() => vi.unstubAllEnvs());

describe("explicit Claude Code billing-source preflight", () => {
  it("rejects an ambient API key before subscription use and never reports its value", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "PRIVATE_SENTINEL");
    expect(() => claudeProcessEnvironment("subscription")).toThrow(/ambient ANTHROPIC_API_KEY/);
    try {
      claudeProcessEnvironment("subscription");
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_SENTINEL");
    }
  });
  it("requires a user-supplied key in API mode and excludes third-party provider routing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    expect(() => claudeProcessEnvironment("api-key")).toThrow(/requires/);
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-no-network");
    expect(claudeProcessEnvironment("api-key").ANTHROPIC_API_KEY).toBe("synthetic-no-network");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    expect(() => claudeProcessEnvironment("api-key")).toThrow(/CLAUDE_CODE_USE_BEDROCK/);
  });
  it("accepts only a first-party personal subscription login while discarding identity metadata", async () => {
    const good = await syntheticClaudeCode("success");
    const wrong = await syntheticClaudeCode("auth-wrong");
    try {
      const env = { PATH: process.env.PATH };
      await expect(
        inspectClaudeAuthentication(good.executable, "subscription", env),
      ).resolves.toBeUndefined();
      await expect(
        inspectClaudeAuthentication(wrong.executable, "subscription", env),
      ).rejects.toMatchObject({
        category: "policy-violation",
      });
      expect(good.started()).toBe(0);
      expect(wrong.started()).toBe(0);
      await expect(
        inspectClaudeAuthentication(wrong.executable, "api-key", env),
      ).resolves.toBeUndefined();
    } finally {
      await good.dispose();
      await wrong.dispose();
    }
  });
});
