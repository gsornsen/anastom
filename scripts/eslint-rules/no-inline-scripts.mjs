const inlineInterpreterFlag = new Set(["-e", "--eval"]);

function staticText(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral") {
    return node.quasis.map((part) => part.value.cooked ?? part.value.raw).join("");
  }
  return undefined;
}

function containsShebang(node) {
  return staticText(node)?.trimStart().startsWith("#!") ?? false;
}

function inlineInterpreterArgument(node) {
  if (node.type !== "CallExpression" || node.arguments.length < 2) {
    return undefined;
  }
  const name = node.callee.type === "Identifier" ? node.callee.name : undefined;
  if (name !== "spawn" && name !== "execFile" && name !== "spawnSync" && name !== "execFileSync") {
    return undefined;
  }
  const args = node.arguments[1];
  if (args.type !== "ArrayExpression") {
    return undefined;
  }
  const executable = staticText(node.arguments[0]);
  for (let i = 0; i < args.elements.length - 1; i++) {
    const flag = staticText(args.elements[i]);
    const isInterpreter =
      executable !== undefined && /(?:^|\/)(?:sh|bash|zsh|python3?|node)$/.test(executable);
    if (flag === "-c" && isInterpreter && args.elements[i + 1]) {
      return args.elements[i + 1];
    }
  }
  return undefined;
}

/** Reject executable source stored in strings; keep process doubles as reviewable files. */
export default {
  meta: {
    type: "problem",
    docs: { description: "Require executable scripts to be checked-in files" },
    messages: {
      embedded: "Executable scripts must live in a file rather than an inline string.",
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (containsShebang(node)) {
          context.report({ node, messageId: "embedded" });
        }
      },
      TemplateLiteral(node) {
        if (containsShebang(node)) {
          context.report({ node, messageId: "embedded" });
        }
      },
      CallExpression(node) {
        const argument = inlineInterpreterArgument(node);
        if (argument) {
          context.report({ node: argument, messageId: "embedded" });
        }
      },
      ArrayExpression(node) {
        for (let i = 0; i < node.elements.length - 1; i++) {
          if (inlineInterpreterFlag.has(staticText(node.elements[i])) && node.elements[i + 1]) {
            context.report({ node: node.elements[i + 1], messageId: "embedded" });
          }
        }
      },
    };
  },
};
