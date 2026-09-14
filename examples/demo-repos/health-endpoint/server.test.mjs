import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "./server.mjs";

test("GET /health returns JSON status", async () => {
  const app = createApp();
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  try {
    const response = await fetch("http://127.0.0.1:" + app.address().port + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.match(response.headers.get("content-type"), /application\/json/);
  } finally {
    await new Promise((done) => app.close(done));
  }
});
test("unmatched routes stay 404", async () => {
  const app = createApp();
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  try {
    const response = await fetch("http://127.0.0.1:" + app.address().port + "/missing");
    assert.equal(response.status, 404);
  } finally {
    await new Promise((done) => app.close(done));
  }
});
