import { createEndpointRepository } from "../packages/engine/src/testing/fixture.js";

// Run from the Anastom root. Keep the temporary repository for later inspection.
console.log(await createEndpointRepository());
