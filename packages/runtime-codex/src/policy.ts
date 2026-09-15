import { spawn } from "node:child_process";
import { RuntimePreflightError } from "@anastom/runtime-contract";
import { JsonlDecoder } from "./jsonl.js";
import { terminateOwnedGroup } from "./process.js";
import type { CodexProfile } from "./profile.js";

const managedSources = new Set([
  "mdm",
  "enterpriseManaged",
  "legacyManagedConfigTomlFromFile",
  "legacyManagedConfigTomlFromMdm",
]);
const knownSources = new Set([
  ...managedSources,
  "sessionFlags",
  "project",
  "user",
  "system",
  "packagedDefaults",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function configurationArgs(profile: CodexProfile): string[] {
  const args: string[] = [];
  for (let index = 0; index < profile.args.length; index++) {
    if (profile.args[index] === "-c") {
      const value = profile.args[++index];
      if (!value) {
        throw new Error("Incomplete Codex profile override");
      }
      args.push("-c", value);
    }
  }
  return args;
}

function checkPolicy(requirements: unknown, config: unknown): void {
  const requirementResponse = object(requirements);
  const configResponse = object(config);
  if (
    !requirementResponse ||
    !Object.hasOwn(requirementResponse, "requirements") ||
    !configResponse ||
    !Array.isArray(configResponse.layers)
  ) {
    throw new Error("Codex policy inspection returned incomplete configuration evidence");
  }
  if (requirementResponse.requirements !== null) {
    throw new RuntimePreflightError(
      "policy-violation",
      "Codex managed requirements are present; the bounded worker profile cannot be certified",
    );
  }
  for (const value of configResponse.layers) {
    const layer = object(value);
    const source = object(layer?.name)?.type;
    const settings = object(layer?.config);
    if (typeof source !== "string" || !knownSources.has(source)) {
      throw new Error("Codex policy inspection returned an unknown configuration layer");
    }
    if (!settings) {
      throw new Error("Codex policy inspection returned a malformed configuration layer");
    }
    if (managedSources.has(source) || (source === "system" && Object.keys(settings).length > 0)) {
      throw new RuntimePreflightError(
        "policy-violation",
        "Codex managed configuration is present; the bounded worker profile cannot be certified",
      );
    }
  }
}

/** Read the pinned native policy interface without opening a model session or credential bytes. */
export async function inspectCodexPolicy(options: {
  executable: string;
  profile: CodexProfile;
  workspace: string;
}): Promise<void> {
  const child = spawn(
    options.executable,
    [...configurationArgs(options.profile), "app-server", "--stdio", "--strict-config"],
    {
      cwd: options.workspace,
      env: options.profile.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const decoder = new JsonlDecoder();
  const responses = new Map<number, unknown>();
  let bytes = 0;
  let initialized = false;
  let settled = false;
  let spawnFailed = false;
  let resolveResponse!: () => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<void>((done, reject) => {
    resolveResponse = done;
    rejectResponse = reject;
  });
  const fail = (error: Error): void => {
    if (!settled) {
      settled = true;
      rejectResponse(error);
    }
  };
  const send = (frame: object): void => {
    child.stdin.write(JSON.stringify(frame) + "\n");
  };
  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) {
      return;
    }
    bytes += chunk.length;
    if (bytes > 1_048_576) {
      fail(new Error("Codex policy inspection exceeded its output limit"));
      return;
    }
    try {
      for (const value of decoder.push(chunk)) {
        const frame = object(value);
        if (!frame) {
          throw new Error("Malformed Codex policy frame");
        }
        if (frame.error !== undefined && typeof frame.id === "number") {
          throw new Error("Codex policy inspection rejected a configuration request");
        }
        if (typeof frame.id === "number" && [1, 2, 3].includes(frame.id)) {
          if (!Object.hasOwn(frame, "result") || responses.has(frame.id)) {
            throw new Error("Malformed Codex policy response");
          }
          responses.set(frame.id, frame.result);
        }
      }
      if (responses.has(1) && !initialized) {
        if (!object(responses.get(1))) {
          throw new Error("Codex policy initialization was not confirmed");
        }
        initialized = true;
        send({ method: "initialized" });
        send({ id: 2, method: "configRequirements/read" });
        send({
          id: 3,
          method: "config/read",
          params: { includeLayers: true, cwd: options.workspace },
        });
      }
      if (responses.has(2) && responses.has(3)) {
        checkPolicy(responses.get(2), responses.get(3));
        settled = true;
        resolveResponse();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Codex policy inspection failed"));
    }
  });
  const leaderExit = new Promise<number | null>((done) => {
    child.once("exit", done);
  });
  child.once("error", () => {
    spawnFailed = true;
    fail(new Error("Codex policy reader could not start"));
  });
  child.once("exit", () => fail(new Error("Codex policy reader exited without complete evidence")));
  const timer = setTimeout(() => fail(new Error("Codex policy inspection timed out")), 15_000);
  try {
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "anastom-runtime", title: "Anastom runtime", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
    await response;
  } catch (error) {
    if (error instanceof RuntimePreflightError) {
      throw error;
    }
    throw new RuntimePreflightError(
      "runtime-unavailable",
      "Codex effective policy could not be inspected before execution",
    );
  } finally {
    clearTimeout(timer);
    if (!spawnFailed) {
      await terminateOwnedGroup(child, leaderExit);
    }
  }
}
