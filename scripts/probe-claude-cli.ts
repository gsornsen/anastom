import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELEASE = "2.1.268";
if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--stream-json")) {
  throw new Error("Use --stream-json to probe native JSONL; install Claude Code on PATH");
}
const executable = "claude";
const outputFormat = process.argv[2] === "--stream-json" ? "stream-json" : "json";

const fixtureRoot = await mkdtemp(join(tmpdir(), "anastom-claude-offline-"));
const workspace = join(fixtureRoot, "workspace");
const config = join(fixtureRoot, "config");
await Promise.all([mkdir(workspace), mkdir(config)]);
await writeFile(join(workspace, "CLAUDE.md"), "AMBIENT_SENTINEL project context\n");
await writeFile(join(config, "CLAUDE.md"), "AMBIENT_SENTINEL user context\n");
await mkdir(join(workspace, ".claude"));
await mkdir(join(workspace, ".claude", "skills", "fixture-skill"), { recursive: true });
await mkdir(join(workspace, ".claude", "agents"));
await writeFile(
  join(workspace, ".claude", "skills", "fixture-skill", "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Synthetic ignored skill\n---\nAMBIENT_SENTINEL skill\n",
);
await writeFile(
  join(workspace, ".claude", "agents", "fixture-agent.md"),
  "---\nname: fixture-agent\ndescription: Synthetic ignored agent\n---\nAMBIENT_SENTINEL agent\n",
);
await writeFile(
  join(workspace, ".claude", "probe-claude-hook.mjs"),
  await readFile(join(import.meta.dirname, "probe-claude-hook.mjs")),
);
const hookMarker = join(workspace, ".claude", "fixture-hook-ran");
await writeFile(
  join(workspace, ".claude", "settings.json"),
  JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: "node .claude/probe-claude-hook.mjs",
            },
          ],
        },
      ],
    },
  }),
);
const requests: string[] = [];
const modelRequests: Record<string, unknown>[] = [];
let modelCalls = 0;
const server = createServer((request, response) => {
  void respondToFixture(request, response).catch(() => response.destroy());
});

async function respondToFixture(request: IncomingMessage, response: ServerResponse) {
  const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
  requests.push(`${request.method} ${path}`);
  if (request.method === "POST" && path === "/v1/messages") {
    modelCalls++;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += (chunk as Buffer).length;
      if (bytes <= 2_097_152) {
        chunks.push(chunk as Buffer);
      }
    }
    if (bytes <= 2_097_152) {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        modelRequests.push({
          model: parsed.model,
          messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : undefined,
          systemType: typeof parsed.system,
          toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
          toolNames: Array.isArray(parsed.tools)
            ? parsed.tools.map((tool: unknown) =>
                tool && typeof tool === "object" && "name" in tool ? tool.name : "unknown",
              )
            : undefined,
          hasOutputConfig: !!parsed.output_config,
          ambientPresent: body.includes("AMBIENT_SENTINEL"),
          fixturePromptPresent: body.includes("Offline fixture"),
        });
      } catch {
        modelRequests.push({ parseError: true });
      }
    } else {
      modelRequests.push({ oversized: true });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "msg_anastom_fixture",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: "toolu_anastom_fixture",
            name: "StructuredOutput",
            input: { status: "ok" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    );
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: "not_found_error", message: "fixture route" } }));
}

