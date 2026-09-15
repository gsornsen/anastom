import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
writeFileSync(process.argv[2], "ready");
setInterval(() => {}, 1000);
