import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conformanceRequest,
  conformanceReport,
  drainEvents,
} from "../packages/runtime-contract/src/testing/conformance.js";
import { ClaudeCodeRuntimeAdapter } from "@anastom/runtime-claude-code";
import { resolveClaudeCodeExecutable } from "../packages/runtime-claude-code/src/executable.js";

const fileCases = [
  "inside-read",
  "outside-read",
  "symlink-read",
  "inside-write",
  "outside-write",
  "symlink-write",
  "protected-write",
  "inside-edit",
  "outside-edit",
  "symlink-edit",
  "protected-edit",
] as const;
type FileCase = (typeof fileCases)[number];
const nativeCases = ["native-error", "invalid-report"] as const;
type NativeCase = (typeof nativeCases)[number];
const apiKeyMode = process.argv[2] === "api-key";
const requestedCase = apiKeyMode ? process.argv[3] : process.argv[2];
if (
  requestedCase &&
  !fileCases.includes(requestedCase as FileCase) &&
  !nativeCases.includes(requestedCase as NativeCase)
) {
  throw new Error("Unsupported synthetic native case");
}
const fileCase = fileCases.includes(requestedCase as FileCase)
  ? (requestedCase as FileCase)
  : undefined;
const nativeCase = nativeCases.includes(requestedCase as NativeCase)
  ? (requestedCase as NativeCase)
  : undefined;
const authSource = apiKeyMode ? "api-key" : "subscription";

const root = await mkdtemp(join(tmpdir(), "anastom-claude-adapter-offline-"));
const workspace = join(root, "workspace");
const configuration = join(root, "config");
await Promise.all([mkdir(workspace), mkdir(configuration)]);
await writeFile(join(workspace, "inside.txt"), "INSIDE_SENTINEL\n");
await writeFile(join(root, "outside.txt"), "OUTSIDE_SENTINEL\n");
await symlink(join(root, "outside.txt"), join(workspace, "escape-read"));
await symlink(join(root, "outside-written.txt"), join(workspace, "escape-write"));
await writeFile(join(workspace, "CLAUDE.md"), "AMBIENT_SENTINEL project\n");
await writeFile(join(configuration, "CLAUDE.md"), "AMBIENT_SENTINEL user\n");
await mkdir(join(workspace, ".claude", "agents"), { recursive: true });
await mkdir(join(workspace, ".claude", "skills", "fixture-skill"), { recursive: true });
await writeFile(
  join(workspace, ".claude", "agents", "fixture-agent.md"),
  "---\nname: fixture-agent\ndescription: Synthetic custom agent\n---\nAMBIENT_SENTINEL\n",
);
await writeFile(
  join(workspace, ".claude", "skills", "fixture-skill", "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Synthetic custom skill\n---\nAMBIENT_SENTINEL\n",
);
await writeFile(
  join(workspace, ".claude", "probe-claude-hook.mjs"),
  await readFile(join(import.meta.dirname, "probe-claude-hook.mjs")),
);
await writeFile(
  join(workspace, ".claude", "settings.json"),
  JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "node .claude/probe-claude-hook.mjs" }] },
      ],
    },
  }),
);
const hookMarker = join(workspace, ".claude", "fixture-hook-ran");
const modelRequests: Array<Record<string, unknown>> = [];
const routes: string[] = [];
const server = createServer((request, response) => {
  void respond(request, response).catch(() => response.destroy());
});

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
  routes.push(`${request.method} ${path}`);
  if (request.method !== "POST" || path !== "/v1/messages") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "not_found_error", message: "fixture route" } }));
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length;
    if (bytes <= 2_097_152) {
      chunks.push(chunk as Buffer);
    }
  }
  if (bytes > 2_097_152) {
    throw new Error("Synthetic request body exceeded limit");
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const messages: unknown[] = Array.isArray(parsed.messages) ? parsed.messages : [];
  const toolResults: unknown[] = messages.flatMap((message): unknown[] => {
    if (!message || typeof message !== "object" || !("content" in message)) {
      return [];
    }
    const blocks: unknown[] = Array.isArray(message.content) ? message.content : [];
    return blocks.filter(
      (block) =>
        block && typeof block === "object" && "type" in block && block.type === "tool_result",
    );
  });
  const toolResultBody = JSON.stringify(toolResults);
  const toolNames = Array.isArray(parsed.tools)
    ? parsed.tools.map((tool: unknown) =>
        tool && typeof tool === "object" && "name" in tool ? tool.name : "unknown",
      )
    : [];
  modelRequests.push({
    model: parsed.model,
    toolNames,
    hasOutputConfig: !!parsed.output_config,
    ambientPresent: body.includes("AMBIENT_SENTINEL"),
    explicitObjectivePresent: body.includes("Implement the bounded endpoint"),
    insideReadObserved: toolResultBody.includes("INSIDE_SENTINEL"),
    outsideReadObserved: toolResultBody.includes("OUTSIDE_SENTINEL"),
    toolResultPresent: toolResults.length > 0,
  });
  if (nativeCase === "native-error") {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { type: "invalid_request_error", message: "offline fixture failure" },
      }),
    );
    return;
  }
  const firstTool =
    fileCase && modelRequests.length <= 2 && !body.includes('"tool_result"')
      ? fileToolUse(fileCase)
      : undefined;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "msg_anastom_fixture",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [
        firstTool ?? {
          type: "tool_use",
          id: "toolu_anastom_fixture",
          name: "StructuredOutput",
          input: nativeCase === "invalid-report" ? {} : conformanceReport,
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
  );
}

