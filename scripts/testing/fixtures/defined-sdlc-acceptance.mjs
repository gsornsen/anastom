import { readFile } from "node:fs/promises";

const [left, right] = await Promise.all([
  readFile("left.txt", "utf8"),
  readFile("right.txt", "utf8"),
]);

if (
  left !== "left implementation\nintegration correction\n" ||
  right !== "right implementation\n"
) {
  throw new Error("Integrated feature content does not match the accepted result");
}

process.stdout.write("defined SDLC acceptance passed\n");
