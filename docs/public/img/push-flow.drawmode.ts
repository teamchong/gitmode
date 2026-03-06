
const d = new Diagram({ theme: "minimal", direction: "LR" });

// Push flow steps
const client = d.addBox("Git Client", { row: 0, col: 0, color: "users", icon: "user", width: 140 });
const worker = d.addBox("Worker", { row: 0, col: 1, color: "backend", icon: "cloud", width: 140 });
const phase1 = d.addBox("Phase 1\nCPU-only\nhash + compress", { row: 0, col: 2, color: "ai", icon: "⚡", width: 170 });
const phase2 = d.addBox("Phase 2\nBatch R2 PUTs\n(50 concurrent)", { row: 0, col: 3, color: "storage", icon: "database", width: 170 });
const refs = d.addBox("Update Refs\n+ Index Commits\n(DO SQLite)", { row: 0, col: 4, color: "database", icon: "lock", width: 170 });
const worktree = d.addBox("Worktree\nIncremental +\nOptimistic Cache", { row: 0, col: 5, color: "frontend", width: 170 });

d.connect(client, worker, "packfile");
d.connect(worker, phase1, "unpack");
d.connect(phase1, phase2, "objects");
d.connect(phase2, refs, "");
d.connect(refs, worktree, "in-memory\nobjects");

return d.render({ format: ["svg", "excalidraw"], path: "/Users/steven_chong/Downloads/repos/gitmode/docs/public/push-flow" });