function fileToolUse(scenario: FileCase): Record<string, unknown> {
  const targets: Record<FileCase, string> = {
    "inside-read": join(workspace, "inside.txt"),
    "outside-read": join(root, "outside.txt"),
    "symlink-read": join(workspace, "escape-read"),
    "inside-write": join(workspace, "inside-written.txt"),
    "outside-write": join(root, "outside-written.txt"),
    "symlink-write": join(workspace, "escape-write"),
    "protected-write": join(workspace, ".claude", "settings.json"),
    "inside-edit": join(workspace, "inside.txt"),
    "outside-edit": join(root, "outside.txt"),
    "symlink-edit": join(workspace, "escape-read"),
    "protected-edit": join(workspace, ".claude", "settings.json"),
  };
  const isRead = scenario.endsWith("read");
  const isEdit = scenario.endsWith("edit");
  let input: Record<string, string>;
  if (isRead) {
    input = { file_path: targets[scenario] };
  } else if (isEdit) {
    let oldString = "INSIDE_SENTINEL";
    if (scenario === "protected-edit") {
      oldString = "SessionStart";
    } else if (scenario === "outside-edit" || scenario === "symlink-edit") {
      oldString = "OUTSIDE_SENTINEL";
    }
    input = { file_path: targets[scenario], old_string: oldString, new_string: "synthetic-edited" };
  } else {
    input = { file_path: targets[scenario], content: "synthetic-written" };
  }
  let toolName = "Write";
  if (isRead) {
    toolName = "Read";
  } else if (isEdit) {
    toolName = "Edit";
  }
  return {
    type: "tool_use",
    id: "toolu_anastom_file_fixture",
    name: toolName,
    input,
  };
}

try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synthetic server did not bind a TCP port");
  }
  const executable = await resolveClaudeCodeExecutable();
  const adapter = new ClaudeCodeRuntimeAdapter({
    provider: "anthropic",
    model: "claude-opus-4-8",
    authSource,
    testing: {
      executable,
      environment: {
        PATH: process.env.PATH,
        USER: process.env.USER,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "C.UTF-8",
        CLAUDE_CONFIG_DIR: configuration,
        ANTHROPIC_API_KEY: "offline-fixture-only",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    },
  });
  const handle = await adapter.start(conformanceRequest(workspace));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    adapter.collect(handle),
    new Promise<never>((_done, reject) => {
      timeout = setTimeout(() => reject(new Error("Synthetic native adapter timed out")), 20_000);
    }),
  ])
    .catch(async (error) => {
      await adapter.cancel(handle);
      throw error;
    })
    .finally(() => clearTimeout(timeout));
  const events = await drainEvents(adapter, handle);
  const hookRan = await readFile(hookMarker).then(
    () => true,
    () => false,
  );
  const insideWritten = await readFile(join(workspace, "inside-written.txt"), "utf8").then(
    (value) => value === "synthetic-written",
    () => false,
  );
  const outsideWritten = await readFile(join(root, "outside-written.txt"), "utf8").then(
    (value) => value === "synthetic-written",
    () => false,
  );
  const insideEdited = (await readFile(join(workspace, "inside.txt"), "utf8")).includes(
    "synthetic-edited",
  );
  const outsideEdited = (await readFile(join(root, "outside.txt"), "utf8")).includes(
    "synthetic-edited",
  );
  const protectedChanged = !(
    await readFile(join(workspace, ".claude", "settings.json"), "utf8")
  ).includes("SessionStart");
  process.stdout.write(
    JSON.stringify({
      nativeRelease: "2.1.268",
      resultStatus: result.status,
      failureCategory: result.status === "failed" ? result.failure.category : undefined,
      authSource,
      fileCase,
      nativeCase,
      routes,
      modelRequests,
      hookRan,
      insideWritten,
      outsideWritten,
      insideEdited,
      outsideEdited,
      protectedChanged,
      publicEventTypes: events.map((event) => event.type),
      publicPrivateSentinelPresent:
        JSON.stringify(events).includes("AMBIENT_SENTINEL") ||
        JSON.stringify(events).includes("PRIVATE_SENTINEL"),
    }) + "\n",
  );
  if (
    (nativeCase === "native-error" &&
      (result.status !== "failed" || result.failure.category !== "model-provider")) ||
    (nativeCase === "invalid-report" && result.status !== "failed") ||
    (!nativeCase && result.status !== "succeeded") ||
    hookRan ||
    modelRequests.length === 0 ||
    modelRequests.some((request) => request.ambientPresent || !request.explicitObjectivePresent) ||
    (fileCase === "inside-write" && !insideWritten) ||
    (fileCase === "inside-edit" && !insideEdited) ||
    (["outside-write", "symlink-write"].includes(fileCase ?? "") && outsideWritten) ||
    (["outside-edit", "symlink-edit"].includes(fileCase ?? "") && outsideEdited) ||
    (fileCase === "protected-write" && protectedChanged) ||
    (fileCase === "protected-edit" && protectedChanged) ||
    (fileCase === "inside-read" && !modelRequests.some((request) => request.insideReadObserved)) ||
    (["outside-read", "symlink-read"].includes(fileCase ?? "") &&
      modelRequests.some((request) => request.outsideReadObserved))
  ) {
    process.exitCode = 1;
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}
