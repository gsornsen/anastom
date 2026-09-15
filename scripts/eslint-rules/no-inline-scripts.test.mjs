import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { RuleTester } from "eslint";
import rule from "./no-inline-scripts.mjs";

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
}

new RuleTester().run("no-inline-scripts", rule, {
  valid: [fixture("valid-file-execution")],
  invalid: [
    "embedded-template",
    "embedded-literal",
    "node-eval",
    "command-vector",
    "shell-command",
  ].map((name) => ({
    code: fixture(name),
    errors: [{ messageId: "embedded" }],
  })),
});
