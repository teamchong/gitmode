// gitmode Worker entry point
//
// This is the minimal setup. Customize by adding auth, rate limiting, etc.
//
// Docs: https://github.com/teamchong/gitmode

import { RepoStore, PackWorkerDO, createHandler } from "gitmode";

// Re-export the Durable Object classes (required by Cloudflare)
export { RepoStore, PackWorkerDO };

// Create the fetch handler
const handler = createHandler();

export default {
  fetch: handler,
};
