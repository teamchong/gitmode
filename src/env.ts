// Shared Env type for Cloudflare bindings
//
// Storage architecture (2 services):
//   R2 (OBJECTS)      — git objects (blobs, trees, commits, tags) + worktree files
//   DO (REPO_STORE)   — per-repo SQLite for refs, metadata
export interface Env {
  OBJECTS: R2Bucket;
  REPO_STORE: DurableObjectNamespace;
  PACK_WORKER?: DurableObjectNamespace;
}
