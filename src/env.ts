// Shared Env type for Cloudflare bindings
//
// Storage architecture (2 services):
//   R2 (OBJECTS)      — git objects (blobs, trees, commits, tags) + worktree files
//   DO (REPO_STORE)   — per-repo SQLite for refs, metadata
export interface Env {
  OBJECTS: R2Bucket;
  REPO_STORE: DurableObjectNamespace;
  PACK_WORKER?: DurableObjectNamespace;
  /** Max compute pool slots (default 20). Set via wrangler vars or secrets. */
  POOL_MAX_SLOTS?: string;
}
