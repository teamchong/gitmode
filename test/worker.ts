// Test worker — git protocol + REST API (no vinext UI)
// Used by vitest-pool-workers to run integration tests.

import { RepoStore } from "../src/repo-store";
import { createHandler } from "../src/handler";
import type { Env } from "../src/env";

export { RepoStore };
export type { Env };

export default {
  fetch: createHandler(),
};
