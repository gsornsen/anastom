#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
function writeAtomicRecord(name, value) {
  const temporary = join(root, `.${name}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(root, name));
  } finally {
    rmSync(temporary, { force: true });
  }
}
function writeDescendantPid(descendant) {
  try {
    writeAtomicRecord("child-pid", String(descendant.pid));
  } catch (error) {
    descendant.kill("SIGKILL");
    throw error;
  }
}
const { scenario, report } = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
if (process.argv.slice(2).join(" ") === "auth status --json") {
  process.stdout.write(
    JSON.stringify({
      loggedIn: scenario !== "auth-wrong",
      authMethod: scenario === "auth-wrong" ? "console" : "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "max",
      email: "PRIVATE_SENTINEL",
    }) + "\n",
  );
  process.exit(0);
}
if (scenario === "initializing") {
  writeAtomicRecord("startup-pid", String(process.pid));
  const descendant = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
  writeDescendantPid(descendant);
  process.on("SIGTERM", () => {});
  setTimeout(() => {}, 10_000);
  await new Promise(() => {});
}
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const schema = JSON.parse(option("--json-schema"));
const model = option("--model");
const tools = option("--tools").split(",").concat("StructuredOutput");
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
writeAtomicRecord(
  `entry-${process.pid}.json`,
  JSON.stringify({
    prompt: Buffer.concat(chunks).toString("utf8"),
    requiredOutputSchema: schema,
    resourceId: String(process.pid),
    args: process.argv.slice(2),
  }),
);

const line = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const usage = {
  input_tokens: 5,
  cache_creation_input_tokens: 3,
  cache_read_input_tokens: 4,
  output_tokens: 10,
  private_debug: "PRIVATE_SENTINEL",
};
line({
  type: "system",
  subtype: "init",
  claude_code_version: "2.1.268",
  model,
  tools,
  mcp_servers: [],
  plugins: [],
  skills: [],
  agents: {},
  cwd: "PRIVATE_SENTINEL",
  session_id: "PRIVATE_SENTINEL",
});
if (["cancellable", "term-resistant", "descendant", "late-write"].includes(scenario)) {
  if (scenario === "late-write") {
    const descendant = spawn(process.execPath, [join(root, "late-write-child.mjs")], {
      cwd: root,
      stdio: "ignore",
    });
    writeDescendantPid(descendant);
    line({ type: "result", subtype: "success", structured_output: report, usage });
    process.exit(0);
  }
  const descendant = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
  writeDescendantPid(descendant);
  if (scenario !== "descendant") {
    process.on("SIGTERM", () => {});
    setTimeout(() => {}, 10_000);
  } else {
    line({ type: "result", subtype: "success", structured_output: report, usage });
    process.exit(0);
  }
} else if (scenario === "failure") {
  line({ type: "result", subtype: "error", error: "PRIVATE_SENTINEL", is_error: true });
  process.exit(1);
} else if (scenario === "missing") {
  process.exit(0);
} else if (scenario === "oversize") {
  process.stdout.write("x".repeat(1_048_577));
} else if (scenario === "premature") {
  process.stdout.write('{"type":"result"');
} else if (scenario === "split") {
  const bytes = Buffer.from(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "éPRIVATE_SENTINEL" }] },
    }) + "\n",
  );
  for (const byte of bytes) {
    process.stdout.write(Buffer.from([byte]));
  }
  line({ type: "result", subtype: "success", structured_output: report, usage });
} else {
  const count = scenario === "pressure" ? 2_048 : 1;
  for (let i = 0; i < count; i++) {
    line({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: {
              file_path: "PRIVATE_SENTINEL",
            },
          },
        ],
      },
      thinking: "PRIVATE_SENTINEL",
    });
  }
  line({ type: "result", subtype: "success", structured_output: report, usage });
}
