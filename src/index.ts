// gitmode — Git server for Cloudflare Workers
//
// Main entry point: exports everything needed to run gitmode in a Worker.
//
// Usage in your worker:
//   import { RepoStore, createHandler } from "gitmode";
//   export { RepoStore };
//   export default { fetch: createHandler() };
//
// Or with custom auth:
//   export default {
//     fetch(req, env) {
//       if (!authorize(req)) return new Response("Unauthorized", { status: 401 });
//       return createHandler()(req, env);
//     }
//   };

export { RepoStore } from "./repo-store";
export { PackWorkerDO } from "./pack-worker";
export { GitEngine, OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";
export { GitPorcelain } from "./git-porcelain";
export { WasmEngine } from "./wasm-engine";
export type { Env } from "./env";
export type { WasmExports } from "./wasm-engine";
export type {
  FileEntry,
  CommitInfo,
  TagInfo,
  DiffEntry,
  BranchInfo,
  StatusEntry,
} from "./git-porcelain";

// Re-export handler factory for easy Worker setup
export { createHandler } from "./handler";
export type { HandlerOptions } from "./handler";
