// Test worker — git protocol + REST API (no vinext UI)
// Used by vitest-pool-workers to run integration tests.

import { RepoStore } from "../src/repo-store";
import { PackWorkerDO } from "../src/pack-worker";
import { createHandler } from "../src/handler";
import type { Env } from "../src/env";

export { RepoStore, PackWorkerDO };
export type { Env };

export default {
  fetch: createHandler(),
};
