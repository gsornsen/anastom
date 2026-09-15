import { writeFile } from "node:fs/promises";

await writeFile(".claude/fixture-hook-ran", "ran\n");
