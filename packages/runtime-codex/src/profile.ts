import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalJson } from "@anastom/core";
import { RuntimePreflightError } from "@anastom/runtime-contract";
import type { ExecutionRequest } from "@anastom/runtime-contract";

/** Exact Codex CLI package and native executable release accepted for this adapter profile. */
export const CODEX_VERSION = "0.154.0";
export const WORKER_INSTRUCTIONS =
  "You are a bounded software implementer. Follow only the explicit context envelope, operate in its assigned workspace, respect its mutation policy, and return the required JSON report. The control plane owns authoritative verification.";
const require = createRequire(import.meta.url);
const disabledFeatures = [
  "hooks",
  "plugin_hooks",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "apps",
  "enable_mcp_apps",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "skill_search",
  "tool_search",
  "tool_suggest",
  "skill_mcp_dependency_install",
  "shell_snapshot",
  "browser_use",
  "computer_use",
  "image_generation",
  "workspace_dependencies",
  "unbounded_connection_retries",
  "view_image",
  "token_budget",
  "context_management",
  "remote_compaction_v2",
];

/** Supported explicit Codex reasoning levels; delegation modes remain outside this worker slice. */
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Adapter-owned ephemeral files and discovery roots; cleanup unlinks auth without touching its target. */
export interface CodexProfile {
  root: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  prompt: string;
  dispose: () => Promise<void>;
}

/** Check explicit selection without consulting model defaults or provider credentials. */
export function validateSelection(
  provider: string,
  model: string,
  effort?: CodexReasoningEffort,
): void {
  if (provider !== "openai") {
    throw new RuntimePreflightError(
      "policy-violation",
      "Codex supports explicit --provider openai only",
    );
  }
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(model) ||
    (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort))
  ) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Codex requires an explicit supported model identifier and reasoning effort",
    );
  }
}

/** Resolve and validate the exact project-installed native package; never search the global PATH. */
export async function resolveCodexExecutable(): Promise<string> {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
    throw new RuntimePreflightError(
      "runtime-unavailable",
      "Codex worker process ownership supports Linux/macOS on arm64/x64 only",
    );
  }
  try {
    const packageFile = require.resolve("@openai/codex/package.json");
    const metadata = JSON.parse(await readFile(packageFile, "utf8")) as {
      name: unknown;
      version: unknown;
    };
    if (metadata.name !== "@openai/codex" || metadata.version !== CODEX_VERSION) {
      throw new Error("Unsupported executable package");
    }
    const nativeFile = require.resolve(
      `@openai/codex-${process.platform}-${process.arch}/package.json`,
      { paths: [dirname(packageFile)] },
    );
    const projectNative = resolve(
      dirname(packageFile),
      "..",
      `codex-${process.platform}-${process.arch}`,
      "package.json",
    );
    if ((await realpath(nativeFile)) !== (await realpath(projectNative))) {
      throw new Error("Native executable does not belong to the project install");
    }
    const native = JSON.parse(await readFile(nativeFile, "utf8")) as { version: unknown };
    if (native.version !== CODEX_VERSION + "-" + process.platform + "-" + process.arch) {
      throw new Error("Unsupported native package");
    }
    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    const target = process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
    const executable = join(
      dirname(nativeFile),
      "vendor",
      architecture + "-" + target,
      "bin",
      "codex",
    );
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    throw new RuntimePreflightError(
      "runtime-unavailable",
      "Install the project-pinned @openai/codex@0.154.0 executable and its matching platform package",
    );
  }
}

