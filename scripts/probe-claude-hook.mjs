import { writeFile } from "node:fs/promises";

const marker = process.env.ANASTOM_FIXTURE_HOOK_MARKER;
if (marker) {
  await writeFile(marker, "ran\n");
}
