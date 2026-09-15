import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
writeFileSync("ready", "ready");
setInterval(() => {}, 1000);
