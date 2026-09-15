import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workerReportSchema } from "@anastom/core";

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
const report = {
  summary: "Completed the deterministic bounded endpoint fixture successfully.",
  changedFiles: [],
  notes: [],
};
const instructions = "You are a bounded implementer. Follow only the explicit fixture envelope.";
type Mode = "original" | "isolated";
type Outcome =
  "success" | "missing-usage" | "request-error" | "context-error" | "accumulated-context";
interface Observation {
  path: string;
  ambientInherited: boolean;
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

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "anastom-codex-feasibility-"));
  const home = join(root, "user");
  const agentHome = join(home, ".codex");
  const workspace = join(root, "repository");
  const userSkill = join(home, ".agents", "skills", "ambient-user");
  const projectSkill = join(workspace, ".agents", "skills", "ambient-project");
  for (const directory of [agentHome, join(workspace, ".codex"), userSkill, projectSkill]) {
    await mkdir(directory, { recursive: true });
  }
  for (const directory of [userSkill, projectSkill]) {
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ambient-sentinel\ndescription: ${sentinel}\n---\n${sentinel}`,
    );
  }
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
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-offline-fixture" }),
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
}): Promise<void> {
  const { request, response, outcome, observations } = options;
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
    boundedInstructions: payload.instructions === instructions,
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
}): Promise<NativeResult> {
  const child = spawn(
    process.execPath,
    [join(packageDirectory, "bin", "codex.js"), ...options.argumentsList],
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
  // Native diagnostics are intentionally discarded; only public event types/counters are retained.
  child.stderr.resume();
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, 20_000);
  child.stdin.on("error", () => {});
  child.stdin.end(
    "Perform only the explicit fixture task. Do not use $ambient-sentinel. Return the required report.",
  );
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
    assert.equal(observations.length, process.argv[3] === "catalog" ? 2 : 3);
    if (process.argv[3] === "catalog") {
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

async function probe(mode: Mode, outcome: Outcome): Promise<void> {
  const fixture = await createFixture();
  let childHome = fixture.home;
  let childAgentHome = fixture.agentHome;
  if (mode === "isolated") {
    childHome = join(fixture.root, "isolated-user");
    childAgentHome = join(fixture.root, "isolated-agent");
    await mkdir(childHome);
    await mkdir(childAgentHome);
    await symlink(join(fixture.agentHome, "auth.json"), join(childAgentHome, "auth.json"));
  }
  const observations: Observation[] = [];
  const server = createServer((request, response) => {
    void serveFixture({ request, response, outcome, observations }).catch(() => response.destroy());
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => done());
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const argumentsList = [
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
      ...configFor({ fixture, baseUrl: `http://127.0.0.1:${address.port}`, mode }),
      ...(process.argv[3] === "catalog"
        ? ["-c", `model_catalog_json=${JSON.stringify(fixture.catalogFile)}`]
        : []),
      "-",
    ];
    const result = await runNative({
      fixture,
      argumentsList,
      environment: {
        PATH: process.env.PATH,
        HOME: childHome,
        CODEX_HOME: childAgentHome,
        TMPDIR: fixture.root,
      },
    });
    assertProbeEvidence({ mode, outcome, observations, result });
    await writeFile(
      join(fixture.root, "probe-summary.json"),
      JSON.stringify({ mode, outcome, observations, result }, null, 2),
    );
    console.log(
      JSON.stringify({
        mode,
        outcome,
        root: fixture.root,
        requestCount: observations.length,
        ambientInherited: observations.some((observation) => observation.ambientInherited),
        exit: result.exit,
        nativeCacheWrite: result.usage?.cache_write_input_tokens,
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

if (process.argv[3] === "context" || process.argv[3] === "catalog") {
  await probe("isolated", "accumulated-context");
} else {
  await probe("original", "success");
  await probe("isolated", "success");
  await probe("isolated", "missing-usage");
  await probe("isolated", "request-error");
  await probe("isolated", "context-error");
}
