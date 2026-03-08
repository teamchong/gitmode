// gitmode worker entry — handles git protocol, REST API, AND vinext UI
//
// Routes:
//   *.git/*            → git protocol handlers (via createHandler)
//   /api/repos/*       → REST API (via createHandler)
//   /*                 → vinext RSC UI (fallback)

import handler from "vinext/server/app-router-entry";
import type { Env } from "../src/env";
import { RepoStore } from "../src/repo-store";
import { createHandler } from "../src/handler";

export { RepoStore };
export type { Env };

const gitmode = createHandler({
  fallback: (request) => handler.fetch(request),
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Expose env to RSC components via globalThis
    (globalThis as any).__gitmode_env__ = env;
    return gitmode(request, env);
  },
};
