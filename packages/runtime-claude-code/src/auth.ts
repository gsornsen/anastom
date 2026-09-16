import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { promisify } from "node:util";
import { RuntimePreflightError } from "@anastom/runtime-contract";

const execFileAsync = promisify(execFile);

/** Authentication is selected by the operator, never inferred from CLI defaults. */
export type ClaudeAuthSource = "subscription" | "api-key";

const conflictingEnvironment = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CONFIG_DIR",
] as const;

/** Allowlist only provider-independent process settings; native CLI owns its auth store. */
export function claudeProcessEnvironment(source: ClaudeAuthSource): NodeJS.ProcessEnv {
  for (const name of conflictingEnvironment) {
    if (process.env[name] !== undefined) {
      throw new RuntimePreflightError(
        "policy-violation",
        `Claude Code requires first-party default configuration; unset ${name}`,
      );
    }
  }
  if (source === "subscription" && process.env.ANTHROPIC_API_KEY !== undefined) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Subscription selection rejects an ambient ANTHROPIC_API_KEY to prevent silent API billing",
    );
  }
  if (source === "api-key" && !process.env.ANTHROPIC_API_KEY) {
    throw new RuntimePreflightError(
      "policy-violation",
      "API-key selection requires the operator's ANTHROPIC_API_KEY environment variable",
    );
  }
  return {
    HOME: homedir(),
    USER: userInfo().username,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TMPDIR: process.env.TMPDIR,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    ...(source === "api-key" ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
  };
}

/** Read only four source-identifying booleans/strings; discard private status metadata. */
export async function inspectClaudeAuthentication(
  executable: string,
  source: ClaudeAuthSource,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (source === "api-key") {
    // Anthropic's --bare mode explicitly excludes OAuth/keychain login.
    return;
  }
  try {
    const { stdout } = await execFileAsync(executable, ["auth", "status", "--json"], {
      cwd: homedir(),
      env: environment,
      timeout: 5_000,
      maxBuffer: 16_384,
    });
    const status = JSON.parse(stdout) as Record<string, unknown>;
    if (
      status.loggedIn !== true ||
      status.authMethod !== "claude.ai" ||
      status.apiProvider !== "firstParty" ||
      !["pro", "max"].includes(String(status.subscriptionType))
    ) {
      throw new RuntimePreflightError(
        "policy-violation",
        "Claude Code requires an end-user Claude.ai Pro/Max subscription login for this selection",
      );
    }
  } catch (error) {
    if (error instanceof RuntimePreflightError) {
      throw error;
    }
    throw new RuntimePreflightError(
      "policy-violation",
      "Claude Code subscription status could not be established without a model call",
    );
  }
}
