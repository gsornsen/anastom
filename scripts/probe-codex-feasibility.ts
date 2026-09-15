import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { workerReportSchema } from "@anastom/core";
import { RuntimePreflightError } from "@anastom/runtime-contract";
import { conformanceRequest } from "../packages/runtime-contract/src/testing/conformance.js";
import { JsonlDecoder } from "../packages/runtime-codex/src/jsonl.js";
import { inspectCodexPolicy } from "../packages/runtime-codex/src/policy.js";
import {
  createCodexProfile,
  resolveCodexExecutable,
  WORKER_INSTRUCTIONS,
} from "../packages/runtime-codex/src/profile.js";

// Explicit offline research command. No real authentication is consulted.
// Pass the exact npm package directory; there is no global executable fallback.
const packageDirectory = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass an installed @openai/codex@0.154.0 package directory");
const metadata = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as {
  name: unknown;
  version: unknown;
};
assert.equal(metadata.name, "@openai/codex");
assert.equal(metadata.version, "0.154.0");
assert.notEqual(process.platform, "win32", "This probe owns POSIX process groups");

const sentinel = "ANASTOM_AMBIENT_SENTINEL";
const managedSentinel = "ANASTOM_MANAGED_SENTINEL";
const report = {
  summary: "Completed the deterministic bounded endpoint fixture successfully.",
  changedFiles: [],
  notes: [],
};
const instructions = "You are a bounded implementer. Follow only the explicit fixture envelope.";
const execute = promisify(execFile);
type Mode = "original" | "isolated";
type Outcome =
  | "success"
  | "missing-usage"
  | "request-error"
  | "context-error"
  | "sse-context-error"
  | "accumulated-context";
interface Observation {
  path: string;
  ambientInherited: boolean;
  managedInherited: boolean;
  boundedInstructions: boolean;
  summaryMinimum: unknown;
  providerCacheWritePresent: boolean;
}
interface NativeResult {
  exit: number | null;
  eventTypes: string[];
  usage: Record<string, unknown> | null;
  timedOut: boolean;
}
interface PolicyResult {
  exit: number | null;
  timedOut: boolean;
  requirementsPresent: boolean;
  managedInstructionPresent: boolean;
  layerTypes: string[];
  nonemptyLayerTypes: string[];
  errors: number;
}
interface PromptInputResult {
  itemCount: number;
  ambientInherited: boolean;
  explicitContextPresent: boolean;
  boundedInstructionsPresent: boolean;
  developerInstructionsPresent: boolean;
  roles: string[];
  itemTypes: string[];
  contentTypes: string[];
  nativeKeys: string[];
}
interface Fixture {
  root: string;
  home: string;
  agentHome: string;
  workspace: string;
  skill: string;
  systemFile: string;
  schemaFile: string;
  catalogFile: string;
}
interface ProbeFlags {
  refresh: boolean;
  adapterDiscovery: boolean;
  managedConflict: boolean;
  managedUnavailable: boolean;
  managedConfig: boolean;
  adapterProfile: boolean;
}
interface ProbeState {
  observations: Observation[];
  refreshCount: number;
  cloudCount: number;
  auxiliaryPaths: string[];
}

function flagsFor(variant: string | undefined): ProbeFlags {
  const refresh = variant === "adapter-refresh";
  const adapterDiscovery = variant === "adapter-discovery";
  const managedConflict = variant === "managed-conflict";
  const managedUnavailable = variant === "managed-unavailable";
  const managedConfig = variant === "managed-config";
  const adapterProfile =
    variant === "adapter-profile" ||
    refresh ||
    adapterDiscovery ||
    managedConflict ||
    managedUnavailable ||
    managedConfig;
  return {
    refresh,
    adapterDiscovery,
    managedConflict,
    managedUnavailable,
    managedConfig,
    adapterProfile,
  };
}

function planFor(flags: ProbeFlags): "plus" | "business" | undefined {
  if (flags.refresh) {
    return "plus";
  }
  if (flags.managedConflict || flags.managedUnavailable || flags.managedConfig) {
    return "business";
  }
  return undefined;
}

