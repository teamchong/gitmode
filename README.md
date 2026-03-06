# gitmode

> **⚠️ Experimental** — This project is a proof-of-concept and under active development. APIs, storage layout, and functionality may change without notice. Not recommended for production use.

Git server running entirely on Cloudflare Workers. No VMs, no servers — just Workers + R2 + KV + D1.

The git protocol engine is written in Zig, compiled to WASM with SIMD128 acceleration for SHA-1 hashing, delta compression, and packfile operations. libgit2 is statically linked for advanced operations (diff, blame, revwalk).

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/user/gitmode)

## Deploy your own

### One-click deploy

Click the button above to:
1. Fork this repo to your GitHub
2. Connect your Cloudflare account
3. Auto-provision R2 bucket, KV namespace, D1 database
4. Deploy the Worker

### Manual deploy

```bash
git clone https://github.com/user/gitmode.git
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

```
git client ──HTTPS──> Cloudflare Worker (TypeScript router)
                           │
                           ▼
                      Zig WASM Engine (1.2MB)
                      ├─ SHA-1 hashing (SIMD128)
                      ├─ Packfile encode/decode
                      ├─ Delta compression (SIMD matching)
                      ├─ Zlib inflate/deflate
                      ├─ Git object serialization
                      └─ libgit2 (diff, blame, revwalk)
                           │
                    ┌──────┼──────────┐
                    ▼      ▼          ▼
                   R2     KV         D1
                objects  refs     metadata
```

### Storage

| Data | Storage | Why |
|------|---------|-----|
| Git objects (blobs, trees, commits) | R2 | Unlimited size, $0.015/GB/mo, content-addressed |
| Refs (branches, tags, HEAD) | KV | <10ms global reads, perfect for `git ls-remote` |
| Metadata (repos, commits, permissions) | D1 | SQL queries: search commits, list repos |
| Push locks | Durable Objects | Per-repo mutex for atomic ref updates |

### Why Zig WASM

Git's hot paths are CPU-bound binary operations — SHA-1 hashing, zlib decompression, delta patching, packfile assembly. Zig compiled to WASM with SIMD128 handles these 10-50x faster than JavaScript:

- **SHA-1**: Every object read/write hashes. SIMD-accelerated rounds.
- **Delta compression**: SIMD memcmp for finding copy regions in base objects.
- **Packfile parsing**: Binary protocol with varint encoding — Zig's type system maps 1:1.
- **Memory**: Fixed 32MB arena allocator. No GC pauses during large pushes.

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
| Shallow clone (`--depth`) | Planned |
| SSH transport | Planned |
| Git LFS | Planned (R2 backend) |
| Protocol v2 | Planned |

## Development

```bash
# Build WASM
pnpm run build:wasm

# Run Zig tests
pnpm run test:zig

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
│   ├── posix_shim.c         POSIX → R2/KV host imports
│   └── wasm_platform.c      WASM platform layer
├── deps/libgit2/            libgit2 source (submodule)
├── src/
│   ├── worker.ts            Worker entry point
│   ├── git-engine.ts        R2 + KV + D1 orchestration
│   ├── wasm-engine.ts       Typed WASM wrapper
│   ├── upload-pack.ts       Clone/fetch handler
│   ├── receive-pack.ts      Push handler
│   ├── info-refs.ts         Ref advertisement
│   ├── packfile-builder.ts  Assemble packfiles
│   ├── packfile-reader.ts   Unpack received packfiles
│   ├── repo-lock.ts         Durable Object mutex
│   ├── ssh-handler.ts       SSH transport
│   └── schema.sql           D1 database schema
├── wrangler.toml            Cloudflare bindings
└── package.json
```

## License

MIT