try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture listener has no TCP port");
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: "offline-fixture-only",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const version = await new Promise<string>((done, reject) => {
    const child = spawn(executable, ["--version"], { cwd: workspace, env, shell: false });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? done(output.trim()) : reject(new Error("Claude version check failed")),
    );
  });
  if (!version.startsWith(RELEASE + " ")) {
    throw new Error(`Expected exact Claude Code ${RELEASE}, found ${version}`);
  }
  const args = [
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--print",
    "--output-format",
    outputFormat,
    ...(outputFormat === "stream-json" ? ["--verbose"] : []),
    "--json-schema",
    JSON.stringify({
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    }),
    "--model",
    "claude-sonnet-4-6",
    "--max-turns",
    "1",
    "--tools",
    "Read,Glob,Grep",
    "--permission-mode",
    "dontAsk",
    "Offline fixture: respond with a short sentence; use no tools.",
  ];
  const child = spawn(executable, args, { cwd: workspace, env, shell: false, detached: true });
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdout += chunk.toString("utf8").slice(0, 65_536 - stdout.length);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderr += chunk.toString("utf8").slice(0, 65_536 - stderr.length);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Offline Claude fixture timed out")), 20_000);
    }),
  ])
    .catch((error) => {
      if (child.pid) {
        process.kill(-child.pid, "SIGTERM");
      }
      throw error;
    })
    .finally(() => clearTimeout(timer));
  let result: Record<string, unknown> | undefined;
  let nativeFrames: Record<string, unknown>[] = [];
  try {
    if (outputFormat === "stream-json") {
      nativeFrames = stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      result = nativeFrames.at(-1);
    } else {
      result = JSON.parse(stdout) as Record<string, unknown>;
    }
  } catch {
    // Preserve only bounded shape evidence in public output.
  }
  const hookRan = await readFile(hookMarker, "utf8").then(
    () => true,
    () => false,
  );
  const init = nativeFrames.find((frame) => frame.type === "system");
  process.stdout.write(
    JSON.stringify({
      release: RELEASE,
      exitCode: code,
      modelCalls,
      modelRequests,
      requestRoutes: requests,
      hookRan,
      resultType: result?.type,
      resultSubtype: result?.subtype,
      resultHasUsage: !!result?.usage,
      resultHasStructuredOutput: !!result?.structured_output,
      outputFormat,
      frameTypes: nativeFrames.map((frame) => ({ type: frame.type, subtype: frame.subtype })),
      initKeys: Object.keys(init ?? {}),
      initTools: Array.isArray(init?.tools) ? init.tools : [],
      initMcpCount: Array.isArray(init?.mcp_servers) ? init.mcp_servers.length : undefined,
      initAgentsCount:
        init?.agents && typeof init.agents === "object"
          ? Object.keys(init.agents).length
          : undefined,
      initSkillsCount: Array.isArray(init?.skills) ? init.skills.length : undefined,
      initPluginsCount: Array.isArray(init?.plugins) ? init.plugins.length : undefined,
      fixtureAgentPresent: !!init?.agents && JSON.stringify(init.agents).includes("fixture-agent"),
      fixtureSkillPresent: !!init?.skills && JSON.stringify(init.skills).includes("fixture-skill"),
      assistantBlockTypes: nativeFrames.flatMap((frame) => {
        if (frame.type !== "assistant" || !frame.message || typeof frame.message !== "object") {
          return [];
        }
        const message = frame.message as Record<string, unknown>;
        return Array.isArray(message.content)
          ? message.content.map((block: unknown) =>
              block && typeof block === "object" && "type" in block ? block.type : "unknown",
            )
          : [];
      }),
      resultUsageKeys:
        result?.usage && typeof result.usage === "object" ? Object.keys(result.usage) : [],
      stdoutBytes,
      stderrBytes,
    }) + "\n",
  );
  if (
    code !== 0 ||
    hookRan ||
    stdoutBytes > 65_536 ||
    stderrBytes > 65_536 ||
    modelCalls < 1 ||
    modelRequests.length !== modelCalls ||
    modelRequests.some(
      (request) =>
        request.model !== "claude-sonnet-4-6" ||
        request.ambientPresent !== false ||
        request.fixturePromptPresent !== true ||
        request.hasOutputConfig !== true,
    ) ||
    result?.type !== "result" ||
    result.subtype !== "success" ||
    !result.usage ||
    (result.structured_output as Record<string, unknown> | undefined)?.status !== "ok"
  ) {
    throw new Error("Offline Claude fixture failed safety or structured-output checks");
  }
} finally {
  server.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
