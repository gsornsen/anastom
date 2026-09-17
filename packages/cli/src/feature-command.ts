import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileSdlcFeature,
  loadFeatureWithinRoot,
  loadSdlcMethodology,
  type FeatureDefinition,
  type SdlcMethodologySnapshot,
} from "@anastom/core";
import { resolveGitRepository } from "@anastom/workspaces";

import { CliUsageError } from "./errors.js";

const methodologyRoot = fileURLToPath(
  new URL("../../../methodologies/sdlc/default/", import.meta.url),
);

function repositoryRelativePath(repositoryRoot: string, path: string): string | undefined {
  const selected = relative(repositoryRoot, path);
  if (!selected || selected === ".." || selected.startsWith(`..${sep}`) || isAbsolute(selected)) {
    return undefined;
  }
  return selected.split(sep).join("/");
}

async function methodologyInputPaths(methodology: SdlcMethodologySnapshot): Promise<string[]> {
  const references = [
    "methodology.yaml",
    ...Object.values(methodology.roles).flatMap((role) => [role.promptRef, role.outputSchemaRef]),
  ];
  const lexical = references.map((reference) => join(methodologyRoot, ...reference.split("/")));
  const canonical = await Promise.all(lexical.map((path) => realpath(path)));
  return [...new Set([...lexical, ...canonical])];
}

async function protectedFeatureInputs(
  feature: FeatureDefinition,
  methodology: SdlcMethodologySnapshot,
  repositoryRoot: string,
): Promise<string[]> {
  const featurePath = repositoryRelativePath(repositoryRoot, feature.sourcePath);
  if (!featurePath) {
    throw new CliUsageError("Feature source must be inside the selected Git repository");
  }
  const protectedPaths = [
    featurePath,
    ...(await methodologyInputPaths(methodology)).flatMap((path) => {
      const selected = repositoryRelativePath(repositoryRoot, path);
      return selected ? [selected] : [];
    }),
  ];
  return [...new Set(protectedPaths)].sort();
}

/** Inputs selected by the CLI before durable Feature state or worktrees are created. */
interface FeatureCommandOptions {
  sourceRoot: string;
  target: string;
  repository: string;
}

/** Validated Feature workflow and repository paths ready for durable service composition. */
interface PreparedFeatureCommand {
  workflow: ReturnType<typeof compileSdlcFeature>;
  repositoryRoot: string;
  protectedPaths: readonly string[];
}

/**
 * Snapshot the built-in methodology and compile a repository-bound Feature workflow.
 * @remarks The Feature must live in the target repository. Methodology inputs are protected when
 * they share that repository; otherwise their content-addressed snapshot is the immutable authority.
 */
export async function prepareFeatureCommand(
  options: FeatureCommandOptions,
): Promise<PreparedFeatureCommand> {
  const [feature, methodology, repository] = await Promise.all([
    loadFeatureWithinRoot(options.sourceRoot, options.target),
    loadSdlcMethodology(methodologyRoot),
    resolveGitRepository(options.repository),
  ]);
  const protectedPaths = await protectedFeatureInputs(feature, methodology, repository.repoRoot);
  return {
    workflow: compileSdlcFeature(feature, methodology, { protectedPaths }),
    repositoryRoot: repository.repoRoot,
    protectedPaths,
  };
}
