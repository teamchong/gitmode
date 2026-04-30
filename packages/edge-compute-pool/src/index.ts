// @gitmode/edge-compute-pool — fan-out compute primitives for git operations on Workers.
//
// Built around a pool of Durable Object "slots" used as compute units. Each
// slot has its own ~128MB memory budget, WASM engine, and R2 access. The
// coordinator dispatches work to slots via RPC, which read directly from R2,
// process locally, and return only results — keeping the coordinator's memory
// flat regardless of repo size.
//
// Public surface:
//   - PackWorkerDO            — the slot class; export from your Worker
//   - dispatchToPool          — scatter/gather across pool slots
//   - batchForPool            — split a workload into per-slot batches
//   - PoolConfig, PackWorkerEnv — types
//   - Diff / pack-format helpers — for callers building their own actions

export { PackWorkerDO, type PackWorkerEnv } from "./pack-worker";
export { dispatchToPool, batchForPool, type PoolConfig } from "./compute-pool";
export {
  unifiedDiff,
  isBinary,
} from "./diff-engine";
export {
  OBJ_BLOB,
  OBJ_TREE,
  OBJ_COMMIT,
  OBJ_TAG,
  objectToPackType,
  writeTypeSizeHeader,
  typeSizeHeaderLen,
  writeUint32BE,
} from "./pack-format";
export {
  parseCommitBody,
  parseCommitFromRaw,
  type CommitInfo,
} from "./commit-parse";
export {
  mergeBase,
  type MergeBaseOptions,
  type CommitLookup,
  type CommitLocation,
} from "./coordinators/merge-base";
export {
  logWalk,
  type LogWalkOptions,
} from "./coordinators/log-walk";
export {
  blameWalk,
  type BlameWalkOptions,
  type BlameLine,
} from "./coordinators/blame-walk";

// Required by vitest-pool-workers / wrangler entry resolution.
// This package is consumed as a library; the fetch handler returns 404 because
// the package is not deployed as its own Worker.
export default {
  fetch: () => new Response("not found", { status: 404 }),
} satisfies ExportedHandler;
