#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const location = dirname(fileURLToPath(import.meta.url));
function writeAtomicRecord(name, value) {
  const temporary = join(location, `.${name}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(location, name));
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
const { scenario, report } = JSON.parse(readFileSync(join(location, "fixture.json"), "utf8"));
if (process.argv.includes("app-server")) {
  writeAtomicRecord(
    `policy-${process.pid}.json`,
    JSON.stringify({ codexHome: process.env.CODEX_HOME }),
  );
  if (scenario === "policy-unavailable") {
    process.exit(1);
  }
  const line = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
  for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const frame = JSON.parse(text);
    if (frame.method === "initialize") {
      line({ id: frame.id, result: { userAgent: "synthetic" } });
    } else if (frame.method === "configRequirements/read") {
      line({
        id: frame.id,
        result: {
          requirements:
            scenario === "managed-requirements"
              ? { additionalDeveloperInstructions: "PRIVATE_SENTINEL" }
              : null,
        },
      });
    } else if (frame.method === "config/read") {
      line({
        id: frame.id,
        result: {
          layers: [
            { name: { type: "sessionFlags" }, config: {} },
            ...(scenario === "managed-config"
              ? [
                  {
                    name: { type: "enterpriseManaged" },
                    config: { instructions: "PRIVATE_SENTINEL" },
                  },
                ]
              : []),
          ],
        },
      });
    }
  }
  process.exit(0);
}
const chunks = [];
let stdinBytes = 0;
for await (const chunk of process.stdin) {
  stdinBytes += chunk.length;
  if (stdinBytes > 1_048_576) {
    throw new Error("Synthetic prompt exceeded fixture limit");
  }
  chunks.push(chunk);
}
const schemaFlag = process.argv.indexOf("--output-schema");
if (schemaFlag < 0 || !process.argv[schemaFlag + 1]) {
  throw new Error("Synthetic native process did not receive an output schema");
}
writeAtomicRecord(
  `entry-${process.pid}.json`,
  JSON.stringify({
    prompt: Buffer.concat(chunks).toString("utf8"),
    requiredOutputSchema: JSON.parse(readFileSync(process.argv[schemaFlag + 1], "utf8")),
    codexHome: process.env.CODEX_HOME,
    home: process.env.HOME,
  }),
);
const line = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
};

line({ type: "thread.started", thread_id: "fixture" });
line({ type: "turn.started" });
if (scenario === "descendant" || scenario === "term-resistant" || scenario === "cancellable") {
  const descendant = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
  writeDescendantPid(descendant);
  if (scenario === "term-resistant" || scenario === "cancellable") {
    process.on("SIGTERM", () => {});
    setTimeout(() => {}, 10_000);
  } else {
    line({ type: "item.completed", item: { id: "fixture", type: "agent_message", text: report } });
    line({ type: "turn.completed", usage });
    process.exit(0);
  }
} else if (scenario === "failure") {
  line({ type: "turn.failed", error: { message: "PRIVATE_SENTINEL" } });
  process.exit(1);
} else if (scenario === "missing") {
  process.exit(0);
} else if (scenario === "oversize") {
  process.stdout.write("x".repeat(1_048_577));
} else if (scenario === "split") {
  const bytes = Buffer.from(
    JSON.stringify({
      type: "item.completed",
      item: { id: "fixture", type: "agent_message", text: report },
    }) + "\n",
  );
  for (let i = 0; i < bytes.length; i++) {
    process.stdout.write(bytes.subarray(i, i + 1));
  }
  line({ type: "turn.completed", usage });
} else {
  const logs = scenario === "pressure" ? 2048 : 1;
  for (let i = 0; i < logs; i++) {
    line({
      type: "item.completed",
      item: {
        id: String(i),
        type: "command_execution",
        command: "PRIVATE_SENTINEL",
        aggregated_output: "PRIVATE_SENTINEL",
        status: "completed",
      },
    });
  }
  line({
    type: "item.completed",
    item: { id: "fixture", type: "agent_message", text: report, reasoning: "PRIVATE_SENTINEL" },
  });
  line({ type: "turn.completed", usage });
}
