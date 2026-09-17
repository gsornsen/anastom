import assert from "node:assert/strict";

import { normalizeDisplayName } from "./src/normalize-display-name.mjs";
import { normalizeLabels } from "./src/normalize-labels.mjs";

assert.equal(normalizeDisplayName("  Ada\t  Lovelace  "), "Ada Lovelace");
assert.equal(normalizeDisplayName("Grace Hopper"), "Grace Hopper");
assert.throws(() => normalizeDisplayName(42), TypeError);

const labels = [" Beta ", "alpha", "", "ALPHA", "gamma", " beta"];
assert.deepEqual(normalizeLabels(labels), ["alpha", "beta", "gamma"]);
assert.deepEqual(labels, [" Beta ", "alpha", "", "ALPHA", "gamma", " beta"]);
assert.deepEqual(normalizeLabels([]), []);
assert.throws(() => normalizeLabels("alpha"), TypeError);
assert.throws(() => normalizeLabels(["alpha", 42]), TypeError);

process.stdout.write("parallel normalizers acceptance passed\n");