function syntheticJwt(plan: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_plan_type: plan,
        chatgpt_user_id: "synthetic-user",
        chatgpt_account_id: "synthetic-account",
      },
    }),
  ).toString("base64url");
  return `${header}.${claims}.${Buffer.from("synthetic-signature").toString("base64url")}`;
}
function syntheticAccessJwt(expirationSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ exp: expirationSeconds })).toString("base64url");
  return `${header}.${claims}.${Buffer.from("synthetic-signature").toString("base64url")}`;
}
const staleAccessToken = syntheticAccessJwt(Math.floor(Date.now() / 1000) - 3600);
const refreshedAccessToken = syntheticAccessJwt(Math.floor(Date.now() / 1000) + 86400);

async function createFixture(
  chatgptPlan?: "plus" | "business",
  staleAuth = false,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "anastom-codex-feasibility-"));
  const home = join(root, "user");
  const agentHome = join(home, ".codex");
  const workspace = join(root, "repository");
  const userSkill = join(home, ".agents", "skills", "ambient-user");
  const projectSkill = join(workspace, ".agents", "skills", "ambient-project");
  const ancestorSkill = join(root, ".agents", "skills", "ambient-ancestor");
  const aliasRoot = join(workspace, ".codex", "skills");
  for (const directory of [agentHome, aliasRoot, userSkill, projectSkill, ancestorSkill]) {
    await mkdir(directory, { recursive: true });
  }
  for (const directory of [userSkill, projectSkill]) {
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ambient-sentinel\ndescription: ${sentinel}\n---\n${sentinel}`,
    );
  }
  await writeFile(
    join(ancestorSkill, "SKILL.md"),
    `---\nname: ambient-ancestor\ndescription: ${sentinel}\n---\n${sentinel}`,
  );
  await symlink(ancestorSkill, join(aliasRoot, "ambient-alias"), "dir");
  await writeFile(join(agentHome, "AGENTS.md"), `${sentinel} global instructions`);
  await writeFile(join(workspace, "AGENTS.md"), `${sentinel} project instructions`);
  await writeFile(
    join(agentHome, "config.toml"),
    `developer_instructions = "${sentinel} config"\n[mcp_servers.ambient]\ncommand = "ambient-sentinel-command"\n[features]\nhooks = true\nplugins = true\n`,
  );
  await writeFile(
    join(workspace, ".codex", "config.toml"),
    `developer_instructions = "${sentinel} project config"\n`,
  );
  await writeFile(
    join(agentHome, "auth.json"),
    JSON.stringify(
      chatgptPlan
        ? {
            auth_mode: "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
              id_token: syntheticJwt(chatgptPlan),
              access_token: staleAuth ? staleAccessToken : refreshedAccessToken,
              refresh_token: "synthetic-stale-refresh",
              account_id: "synthetic-account",
            },
            last_refresh: staleAuth ? "2020-01-01T00:00:00Z" : new Date().toISOString(),
          }
        : { auth_mode: "apikey", OPENAI_API_KEY: "synthetic-offline-fixture" },
    ),
    { mode: 0o600 },
  );
  const systemFile = join(root, "instructions.md");
  const schemaFile = join(root, "report-schema.json");
  await writeFile(systemFile, instructions);
  await writeFile(schemaFile, JSON.stringify(workerReportSchema));
  const catalogFile = join(root, "bounded-model-catalog.json");
  await writeFile(
    catalogFile,
    JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "Configured model",
          description: null,
          base_instructions: instructions,
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
    }),
  );
  return {
    root,
    home,
    agentHome,
    workspace,
    skill: join(projectSkill, "SKILL.md"),
    systemFile,
    schemaFile,
    catalogFile,
  };
}

function responseEvents(outcome: Outcome): Record<string, unknown>[] {
  if (outcome === "sse-context-error") {
    return [
      {
        type: "response.created",
        response: { id: "resp_fixture", status: "in_progress", output: [] },
      },
      {
        type: "response.failed",
        response: {
          id: "resp_fixture",
          status: "failed",
          output: [],
          error: { code: "context_length_exceeded", message: "Synthetic fixture failure" },
        },
      },
    ];
  }
  const content = { type: "output_text", text: JSON.stringify(report), annotations: [] };
  const message =
    outcome === "accumulated-context"
      ? {
          id: "fc_fixture",
          type: "function_call",
          call_id: "call_fixture",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "true", yield_time_ms: 1000, max_output_tokens: 64 }),
          status: "completed",
        }
      : {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [content],
        };
  return [
    {
      type: "response.created",
      response: { id: "resp_fixture", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    ...(outcome === "accumulated-context"
      ? []
      : [
          {
            type: "response.content_part.added",
            item_id: "msg_fixture",
            output_index: 0,
            content_index: 0,
            part: { ...content, text: "" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_fixture",
            output_index: 0,
            content_index: 0,
            delta: content.text,
          },
          {
            type: "response.output_text.done",
            item_id: "msg_fixture",
            output_index: 0,
            content_index: 0,
            text: content.text,
          },
          {
            type: "response.content_part.done",
            item_id: "msg_fixture",
            output_index: 0,
            content_index: 0,
            part: content,
          },
        ]),
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [message],
        ...(outcome === "missing-usage"
          ? {}
          : {
              usage: {
                input_tokens: outcome === "accumulated-context" ? 500000 : 100,
                input_tokens_details: { cached_tokens: 20 },
                output_tokens: 30,
                output_tokens_details: { reasoning_tokens: 10 },
                total_tokens: outcome === "accumulated-context" ? 500030 : 130,
              },
            }),
      },
    },
  ];
}

async function serveFixture(options: {
  request: IncomingMessage;
  response: ServerResponse;
  outcome: Outcome;
  observations: Observation[];
  expectedInstructions: string;
}): Promise<void> {
  const { request, response, outcome, observations, expectedInstructions } = options;
  if (request.method !== "POST") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"data":[]}');
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    assert(bytes <= 1024 * 1024, "Synthetic request exceeds probe limit");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const payload = JSON.parse(body) as {
    instructions?: unknown;
    text?: { format?: { schema?: typeof workerReportSchema } };
  };
  observations.push({
    path: request.url ?? "",
    ambientInherited: body.includes(sentinel),
    managedInherited: body.includes(managedSentinel),
    boundedInstructions: payload.instructions === expectedInstructions,
    summaryMinimum: payload.text?.format?.schema?.properties.summary.minLength,
    providerCacheWritePresent: false,
  });
  if (outcome === "request-error" || outcome === "context-error") {
    response.writeHead(outcome === "request-error" ? 503 : 400, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: outcome === "context-error" ? "context_length_exceeded" : "server_error",
          message: "Synthetic fixture failure",
        },
      }),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of responseEvents(
    outcome === "accumulated-context" && observations.length > 1 ? "success" : outcome,
  )) {
    response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function configFor(options: { fixture: Fixture; baseUrl: string; mode: Mode }): string[] {
  const { fixture, baseUrl, mode } = options;
  const config: Record<string, string | number | boolean | unknown[]> = {
    model_provider: "openai",
    openai_base_url: `${baseUrl}/v1`,
    chatgpt_base_url: baseUrl,
    approval_policy: "never",
    model_instructions_file: fixture.systemFile,
    developer_instructions: "Follow the bounded worker envelope.",
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    model_auto_compact_token_limit: "9223372036854775807",
    "sandbox_workspace_write.network_access": false,
    "shell_environment_policy.inherit": "core",
    "shell_environment_policy.ignore_default_excludes": false,
    "shell_environment_policy.experimental_use_profile": false,
    web_search: "disabled",
    "features.skip_host_skill_discovery": mode === "original",
  };
  for (const feature of [
    "hooks",
    "plugins",
    "remote_plugin",
    "apps",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "skill_search",
    "skill_mcp_dependency_install",
    "shell_snapshot",
    "browser_use",
    "computer_use",
    "image_generation",
    "workspace_dependencies",
    "unbounded_connection_retries",
  ]) {
    config[`features.${feature}`] = false;
  }
  if (mode === "isolated") {
    Object.assign(config, {
      cli_auth_credentials_store: "file",
      model_provider: "anastom-openai",
      "model_providers.anastom-openai.name": "OpenAI bounded fixture",
      "model_providers.anastom-openai.base_url": `${baseUrl}/v1`,
      "model_providers.anastom-openai.wire_api": "responses",
      "model_providers.anastom-openai.requires_openai_auth": true,
      "model_providers.anastom-openai.request_max_retries": 0,
      "model_providers.anastom-openai.stream_max_retries": 0,
      "model_providers.anastom-openai.supports_websockets": false,
      "skills.include_instructions": false,
      "skills.bundled.enabled": false,
      "features.view_image": false,
    });
  }
  const argumentsList = Object.entries(config).flatMap(([key, value]) => [
    "-c",
    `${key}=${key === "model_auto_compact_token_limit" ? String(value) : JSON.stringify(value)}`,
  ]);
  argumentsList.push("-c", "mcp_servers={}", "-c", "plugins={}");
  if (mode === "isolated") {
    argumentsList.push(
      "-c",
      `skills.config=[{path=${JSON.stringify(fixture.skill)},enabled=false}]`,
    );
  }
  return argumentsList;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function runNative(options: {
  fixture: Fixture;
  argumentsList: string[];
  environment: NodeJS.ProcessEnv;
  prompt: string;
  nativeExecutable?: string;
}): Promise<NativeResult> {
  const child = spawn(
    options.nativeExecutable ?? process.execPath,
    [
      ...(options.nativeExecutable ? [] : [join(packageDirectory, "bin", "codex.js")]),
      ...options.argumentsList,
    ],
    {
      cwd: options.fixture.workspace,
      env: options.environment,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let bytes = 0;
  let timedOut = false;
  const stop = (): void => signalGroup(child.pid, "SIGKILL");
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      stop();
      return;
    }
    stdout += chunk.toString("utf8");
  });
  child.stderr.resume();
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, 20_000);
  child.stdin.on("error", () => {});
  child.stdin.end(options.prompt);
  const exit = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  }).finally(() => {
    clearTimeout(timeout);
    stop();
  });
  await new Promise<void>((done) => {
    if (child.stdout.destroyed) {
      done();
    } else {
      child.once("close", () => done());
    }
  });
  assert(bytes <= 1024 * 1024, "Native stdout exceeds probe limit");
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; usage?: Record<string, unknown> });
  return {
    exit,
    timedOut,
    eventTypes: events.map((event) => event.type),
    usage: events.findLast((event) => event.type === "turn.completed")?.usage ?? null,
  };
}

async function inspectPolicy(options: {
  fixture: Fixture;
  argumentsList: string[];
  environment: NodeJS.ProcessEnv;
  nativeExecutable: string;
}): Promise<PolicyResult> {
  const configuration: string[] = [];
  for (let index = 0; index < options.argumentsList.length - 1; index++) {
    if (options.argumentsList[index] === "-c") {
      configuration.push("-c", options.argumentsList[++index]!);
    }
  }
  const child = spawn(
    options.nativeExecutable,
    [...configuration, "app-server", "--stdio", "--strict-config"],
    {
      cwd: options.fixture.workspace,
      env: options.environment,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const decoder = new JsonlDecoder();
  const responses = new Map<number, unknown>();
  let bytes = 0;
  let errors = 0;
  let timedOut = false;
  let requestedPolicy = false;
  const send = (value: object): void => {
    child.stdin.write(JSON.stringify(value) + "\n");
  };
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1_048_576) {
      signalGroup(child.pid, "SIGKILL");
      return;
    }
    try {
      for (const frame of decoder.push(chunk)) {
        const record = frame as { id?: unknown; result?: unknown; error?: unknown };
        if (record.error) {
          errors++;
        }
        if (typeof record.id === "number") {
          responses.set(record.id, record.result ?? null);
        }
      }
    } catch {
      signalGroup(child.pid, "SIGKILL");
    }
    if (responses.has(1) && !requestedPolicy) {
      requestedPolicy = true;
      send({ method: "initialized" });
      send({ id: 2, method: "configRequirements/read" });
      send({
        id: 3,
        method: "config/read",
        params: { includeLayers: true, cwd: options.fixture.workspace },
      });
    }
    if (responses.has(2) && responses.has(3)) {
      signalGroup(child.pid, "SIGKILL");
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  send({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "anastom-feasibility", title: "Anastom feasibility", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    },
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    signalGroup(child.pid, "SIGKILL");
  }, 20_000);
  const exit = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  }).finally(() => {
    clearTimeout(timeout);
    signalGroup(child.pid, "SIGKILL");
  });
  const requirements = responses.get(2) as { requirements?: unknown } | undefined;
  const config = responses.get(3) as
    | {
        layers?: { name?: { type?: unknown }; config?: unknown; disabledReason?: unknown }[];
      }
    | undefined;
  const encoded = JSON.stringify(requirements ?? {});
  return {
    exit,
    timedOut,
    requirementsPresent: Boolean(requirements?.requirements),
    managedInstructionPresent: encoded.includes(managedSentinel),
    layerTypes: Array.isArray(config?.layers)
      ? config.layers.map((layer) => String(layer.name?.type))
      : [],
    nonemptyLayerTypes: Array.isArray(config?.layers)
      ? config.layers
          .filter(
            (layer) =>
              !layer.disabledReason &&
              layer.config &&
              typeof layer.config === "object" &&
              Object.keys(layer.config).length > 0,
          )
          .map((layer) => String(layer.name?.type))
      : [],
    errors,
  };
}

async function inspectPromptInput(options: {
  fixture: Fixture;
  argumentsList: string[];
  environment: NodeJS.ProcessEnv;
  prompt: string;
  nativeExecutable?: string;
}): Promise<PromptInputResult> {
  const configuration: string[] = [];
  for (let index = 0; index < options.argumentsList.length - 1; index++) {
    if (options.argumentsList[index] === "-c") {
      configuration.push("-c", options.argumentsList[++index]!);
    }
  }
  const command = [
    ...(options.nativeExecutable ? [] : [join(packageDirectory, "bin", "codex.js")]),
    "--model",
    "gpt-5.6-terra",
    "--sandbox",
    "workspace-write",
    "--cd",
    options.fixture.workspace,
    ...configuration,
    "debug",
    "prompt-input",
    options.prompt,
  ];
  const child = spawn(options.nativeExecutable ?? process.execPath, command, {
    cwd: options.fixture.workspace,
    env: options.environment,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      signalGroup(child.pid, "SIGKILL");
    } else {
      stdout += chunk.toString("utf8");
    }
  });
  child.stderr.resume();
  const timeout = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 20_000);
  const exit = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  }).finally(() => {
    clearTimeout(timeout);
    signalGroup(child.pid, "SIGKILL");
  });
  assert.equal(exit, 0, "Native prompt-input diagnostic failed");
  assert(bytes <= 1024 * 1024, "Native prompt-input diagnostic exceeded probe limit");
  const parsed = JSON.parse(stdout) as unknown;
  const encoded = JSON.stringify(parsed);
  const items: unknown[] = Array.isArray(parsed) ? (parsed as unknown[]) : [];
  const itemRecords = items.map((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {},
  );
  const contents = itemRecords.flatMap((item) =>
    Array.isArray(item.content) ? (item.content as unknown[]) : [],
  );
  return {
    itemCount: Array.isArray(parsed) ? items.length : -1,
    ambientInherited: encoded.includes(sentinel),
    explicitContextPresent: encoded.includes(
      "Perform the bounded task in this immutable context envelope",
    ),
    boundedInstructionsPresent: encoded.includes(WORKER_INSTRUCTIONS),
    developerInstructionsPresent: encoded.includes("Follow the bounded worker envelope"),
    roles: itemRecords.map((item) => String(item.role)),
    itemTypes: itemRecords.map((item) => String(item.type)),
    contentTypes: contents.map((content) =>
      content && typeof content === "object" && !Array.isArray(content)
        ? String((content as Record<string, unknown>).type)
        : "undefined",
    ),
    nativeKeys: Object.keys(itemRecords[0] ?? {}).sort(),
  };
}

function assertProbeEvidence(options: {
  mode: Mode;
  outcome: Outcome;
  observations: Observation[];
  result: NativeResult;
}): void {
  const { mode, outcome, observations, result } = options;
  assert(!result.timedOut, "Native fixture timed out");
  assert(observations.length > 0, "No synthetic request observed");
  assert(observations[0]?.boundedInstructions);
  assert(observations[0]?.summaryMinimum === 30);
  assert.equal(
    observations.some((observation) => observation.ambientInherited),
    mode === "original",
  );
  if (mode === "isolated" && outcome !== "accumulated-context") {
    assert.equal(observations.length, 1, "Unexpected retry/compaction request");
  }
  if (outcome === "accumulated-context") {
    assert.equal(result.exit, 0);
    const boundedCatalog = process.argv[3] === "catalog" || process.argv[3] === "adapter-profile";
    assert.equal(observations.length, boundedCatalog ? 2 : 3);
    if (boundedCatalog) {
      assert(
        observations.every((observation) => observation.summaryMinimum === 30),
        "Continuation lost required report schema",
      );
    } else {
      assert.equal(
        observations[1]?.summaryMinimum,
        undefined,
        "Expected compaction request without report schema",
      );
    }
  }
  if (outcome !== "accumulated-context") {
    assert(observations.every((observation) => observation.boundedInstructions));
    assert(observations.every((observation) => observation.summaryMinimum === 30));
    assert.equal(result.exit, outcome === "success" || outcome === "missing-usage" ? 0 : 1);
  }
  if (outcome === "success") {
    assert.equal(result.usage?.cache_write_input_tokens, 0, "Expected native placeholder zero");
  }
  if (outcome === "missing-usage") {
    const counters = Object.values(result.usage ?? {});
    assert(counters.length > 0, "Expected synthesized native usage");
    assert(
      counters.every((counter) => counter === 0),
      "Expected missing usage to become native zeros",
    );
  }
}

async function startProbeServer(options: {
  flags: ProbeFlags;
  outcome: Outcome;
  state: ProbeState;
}): Promise<Server> {
  const { flags, outcome, state } = options;
  const server = createServer((request, response) => {
    if (
      (flags.managedConflict || flags.managedUnavailable || flags.managedConfig) &&
      request.url === "/backend-api/wham/config/bundle"
    ) {
      state.cloudCount++;
      if (flags.managedUnavailable) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end('{"error":"synthetic unavailability"}');
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          [flags.managedConfig ? "config_toml" : "requirements_toml"]: {
            enterprise_managed: [
              {
                id: "synthetic-managed",
                name: "Synthetic managed profile",
                contents: flags.managedConfig
                  ? `instructions = ${JSON.stringify(managedSentinel)}`
                  : `additional_developer_instructions = ${JSON.stringify(managedSentinel)}`,
              },
            ],
          },
        }),
      );
      return;
    }
    if (
      request.url !== "/v1/responses" &&
      request.url !== "/refresh" &&
      state.auxiliaryPaths.length < 40
    ) {
      state.auxiliaryPaths.push(`${request.method} ${request.url}`);
    }
    if (flags.refresh && request.url === "/refresh") {
      state.refreshCount++;
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id_token: syntheticJwt("plus"),
          access_token: refreshedAccessToken,
          refresh_token: "synthetic-refreshed-refresh",
        }),
      );
      return;
    }
    if (request.url !== "/v1/responses" && request.method === "POST") {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    void serveFixture({
      request,
      response,
      outcome,
      observations: state.observations,
      expectedInstructions: flags.adapterProfile ? WORKER_INSTRUCTIONS : instructions,
    }).catch(() => response.destroy());
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => done());
  });
  return server;
}

interface PreparedProbe {
  argumentsList: string[];
  environment: NodeJS.ProcessEnv;
  prompt: string;
  nativeExecutable?: string;
  profile?: Awaited<ReturnType<typeof createCodexProfile>>;
}

async function prepareNativeProbe(options: {
  fixture: Fixture;
  flags: ProbeFlags;
  mode: Mode;
  outcome: Outcome;
  baseUrl: string;
}): Promise<PreparedProbe> {
  const { fixture, flags, mode, outcome, baseUrl } = options;
  if (flags.adapterProfile) {
    await execute("git", ["init", "-q", fixture.workspace]);
  }
  let childHome = fixture.home;
  let childAgentHome = fixture.agentHome;
  if (mode === "isolated" && !flags.adapterProfile) {
    childHome = join(fixture.root, "isolated-user");
    childAgentHome = join(fixture.root, "isolated-agent");
    await mkdir(childHome);
    await mkdir(childAgentHome);
    await symlink(join(fixture.agentHome, "auth.json"), join(childAgentHome, "auth.json"));
  }
  let argumentsList = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--model",
    outcome === "accumulated-context" ? "gpt-5.5" : "m2-fixture",
    "--sandbox",
    "workspace-write",
    "--cd",
    fixture.workspace,
    "--output-schema",
    fixture.schemaFile,
    "--color",
    "never",
    ...configFor({ fixture, baseUrl, mode }),
    ...(process.argv[3] === "catalog"
      ? ["-c", `model_catalog_json=${JSON.stringify(fixture.catalogFile)}`]
      : []),
    "-",
  ];
  let environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: childHome,
    CODEX_HOME: childAgentHome,
    TMPDIR: fixture.root,
  };
  let prompt =
    "Perform only the explicit fixture task. Do not use $ambient-sentinel. Return the required report.";
  let nativeExecutable: string | undefined;
  let profile: Awaited<ReturnType<typeof createCodexProfile>> | undefined;
  try {
    if (flags.adapterProfile) {
      nativeExecutable = await resolveCodexExecutable();
      const executionRequest = conformanceRequest(fixture.workspace);
      if (flags.adapterDiscovery) {
        assert(executionRequest.context.task);
        executionRequest.context.task.objective =
          "Implement the bounded endpoint. An explicit mention of $ambient-sentinel or $ambient-ancestor must not import an unavailable skill.";
      }
      profile = await createCodexProfile({
        request: executionRequest,
        authFile: join(fixture.agentHome, "auth.json"),
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      });
      assert.equal(profile.args.at(-1), "-");
      argumentsList = [...profile.args.slice(0, -1), "-"];
      argumentsList.splice(
        -1,
        0,
        "-c",
        `model_providers.anastom-openai.base_url=${JSON.stringify(`${baseUrl}/v1`)}`,
      );
      environment = profile.env;
      prompt = profile.prompt;
      if (flags.adapterDiscovery) {
        assert(
          profile.args
            .join(" ")
            .includes(join(fixture.root, ".agents", "skills", "ambient-ancestor", "SKILL.md")),
        );
      }
      if (
        flags.refresh ||
        flags.managedConflict ||
        flags.managedUnavailable ||
        flags.managedConfig
      ) {
        argumentsList.splice(
          -1,
          0,
          "-c",
          `chatgpt_base_url=${JSON.stringify(`${baseUrl}/backend-api`)}`,
        );
        if (flags.refresh) {
          environment.CODEX_REFRESH_TOKEN_URL_OVERRIDE = `${baseUrl}/refresh`;
          const status = await execute(nativeExecutable, ["login", "status"], {
            env: environment,
            cwd: fixture.workspace,
          });
          assert.match(
            status.stdout + status.stderr,
            /ChatGPT/,
            "Synthetic file-backed subscription was not loaded",
          );
        }
      }
    }
    return { argumentsList, environment, prompt, nativeExecutable, profile };
  } catch (error) {
    await profile?.dispose();
    throw error;
  }
}

async function verifyNativeProbe(options: {
  flags: ProbeFlags;
  fixture: Fixture;
  mode: Mode;
  outcome: Outcome;
  state: ProbeState;
  prompt: string;
  policy?: PolicyResult;
  result: NativeResult;
}): Promise<void> {
  const { flags, fixture, mode, outcome, state, prompt, policy, result } = options;
  if (flags.managedConflict) {
    assert(policy && !policy.timedOut, "Policy inspection timed out");
    assert.equal(state.cloudCount, 1, "Synthetic managed cloud bundle was not loaded");
    assert.equal(state.observations.length, 1, "Managed fixture made unexpected model requests");
    assert.equal(
      state.observations[0]?.managedInherited,
      true,
      "Managed instructions were not inherited",
    );
  } else {
    assertProbeEvidence({ mode, outcome, observations: state.observations, result });
    if (flags.adapterDiscovery) {
      assert(prompt.includes("$ambient-sentinel") && prompt.includes("$ambient-ancestor"));
      assert.equal(
        state.observations.some((observation) => observation.ambientInherited),
        false,
      );
    }
    if (policy) {
      assert.equal(policy.requirementsPresent, false, "Unexpected managed requirements");
      assert.equal(policy.errors, 0, "Policy inspection failed");
    }
  }
  if (flags.refresh) {
    assert(state.refreshCount > 0, "Synthetic token refresh was not attempted");
    const original = JSON.parse(await readFile(join(fixture.agentHome, "auth.json"), "utf8")) as {
      tokens?: { access_token?: unknown };
    };
    assert.equal(original.tokens?.access_token, refreshedAccessToken);
  }
}

async function probe(mode: Mode, outcome: Outcome): Promise<void> {
  const flags = flagsFor(process.argv[3]);
  const fixture = await createFixture(planFor(flags), flags.refresh);
  const state: ProbeState = {
    observations: [],
    refreshCount: 0,
    cloudCount: 0,
    auxiliaryPaths: [],
  };
  const server = await startProbeServer({ flags, outcome, state });
  let prepared: PreparedProbe | undefined;
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    prepared = await prepareNativeProbe({
      fixture,
      flags,
      mode,
      outcome,
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const { argumentsList, environment, prompt, nativeExecutable } = prepared;
    const promptInput =
      flags.adapterProfile && !flags.refresh && !flags.managedConflict
        ? await inspectPromptInput({
            fixture,
            argumentsList,
            environment,
            prompt,
            nativeExecutable,
          })
        : undefined;
    if (promptInput) {
      assert.equal(promptInput.ambientInherited, false);
      assert.equal(promptInput.explicitContextPresent, true);
      assert.equal(promptInput.developerInstructionsPresent, true, JSON.stringify(promptInput));
    }
    const policy =
      flags.managedConflict ||
      flags.managedUnavailable ||
      flags.managedConfig ||
      (flags.adapterProfile && outcome === "success" && !flags.refresh)
        ? await inspectPolicy({
            fixture,
            argumentsList,
            environment,
            nativeExecutable: nativeExecutable!,
          })
        : undefined;
    if (flags.managedConflict || flags.managedConfig) {
      assert(prepared.profile && nativeExecutable);
      await assert.rejects(
        inspectCodexPolicy({
          executable: nativeExecutable,
          profile: { ...prepared.profile, args: argumentsList },
          workspace: fixture.workspace,
        }),
        (error: unknown) =>
          error instanceof RuntimePreflightError && error.category === "policy-violation",
      );
      assert.equal(state.observations.length, 0, "Product gate unexpectedly called a model");
    }
    if (flags.managedUnavailable || flags.managedConfig) {
      assert(policy, "Policy inspection did not complete");
      assert.equal(state.observations.length, 0, "Policy inspection unexpectedly called a model");
      await writeFile(
        join(fixture.root, "probe-summary.json"),
        JSON.stringify({ policy, cloudCount: state.cloudCount }, null, 2),
      );
      console.log(
        JSON.stringify({ mode, outcome, root: fixture.root, policy, cloudCount: state.cloudCount }),
      );
      return;
    }
    const result = await runNative({
      fixture,
      argumentsList,
      environment,
      prompt,
      nativeExecutable,
    });
    await verifyNativeProbe({ flags, fixture, mode, outcome, state, prompt, policy, result });
    await writeFile(
      join(fixture.root, "probe-summary.json"),
      JSON.stringify(
        {
          mode,
          outcome,
          observations: state.observations,
          promptInput,
          policy,
          result,
          refreshCount: state.refreshCount,
          cloudCount: state.cloudCount,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        mode,
        outcome,
        root: fixture.root,
        requestCount: state.observations.length,
        ambientInherited: state.observations.some((observation) => observation.ambientInherited),
        exit: result.exit,
        nativeCacheWrite: result.usage?.cache_write_input_tokens,
        managedInherited: state.observations.some((observation) => observation.managedInherited),
        cloudCount: state.cloudCount,
        policy,
      }),
    );
  } finally {
    await prepared?.profile?.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

if (process.argv[3] === "context" || process.argv[3] === "catalog") {
  await probe("isolated", "accumulated-context");
} else if (process.argv[3] === "adapter-profile") {
  await probe("isolated", "success");
  await probe("isolated", "missing-usage");
  await probe("isolated", "request-error");
  await probe("isolated", "context-error");
  await probe("isolated", "sse-context-error");
  await probe("isolated", "accumulated-context");
} else if (process.argv[3] === "adapter-discovery") {
  await probe("isolated", "success");
} else if (process.argv[3] === "adapter-refresh") {
  await probe("isolated", "success");
} else if (process.argv[3] === "managed-conflict") {
  await probe("isolated", "success");
} else if (process.argv[3] === "managed-unavailable") {
  await probe("isolated", "success");
} else if (process.argv[3] === "managed-config") {
  await probe("isolated", "success");
} else {
  await probe("original", "success");
  await probe("isolated", "success");
  await probe("isolated", "missing-usage");
  await probe("isolated", "request-error");
  await probe("isolated", "context-error");
}
