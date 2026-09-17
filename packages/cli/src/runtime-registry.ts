import type { CoordinatorRuntimeRegistry } from "@anastom/engine";
import { claudeCodeRuntimeDescriptorCodec } from "@anastom/runtime-claude-code";
import { codexRuntimeDescriptorCodec } from "@anastom/runtime-codex";
import type { RuntimeAdapter, RuntimeDescriptor } from "@anastom/runtime-contract";
import { assertRuntimeDescriptor } from "@anastom/runtime-contract";
import { piRuntimeDescriptorCodec } from "@anastom/runtime-pi";

interface RegisteredRuntimeCodec {
  parse(value: unknown): RuntimeDescriptor;
  create(value: unknown): Promise<RuntimeAdapter>;
}

const codecs: Readonly<Record<string, RegisteredRuntimeCodec>> = {
  pi: {
    parse: (value) => piRuntimeDescriptorCodec.parse(value),
    create: async (value) => piRuntimeDescriptorCodec.create(piRuntimeDescriptorCodec.parse(value)),
  },
  codex: {
    parse: (value) => codexRuntimeDescriptorCodec.parse(value),
    create: async (value) =>
      codexRuntimeDescriptorCodec.create(codexRuntimeDescriptorCodec.parse(value)),
  },
  "claude-code": {
    parse: (value) => claudeCodeRuntimeDescriptorCodec.parse(value),
    create: async (value) =>
      claudeCodeRuntimeDescriptorCodec.create(claudeCodeRuntimeDescriptorCodec.parse(value)),
  },
};

function codecFor(value: unknown): RegisteredRuntimeCodec {
  assertRuntimeDescriptor(value);
  const codec = codecs[value.runtimeId];
  if (!codec) {
    throw new TypeError(`Unsupported durable runtime: ${value.runtimeId}`);
  }
  return codec;
}

/** Exact descriptor registry for the three recoverable production runtimes. */
export const durableRuntimeRegistry: CoordinatorRuntimeRegistry = {
  parse(value) {
    return codecFor(value).parse(value);
  },
  async create(descriptor) {
    return codecFor(descriptor).create(descriptor);
  },
};

/** Reconstruct one registered adapter inside the isolated execution runtime host. */
export async function resolveDurableRuntime(
  descriptor: RuntimeDescriptor,
): Promise<RuntimeAdapter> {
  return durableRuntimeRegistry.create(descriptor);
}
