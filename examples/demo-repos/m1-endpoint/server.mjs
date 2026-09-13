import { createServer } from "node:http";

export function createApp() {
  return createServer((request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
}
