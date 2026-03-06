
const d = new Diagram({ theme: "minimal" });

// Row 0: Git Client
const client = d.addBox("Git Client\n(git CLI / SSH)", { row: 0, col: 2, color: "users", icon: "user" });

// Row 1: Cloudflare Worker layer
const worker = d.addBox("Cloudflare Worker\n(TypeScript)", { row: 1, col: 2, color: "backend", icon: "cloud", width: 240 });

// Row 2: Handler modules
const infoRefs = d.addBox("info-refs", { row: 2, col: 0, color: "backend", width: 160 });
const uploadPack = d.addBox("upload-pack\n(clone/fetch)", { row: 2, col: 2, color: "backend", width: 180 });
const receivePack = d.addBox("receive-pack\n(push)", { row: 2, col: 4, color: "backend", width: 180 });

// Row 3: WASM Engine
const wasm = d.addBox("Zig WASM Engine (791KB)\nSHA-1 · zlib · packfile · delta\nlibgit2 (diff, blame, revwalk)", { row: 3, col: 2, color: "ai", icon: "⚡", width: 380 });

// Row 4: Storage
const r2 = d.addBox("R2\nGit Objects +\nWorktree Files", { row: 4, col: 1, color: "storage", icon: "database", width: 180 });
const doSqlite = d.addBox("Durable Objects\n(per-repo SQLite)\nRefs · Commits · Metadata", { row: 4, col: 3, color: "database", icon: "lock", width: 240 });

// Row 5: vinext UI
const ui = d.addBox("vinext UI\n(React Server Components)\nRepo browser · Commits · Files", { row: 5, col: 2, color: "frontend", width: 340 });

// Connections
d.connect(client, worker, "HTTPS / SSH");
d.connect(worker, infoRefs, "GET refs", { style: "dashed" });
d.connect(worker, uploadPack, "POST");
d.connect(worker, receivePack, "POST");
d.connect(infoRefs, wasm, "", { style: "dashed" });
d.connect(uploadPack, wasm, "pack build");
d.connect(receivePack, wasm, "pack unpack");
d.connect(wasm, r2, "read/write objects", { elbowed: true });
d.connect(wasm, doSqlite, "refs + metadata", { elbowed: true });
d.connect(ui, r2, "read worktree", { style: "dashed" });
d.connect(ui, doSqlite, "read commits/refs", { style: "dashed" });

// Groups
d.addGroup("Handlers", [infoRefs, uploadPack, receivePack]);
d.addGroup("Storage", [r2, doSqlite]);

return d.render({ format: ["svg", "excalidraw"], path: "/Users/steven_chong/Downloads/repos/gitmode/docs/public/architecture" });