/** Locate normal file-backed authentication using metadata only; never read or convert credentials. */
export async function resolveAuthFile(authDirectory?: string): Promise<string> {
  const root = resolve(authDirectory === undefined ? homedir() : tmpdir());
  const configuredDirectory = resolve(
    authDirectory ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  );
  try {
    if (configuredDirectory !== root && !configuredDirectory.startsWith(root + sep)) {
      throw new Error("Authentication directory is outside its supported root");
    }
    const canonicalRoot = await realpath(root);
    const directory = await realpath(configuredDirectory);
    if (directory !== canonicalRoot && !directory.startsWith(canonicalRoot + sep)) {
      throw new Error("Authentication directory escapes its supported root");
    }
    const file = join(directory, "auth.json");
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
      throw new Error("Unsupported store");
    }
    if ((await realpath(file)) !== file) {
      throw new Error("Authentication file escapes its configured directory");
    }
    await access(file, constants.R_OK | constants.W_OK);
    return file;
  } catch {
    throw new RuntimePreflightError(
      "policy-violation",
      "Codex requires its normal file-backed auth.json; keyring-only and missing authentication are unsupported by this profile. Authenticate in your own terminal without sharing credentials",
    );
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function scanRoot(options: {
  path: string;
  paths: Set<string>;
  visited: Set<string>;
  budget: { entries: number; bytes: number };
  depth: number;
}): Promise<void> {
  if (options.depth > 64) {
    throw new Error("Discovery scan depth exceeded");
  }
  let canonical: string;
  try {
    canonical = await realpath(options.path);
  } catch (error) {
    if (missing(error) && options.depth === 0) {
      return;
    }
    throw error;
  }
  if (options.visited.has(canonical)) {
    return;
  }
  options.visited.add(canonical);
  const entries = await readdir(canonical, { withFileTypes: true });
  for (const entry of entries) {
    options.budget.entries++;
    if (options.budget.entries > 4096) {
      throw new Error("Discovery inventory exceeded");
    }
    const path = join(canonical, entry.name);
    const metadata = await lstat(path);
    if (metadata.isDirectory() || metadata.isSymbolicLink()) {
      const target = await realpath(path);
      if ((await lstat(target)).isDirectory()) {
        await scanRoot({ ...options, path: target, depth: options.depth + 1 });
        continue;
      }
    }
    if (entry.name === "SKILL.md") {
      const target = await realpath(path);
      options.paths.add(target);
      options.budget.bytes += Buffer.byteLength(target);
      if (options.paths.size > 512 || options.budget.bytes > 65_536) {
        throw new Error("Discovery selector inventory exceeded");
      }
    }
  }
}

/** Inventory canonical skill selectors without reading bodies; incomplete or oversized scans fail closed. */
export async function disabledSkillPaths(workspace: string): Promise<string[]> {
  const paths = new Set<string>();
  const visited = new Set<string>();
  const budget = { entries: 0, bytes: 0 };
  try {
    let ancestor = await realpath(workspace);
    let ancestors = 0;
    for (;;) {
      if (++ancestors > 64) {
        throw new Error("Ancestor inventory exceeded");
      }
      for (const namespace of [".agents", ".codex"]) {
        await scanRoot({
          path: join(ancestor, namespace, "skills"),
          paths,
          visited,
          budget,
          depth: 0,
        });
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
    await scanRoot({ path: "/etc/codex/skills", paths, visited, budget, depth: 0 });
    return [...paths].sort();
  } catch {
    throw new RuntimePreflightError(
      "policy-violation",
      "Codex skill discovery inventory is incomplete or exceeds the bounded profile; remove or isolate unsupported discovery roots",
    );
  }
}

/** Render only canonical explicit context and the independent-verification boundary on stdin. */
export function renderCodexPrompt(request: ExecutionRequest): string {
  return (
    "Perform the bounded task in this immutable context envelope. Return ONLY the required JSON report.\n\n" +
    canonicalJson(request.context)
  );
}

function boundedCatalog(model: string): object {
  return {
    models: [
      {
        slug: model,
        display_name: "Configured model",
        description: null,
        base_instructions: WORKER_INSTRUCTIONS,
        supported_reasoning_levels: [],
        shell_type: "unified_exec",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        support_verbosity: false,
        default_verbosity: null,
        truncation_policy: { mode: "bytes", limit: 10000 },
        experimental_supported_tools: [],
        context_window: null,
        max_context_window: null,
        auto_compact_token_limit: null,
        include_apps_usage_instructions: false,
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
      },
    ],
  };
}

/** Create fresh discovery roots and bounded CLI settings; caller owns disposal after confirmed process cleanup. */
export async function createCodexProfile(options: {
  request: ExecutionRequest;
  authFile: string;
  model: string;
  reasoningEffort?: CodexReasoningEffort;
}): Promise<CodexProfile> {
  const { request, authFile, model } = options;
  if (request.workspace.mode === "memory") {
    throw new Error("Codex requires a filesystem agent request");
  }
  const root = await mkdtemp(join(tmpdir(), "anastom-codex-attempt-"));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const home = join(root, "home"),
      agentHome = join(root, "codex");
    await mkdir(home, { mode: 0o700 });
    await mkdir(agentHome, { mode: 0o700 });
    await symlink(authFile, join(agentHome, "auth.json"));
    const schemaFile = join(root, "output-schema.json"),
      instructionsFile = join(root, "instructions.md"),
      catalogFile = join(root, "model-catalog.json");
    await writeFile(schemaFile, canonicalJson(request.requiredOutputSchema), { mode: 0o600 });
    await writeFile(instructionsFile, WORKER_INSTRUCTIONS, { mode: 0o600 });
    await writeFile(catalogFile, JSON.stringify(boundedCatalog(model)), { mode: 0o600 });
    const config: Record<string, unknown> = {
      approval_policy: "never",
      "analytics.enabled": false,
      cli_auth_credentials_store: "file",
      model_provider: "anastom-openai",
      "model_providers.anastom-openai.name": "OpenAI bounded worker",
      "model_providers.anastom-openai.wire_api": "responses",
      "model_providers.anastom-openai.requires_openai_auth": true,
      "model_providers.anastom-openai.request_max_retries": 0,
      "model_providers.anastom-openai.stream_max_retries": 0,
      "model_providers.anastom-openai.supports_websockets": false,
      model_instructions_file: instructionsFile,
      developer_instructions:
        "Follow the bounded worker envelope. The control plane owns authoritative verification.",
      model_catalog_json: catalogFile,
      project_doc_max_bytes: 0,
      project_doc_fallback_filenames: [],
      "sandbox_workspace_write.network_access": false,
      "shell_environment_policy.inherit": "core",
      "shell_environment_policy.ignore_default_excludes": false,
      "shell_environment_policy.experimental_use_profile": false,
      web_search: "disabled",
      "skills.include_instructions": false,
      "skills.bundled.enabled": false,
    };
    for (const feature of disabledFeatures) {
      config["features." + feature] = false;
    }
    if (options.reasoningEffort) {
      config.model_reasoning_effort = options.reasoningEffort;
    }
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--model",
      model,
      "--sandbox",
      request.workspace.mode === "isolated" ? "workspace-write" : "read-only",
      "--cd",
      request.workspace.path,
      "--output-schema",
      schemaFile,
      "--color",
      "never",
    ];
    for (const [key, value] of Object.entries(config)) {
      args.push("-c", key + "=" + JSON.stringify(value));
    }
    args.push(
      "-c",
      "model_auto_compact_token_limit=9223372036854775807",
      "-c",
      "mcp_servers={}",
      "-c",
      "plugins={}",
    );
    const skills = await disabledSkillPaths(request.workspace.path);
    args.push(
      "-c",
      "skills.config=[" +
        skills.map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(",") +
        "]",
      "-",
    );
    return {
      root,
      args,
      prompt: renderCodexPrompt(request),
      dispose,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: agentHome, TMPDIR: root },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
