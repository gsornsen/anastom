import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import jsdoc from "eslint-plugin-jsdoc";
import noInlineScripts from "./scripts/eslint-rules/no-inline-scripts.mjs";

export default tseslint.config(
  {
    ignores: [
      "eslint.config.js",
      "**/dist/**",
      "**/node_modules/**",
      ".generated/**",
      ".agents/**",
      ".codex/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      curly: ["error", "all"],
      "no-nested-ternary": "error",
      "max-depth": ["error", 4],
      "max-nested-callbacks": ["error", 3],
      "max-params": ["error", 4],
      complexity: ["error", { max: 20, variant: "modified" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["packages/**/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/testing/**"],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: "typescript" } },
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true },
          contexts: [
            "ExportNamedDeclaration > TSInterfaceDeclaration",
            "ExportNamedDeclaration > TSTypeAliasDeclaration",
            "ExportNamedDeclaration > VariableDeclaration",
            "ExportNamedDeclaration > TSEnumDeclaration",
          ],
        },
      ],
      "jsdoc/require-description": ["error", { contexts: ["any"] }],
      "jsdoc/check-param-names": "error",
      "jsdoc/check-tag-names": [
        "error",
        { definedTags: ["remarks", "example", "packageDocumentation"] },
      ],
      "jsdoc/no-types": "error",
    },
  },
  {
    files: ["packages/**/src/**/*.{ts,mjs}", "scripts/**/*.{ts,mjs}"],
    ignores: ["scripts/eslint-rules/**/*.mjs"],
    plugins: { anastom: { rules: { "no-inline-scripts": noInlineScripts } } },
    rules: { "anastom/no-inline-scripts": "error" },
  },
  {
    files: ["packages/**/*.mjs", "scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false },
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
      },
    },
  },
  {
    files: ["examples/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false }, globals: { fetch: "readonly" } },
  },
);
