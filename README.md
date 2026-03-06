# gitmode

> **Warning: Experimental** — This project is a proof-of-concept and under active development. APIs, storage layout, and functionality may change without notice. Not recommended for production use.

Git server running entirely on Cloudflare Workers. No VMs, no servers — just Workers + R2 + Durable Objects.

The git protocol engine is written in Zig, compiled to WASM with SIMD128 acceleration for SHA-1 hashing, delta compression, and packfile operations. libgit2 is statically linked for advanced operations (diff, blame, revwalk).

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/teamchong/gitmode)

## Deploy your own

### One-click deploy

Click the button above to:
1. Fork this repo to your GitHub
2. Connect your Cloudflare account
3. Auto-provision R2 bucket and Durable Objects
4. Deploy the Worker

### Manual deploy

```bash
git clone https://github.com/teamchong/gitmode.git
cd gitmode
./scripts/setup.sh
```

Requires: [Zig 0.15.2+](https://ziglang.org), [pnpm](https://pnpm.io), [wrangler](https://developers.cloudflare.com/workers/wrangler/)

## Usage

Once deployed, use standard git commands:

```bash
# Clone a repo
git clone https://gitmode.your-subdomain.workers.dev/alice/myproject.git

# Push to a new repo
mkdir myproject && cd myproject
git init && git add . && git commit -m "init"
git remote add origin https://gitmode.your-subdomain.workers.dev/alice/myproject.git
git push -u origin main
```

## Architecture

![Architecture](docs/public/img/architecture.svg)

### Storage

| Data | Storage | Why |
|------|---------|-----|
| Git objects (blobs, trees, commits) | R2 | Unlimited size, $0.015/GB/mo, content-addressed |
| Worktree files (materialized on push) | R2 | Direct file access for UI, edge-cached |
| Refs (branches, tags, HEAD) | DO SQLite | Strongly consistent, co-located with ref update logic |
| Metadata (repos, commits, permissions) | DO SQLite | SQL queries, no cross-service latency |
| File size cache | DO SQLite | Avoids R2 reads for stats endpoint |
| Push coordination | Durable Objects | Single-threaded per repo — atomic ref updates without locks |

### Why Durable Objects with SQLite (not KV + D1)

Previous versions used KV for refs and D1 for metadata. This had problems:

- **KV eventual consistency**: After a push, `git ls-remote` could return stale refs for up to 60 seconds.
- **Cross-service latency**: Every git operation required multiple round-trips between Worker, KV, D1, and a separate DO for locking.
- **4 services to manage**: R2 + KV + D1 + DO made deployment and debugging complex.

The current architecture uses just **2 services** (R2 + DO). Each repo gets its own Durable Object with embedded SQLite. Refs, metadata, and coordination all happen in a single strongly-consistent context with zero cross-service latency.

### Why Zig WASM

Git's hot paths are CPU-bound binary operations — SHA-1 hashing, zlib decompression, delta patching, packfile assembly. Zig compiled to WASM with SIMD128 handles these 10-50x faster than JavaScript:

- **SHA-1**: Every object read/write hashes. SIMD-accelerated rounds.
- **Delta compression**: SIMD memcmp for finding copy regions in base objects.
- **Packfile parsing**: Binary protocol with varint encoding — Zig's type system maps 1:1.
- **Memory**: Fixed 32MB arena allocator. No GC pauses during large pushes.

## Performance

Benchmarked on localhost dev server with batch R2 writes, incremental worktree updates, optimistic object cache, and SQLite file size caching:

| Operation | Small (3 files) | Medium (50 files) | Large (500 files) |
|---|---|---|---|
| Initial push | 283ms | 183ms | 52ms (was 972ms) |
| Incremental push | 85ms | 192ms | 12ms (was 827ms) |
| Clone | 95ms | 152ms | 372ms |
| Fetch | 98ms | 153ms | 340ms |

Key optimizations:
- **Batch R2 writes**: Objects prepared in CPU (hash+compress), then flushed to R2 in parallel batches of 50
- **Incremental worktree**: Diffs old tree vs new tree, only writes changed/added files
- **Optimistic object cache**: Worktree materialization uses in-memory objects from packfile unpack, eliminating all R2 re-reads
- **SQLite file size cache**: Stats endpoint reads cached sizes instead of fetching blobs from R2

## Git features

| Feature | Status |
|---------|--------|
| `git clone` (HTTPS) | Supported |
| `git push` | Supported |
| `git fetch` / `git pull` | Supported |
| Branches and tags | Supported |
| Delta compression (ofs-delta, ref-delta) | Supported |
| Packfile v2 | Supported |
| Diff (via libgit2) | Supported |
| Blame (via libgit2) | Supported |
| Commit history / revwalk (via libgit2) | Supported |
| REST API (35+ endpoints) | Supported |
| SSH transport | Supported |
| Server-side merge (ff + 3-way) | Supported |
| Cherry-pick / revert / reset | Supported |
| Shallow clone (`--depth`) | Planned |
| Git LFS | Planned (R2 backend) |
| Protocol v2 | Planned |

## Development

```bash
# Build WASM
pnpm run build:wasm

# Run Zig tests
pnpm run test:zig

# Run integration tests
pnpm run test

# Run performance benchmarks
./test/bench.sh

# Local dev server
pnpm run dev

# Deploy
pnpm run deploy
```

## Project structure

```
gitmode/
├── wasm/                    Zig WASM engine
│   ├── build.zig            wasm32-wasi + SIMD128
│   └── src/
│       ├── main.zig         Exported WASM functions
│       ├── sha1.zig         SHA-1 implementation
│       ├── object.zig       Git object format
│       ├── pack.zig         Packfile v2
│       ├── delta.zig        Delta compression
│       ├── zlib.zig         Inflate/deflate
│       ├── protocol.zig     pkt-line framing
│       ├── simd.zig         SIMD128 memory ops
│       └── libgit2.zig      libgit2 bindings (diff, blame, revwalk)
├── wasm/libgit2-wasm/       libgit2 compiled to WASM
│   ├── build.sh             Cross-compile with zig cc
│   ├── posix_shim.c         POSIX → R2 host imports
│   └── wasm_platform.c      WASM platform layer
├── deps/libgit2/            libgit2 source (submodule)
├── src/
│   ├── worker.ts            Worker entry point
│   ├── git-engine.ts        R2 + DO SQLite orchestration
│   ├── git-porcelain.ts     High-level git ops (merge, cherry-pick, stats)
│   ├── wasm-engine.ts       Typed WASM wrapper
│   ├── wasm-module.ts       WASM module loader
│   ├── repo-store.ts        Durable Object (per-repo SQLite)
│   ├── upload-pack.ts       Clone/fetch handler
│   ├── receive-pack.ts      Push handler + commit indexing
│   ├── checkout.ts          Worktree materialization (incremental + optimistic)
│   ├── info-refs.ts         Ref advertisement
│   ├── packfile-builder.ts  Assemble packfiles for clone/fetch
│   ├── packfile-reader.ts   Unpack received packfiles (batch R2 writes)
│   ├── pkt-line.ts          Git pkt-line protocol framing
│   ├── ssh-handler.ts       SSH command parser
│   ├── env.ts               Env type (R2 + DO bindings)
│   └── schema.sql           DO SQLite schema reference
├── app/                     vinext UI (React Server Components)
│   ├── layout.tsx           Root layout
│   ├── page.tsx             Landing / repo discovery
│   └── [owner]/[repo]/      Repo pages (overview, tree, blob, commits, etc.)
├── test/
│   ├── gitmode.test.ts      Integration tests (87 tests)
│   └── bench.sh             Performance benchmarks
├── research/                Dogfood reports and user interviews
├── wrangler.jsonc           Cloudflare bindings
└── package.json
```

## License

MIT
