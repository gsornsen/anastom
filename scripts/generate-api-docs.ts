import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Application } from "typedoc";

const packages = readdirSync("packages").filter((name) =>
  existsSync(`packages/${name}/package.json`),
);
const requested = process.argv[2]?.replace(/^@anastom\//, "");
if (requested && !packages.includes(requested)) {
  throw new Error(`Unknown package: ${requested}`);
}

for (const name of requested ? [requested] : packages) {
  const app = await Application.bootstrap({
    entryPoints: [resolve(`packages/${name}/src/index.ts`)],
    tsconfig: resolve("tsconfig.json"),
    name: `@anastom/${name}`,
    readme: resolve(`packages/${name}/README.md`),
    excludePrivate: true,
    excludeInternal: true,
    validation: { notDocumented: true, notExported: false },
    requiredToBeDocumented: ["Class", "Interface", "Function", "TypeAlias", "Method", "Variable"],
  });
  const project = await app.convert();
  if (!project) {
    throw new Error(`Cannot generate API documentation for ${name}`);
  }
  app.validate(project);
  if (app.logger.hasErrors() || app.logger.hasWarnings()) {
    throw new Error(`Invalid API documentation for ${name}`);
  }
  await app.generateDocs(project, resolve(`.generated/api/${name}`));
}
