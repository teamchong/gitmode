// Git porcelain — high-level git operations for programmatic/agent use
//
// Built on top of GitEngine (R2 objects + DO SQLite refs).
// Covers all common git CLI operations without needing a git binary.

import { GitEngine, OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";
import { toHex } from "./hex";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ============================================================
// Types
// ============================================================

export interface FileEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTimestamp: number;
  committer: string;
  committerEmail: string;
  committerTimestamp: number;
  message: string;
}

export interface TagInfo {
  name: string;
  sha: string;
  type: "lightweight" | "annotated";
  target?: string;
  tagger?: string;
  message?: string;
}

export interface DiffEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldSha?: string;
  newSha?: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
  isHead: boolean;
}

export interface StatusEntry {
  path: string;
  status: "added" | "modified" | "deleted";
}

// ============================================================
// Tree parsing/building
// ============================================================

function parseTreeEntries(content: Uint8Array): Array<{ mode: string; name: string; sha: string }> {
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  let pos = 0;
  while (pos < content.length) {
    const spaceIdx = content.indexOf(0x20, pos);
    if (spaceIdx === -1) break;
    const mode = decoder.decode(content.subarray(pos, spaceIdx));
    const nullIdx = content.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) break;
    const name = decoder.decode(content.subarray(spaceIdx + 1, nullIdx));
    const shaBytes = content.subarray(nullIdx + 1, nullIdx + 21);
    const sha = toHex(shaBytes);
    entries.push({ mode, name, sha });
    pos = nullIdx + 21;
  }
  return entries;
}

function buildTreeContent(entries: Array<{ mode: string; name: string; sha: string }>): Uint8Array {
  // Sort: trees before blobs within same name, then by name
  // Git sorts tree entries by name with trailing / for directories
  const sorted = [...entries].sort((a, b) => {
    const aName = a.mode.startsWith("40") ? a.name + "/" : a.name;
    const bName = b.mode.startsWith("40") ? b.name + "/" : b.name;
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });

  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    const mode = encoder.encode(entry.mode);
    const name = encoder.encode(entry.name);
    const sha = hexToBytes(entry.sha);
    const buf = new Uint8Array(mode.length + 1 + name.length + 1 + 20);
    let offset = 0;
    buf.set(mode, offset); offset += mode.length;
    buf[offset++] = 0x20;
    buf.set(name, offset); offset += name.length;
    buf[offset++] = 0x00;
    buf.set(sha, offset);
    parts.push(buf);
  }
  return concatBytes(...parts);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ============================================================
// Commit parsing
// ============================================================

function parseCommit(sha: string, content: Uint8Array): CommitInfo {
  const text = decoder.decode(content);
  const headerEnd = text.indexOf("\n\n");
  const headers = text.slice(0, headerEnd).split("\n");
  const message = text.slice(headerEnd + 2);

  let tree = "";
  const parents: string[] = [];
  let author = "", authorEmail = "", authorTimestamp = 0;
  let committer = "", committerEmail = "", committerTimestamp = 0;

  for (const line of headers) {
    if (line.startsWith("tree ")) {
      tree = line.slice(5);
    } else if (line.startsWith("parent ")) {
      parents.push(line.slice(7));
    } else if (line.startsWith("author ")) {
      const m = line.match(/^author (.+?) <(.+?)> (\d+)/);
      if (m) { author = m[1]; authorEmail = m[2]; authorTimestamp = parseInt(m[3], 10); }
    } else if (line.startsWith("committer ")) {
      const m = line.match(/^committer (.+?) <(.+?)> (\d+)/);
      if (m) { committer = m[1]; committerEmail = m[2]; committerTimestamp = parseInt(m[3], 10); }
    }
  }

  return { sha, tree, parents, author, authorEmail, authorTimestamp, committer, committerEmail, committerTimestamp, message };
}

// ============================================================
// GitPorcelain
// ============================================================

export class GitPorcelain {
  constructor(private engine: GitEngine) {}

  // === init ===

  /** Initialize a new repository with default branch. */
  init(defaultBranch = "main"): void {
    this.engine.ensureRepo();
    const head = this.engine.getHead();
    if (!head) {
      this.engine.setHead(`ref: refs/heads/${defaultBranch}`);
    }
  }

  // === cat-file / show ===

  /** Read a file's content at a given ref (branch/tag/sha). */
  async catFile(ref: string, path: string): Promise<Uint8Array | null> {
    const commitSha = await this.resolveRef(ref);
    if (!commitSha) return null;

    const commit = await this.engine.readObject(commitSha);
    if (!commit || commit.type !== OBJ_COMMIT) return null;

    const info = parseCommit(commitSha, commit.content);
    return this.readPathFromTree(info.tree, path);
  }

  /** Read a raw object by sha. */
  async showObject(sha: string): Promise<{ type: number; content: Uint8Array } | null> {
    return this.engine.readObject(sha);
  }

  // === ls-tree / ls-files ===

  /** List files at a path in a given ref. */
  async listFiles(ref: string, path = ""): Promise<FileEntry[]> {
    const commitSha = await this.resolveRef(ref);
    if (!commitSha) return [];

    const commit = await this.engine.readObject(commitSha);
    if (!commit || commit.type !== OBJ_COMMIT) return [];

    const info = parseCommit(commitSha, commit.content);
    return this.listTreeEntries(info.tree, path);
  }

  /** Recursively list all files in a ref. */
  async listAllFiles(ref: string): Promise<FileEntry[]> {
    const commitSha = await this.resolveRef(ref);
    if (!commitSha) return [];

    const commit = await this.engine.readObject(commitSha);
    if (!commit || commit.type !== OBJ_COMMIT) return [];

    const info = parseCommit(commitSha, commit.content);
    return this.walkTree(info.tree, "");
  }

  // === commit ===

  /** Create a commit with file changes applied to a parent ref. */
  async commit(opts: {
    ref: string;
    message: string;
    author?: string;
    email?: string;
    files: Array<{ path: string; content: Uint8Array | string | null }>;
    timestamp?: number;
  }): Promise<string> {
    const author = opts.author || "unknown";
    const email = opts.email || "unknown@unknown";

    // Auto-init: ensure repo metadata and HEAD exist so first commit works
    // even without an explicit init call
    this.engine.ensureRepo();
    if (!this.engine.getHead()) {
      this.engine.setHead("ref: refs/heads/main");
    }

    const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);

    // Retry loop for optimistic concurrency — if the ref moved between
    // reading and writing, re-apply changes on top of the new parent
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const parentSha = await this.resolveRef(opts.ref);

      // Get base tree (or empty)
      let baseTreeSha: string | null = null;
      if (parentSha) {
        const commit = await this.engine.readObject(parentSha);
        if (commit && commit.type === OBJ_COMMIT) {
          baseTreeSha = parseCommit(parentSha, commit.content).tree;
        }
      }

      // Apply file changes to tree
      const newTreeSha = await this.applyChangesToTree(baseTreeSha, opts.files);

      // Build commit
      const lines: string[] = [`tree ${newTreeSha}`];
      if (parentSha) lines.push(`parent ${parentSha}`);
      lines.push(`author ${author} <${email}> ${ts} +0000`);
      lines.push(`committer ${author} <${email}> ${ts} +0000`);
      lines.push("");
      lines.push(opts.message.endsWith("\n") ? opts.message : opts.message + "\n");
      const commitSha = await this.engine.storeObject(OBJ_COMMIT, encoder.encode(lines.join("\n")));

      // Optimistic lock: verify ref hasn't moved since we read it
      const refName = this.refToStorageName(opts.ref);
      if (refName) {
        const currentSha = this.engine.getRef(refName);
        if (currentSha !== parentSha) {
          // Ref moved — retry with new parent
          continue;
        }
        this.engine.setRef(refName, commitSha);
      }

      // Index commit metadata
      this.engine.indexCommit(commitSha, `${author} <${email}>`, opts.message, ts);

      return commitSha;
    }

    throw new Error("Failed to commit: ref was concurrently modified (too many retries)");
  }

  // === branch ===

  /** Create a branch pointing at a ref. */
  async createBranch(name: string, startPoint?: string): Promise<string> {
    const sha = startPoint
      ? await this.resolveRef(startPoint)
      : await this.resolveRef("HEAD");
    if (!sha) throw new Error(`Cannot resolve start point for branch ${name}`);
    this.engine.setRef(`heads/${name}`, sha);
    return sha;
  }

  /** Delete a branch. */
  deleteBranch(name: string): void {
    const head = this.engine.getHead();
    if (head === `ref: refs/heads/${name}`) {
      throw new Error(`Cannot delete checked-out branch ${name}`);
    }
    this.engine.deleteRef(`heads/${name}`);
  }

  /** Rename a branch. */
  async renameBranch(oldName: string, newName: string): Promise<void> {
    const sha = this.engine.getRef(`heads/${oldName}`);
    if (!sha) throw new Error(`Branch ${oldName} not found`);
    this.engine.setRef(`heads/${newName}`, sha);
    this.engine.deleteRef(`heads/${oldName}`);
    // Update HEAD if it pointed to old branch
    const head = this.engine.getHead();
    if (head === `ref: refs/heads/${oldName}`) {
      this.engine.setHead(`ref: refs/heads/${newName}`);
    }
  }

  /** List all branches. */
  listBranches(): BranchInfo[] {
    const refs = this.engine.listRefs();
    const head = this.engine.getHead();
    const headBranch = head?.replace("ref: refs/heads/", "") ?? "";
    const branches: BranchInfo[] = [];
    for (const [name, sha] of refs) {
      if (name.startsWith("heads/")) {
        const branchName = name.slice(6);
        branches.push({ name: branchName, sha, isHead: branchName === headBranch });
      }
    }
    return branches.sort((a, b) => a.name.localeCompare(b.name));
  }

  // === checkout / switch ===

  /** Switch HEAD to a branch. */
  checkout(branch: string): void {
    const sha = this.engine.getRef(`heads/${branch}`);
    if (!sha) throw new Error(`Branch ${branch} not found`);
    this.engine.setHead(`ref: refs/heads/${branch}`);
  }

  /** Detach HEAD to a specific commit. */
  detachHead(sha: string): void {
    this.engine.setHead(sha);
  }

  // === tag ===

  /** Create a lightweight tag. */
  async createTag(name: string, target?: string): Promise<string> {
    const sha = target
      ? await this.resolveRef(target)
      : await this.resolveRef("HEAD");
    if (!sha) throw new Error(`Cannot resolve target for tag ${name}`);
    this.engine.setRef(`tags/${name}`, sha);
    return sha;
  }

  /** Create an annotated tag. */
  async createAnnotatedTag(opts: {
    name: string;
    target?: string;
    tagger: string;
    email: string;
    message: string;
    timestamp?: number;
  }): Promise<string> {
    const targetSha = opts.target
      ? await this.resolveRef(opts.target)
      : await this.resolveRef("HEAD");
    if (!targetSha) throw new Error(`Cannot resolve target for tag ${opts.name}`);

    const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const tagContent = [
      `object ${targetSha}`,
      "type commit",
      `tag ${opts.name}`,
      `tagger ${opts.tagger} <${opts.email}> ${ts} +0000`,
      "",
      opts.message.endsWith("\n") ? opts.message : opts.message + "\n",
    ].join("\n");
    const tagSha = await this.engine.storeObject(OBJ_TAG, encoder.encode(tagContent));
    this.engine.setRef(`tags/${opts.name}`, tagSha);
    return tagSha;
  }

  /** Delete a tag. */
  deleteTag(name: string): void {
    this.engine.deleteRef(`tags/${name}`);
  }

  /** List all tags. */
  async listTags(): Promise<TagInfo[]> {
    const refs = this.engine.listRefs();
    const tags: TagInfo[] = [];
    for (const [name, sha] of refs) {
      if (!name.startsWith("tags/")) continue;
      const tagName = name.slice(5);
      const obj = await this.engine.readObject(sha);
      if (obj && obj.type === OBJ_TAG) {
        const text = decoder.decode(obj.content);
        const targetMatch = text.match(/^object ([0-9a-f]{40})/m);
        const taggerMatch = text.match(/^tagger (.+?) <.+?>/m);
        const msgStart = text.indexOf("\n\n");
        tags.push({
          name: tagName, sha, type: "annotated",
          target: targetMatch?.[1],
          tagger: taggerMatch?.[1],
          message: msgStart >= 0 ? text.slice(msgStart + 2) : undefined,
        });
      } else {
        tags.push({ name: tagName, sha, type: "lightweight" });
      }
    }
    return tags.sort((a, b) => a.name.localeCompare(b.name));
  }

  // === log ===

  /** Walk commit history from a ref. */
  async log(ref: string, maxCount = 50): Promise<CommitInfo[]> {
    const startSha = await this.resolveRef(ref);
    if (!startSha) return [];

    const visited = new Set<string>();
    const queue = [startSha];
    const commits: CommitInfo[] = [];

    while (queue.length > 0 && commits.length < maxCount) {
      const sha = queue.shift()!;
      if (visited.has(sha)) continue;
      visited.add(sha);

      const obj = await this.engine.readObject(sha);
      if (!obj || obj.type !== OBJ_COMMIT) continue;

      const info = parseCommit(sha, obj.content);
      commits.push(info);
      queue.push(...info.parents);
    }

    return commits;
  }

  // === diff ===

  /** Diff two commits (or a commit against its parent). */
  async diff(refA: string, refB?: string): Promise<DiffEntry[]> {
    const shaA = await this.resolveRef(refA);
    if (!shaA) return [];

    let treeA: string;
    let treeB: string;

    if (refB) {
      const shaB = await this.resolveRef(refB);
      if (!shaB) return [];
      const commitA = await this.engine.readObject(shaA);
      const commitB = await this.engine.readObject(shaB);
      if (!commitA || !commitB) return [];
      treeA = parseCommit(shaA, commitA.content).tree;
      treeB = parseCommit(shaB, commitB.content).tree;
    } else {
      // Diff against parent
      const commit = await this.engine.readObject(shaA);
      if (!commit) return [];
      const info = parseCommit(shaA, commit.content);
      treeB = info.tree;
      if (info.parents.length > 0) {
        const parent = await this.engine.readObject(info.parents[0]);
        if (!parent) return [];
        treeA = parseCommit(info.parents[0], parent.content).tree;
      } else {
        treeA = ""; // empty tree (initial commit)
      }
    }

    return this.diffTrees(treeA, treeB, "");
  }

  // === merge (fast-forward) ===

  /** Fast-forward merge a source branch into target. Returns new HEAD sha or null if not FF. */
  async mergeFastForward(target: string, source: string): Promise<string | null> {
    const targetSha = await this.resolveRef(target);
    const sourceSha = await this.resolveRef(source);
    if (!sourceSha) throw new Error(`Cannot resolve source ${source}`);

    // Check if source is descendant of target (fast-forward possible)
    if (targetSha) {
      const isAncestor = await this.isAncestor(targetSha, sourceSha);
      if (!isAncestor) return null;
    }

    const refName = this.refToStorageName(target);
    if (refName) this.engine.setRef(refName, sourceSha);
    return sourceSha;
  }

  /** Three-way merge creating a merge commit. */
  async merge(opts: {
    target: string;
    source: string;
    author: string;
    email: string;
    message?: string;
    timestamp?: number;
  }): Promise<{ sha: string; strategy: "fast-forward" | "merge" }> {
    const targetSha = await this.resolveRef(opts.target);
    const sourceSha = await this.resolveRef(opts.source);
    if (!sourceSha) throw new Error(`Cannot resolve source ${opts.source}`);

    // Try fast-forward first
    if (targetSha) {
      const isAncestor = await this.isAncestor(targetSha, sourceSha);
      if (isAncestor) {
        const refName = this.refToStorageName(opts.target);
        if (refName) this.engine.setRef(refName, sourceSha);
        return { sha: sourceSha, strategy: "fast-forward" };
      }
    } else {
      // No target commit, just set ref
      const refName = this.refToStorageName(opts.target);
      if (refName) this.engine.setRef(refName, sourceSha);
      return { sha: sourceSha, strategy: "fast-forward" };
    }

    // Non-FF: find merge base and create merge commit
    const base = await this.findMergeBase(targetSha, sourceSha);

    // Get trees
    const targetCommit = await this.engine.readObject(targetSha);
    const sourceCommit = await this.engine.readObject(sourceSha);
    if (!targetCommit || !sourceCommit) throw new Error("Cannot read merge commits");

    const targetTree = parseCommit(targetSha, targetCommit.content).tree;
    const sourceTree = parseCommit(sourceSha, sourceCommit.content).tree;

    let baseTree = "";
    if (base) {
      const baseCommit = await this.engine.readObject(base);
      if (baseCommit) baseTree = parseCommit(base, baseCommit.content).tree;
    }

    // Three-way merge trees
    const mergedTree = await this.mergeTrees(baseTree, targetTree, sourceTree);

    // Create merge commit
    const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const msg = opts.message ?? `Merge ${opts.source} into ${opts.target}`;
    const lines = [
      `tree ${mergedTree}`,
      `parent ${targetSha}`,
      `parent ${sourceSha}`,
      `author ${opts.author} <${opts.email}> ${ts} +0000`,
      `committer ${opts.author} <${opts.email}> ${ts} +0000`,
      "",
      msg.endsWith("\n") ? msg : msg + "\n",
    ];
    const commitSha = await this.engine.storeObject(OBJ_COMMIT, encoder.encode(lines.join("\n")));
    const refName = this.refToStorageName(opts.target);
    if (refName) this.engine.setRef(refName, commitSha);

    return { sha: commitSha, strategy: "merge" };
  }

  // === rev-parse ===

  /** Resolve a ref name to a commit SHA. Supports branch names, tag names, HEAD, and raw SHAs. */
  async resolveRef(ref: string): Promise<string | null> {
    // Raw SHA
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;

    // HEAD
    if (ref === "HEAD") {
      const head = this.engine.getHead();
      if (!head) return null;
      if (head.startsWith("ref: ")) {
        const targetRef = head.slice(5).replace(/^refs\//, "");
        return this.engine.getRef(targetRef);
      }
      return head; // detached HEAD (raw sha)
    }

    // HEAD~N
    const tildeMatch = ref.match(/^(.+)~(\d+)$/);
    if (tildeMatch) {
      let sha = await this.resolveRef(tildeMatch[1]);
      let n = parseInt(tildeMatch[2], 10);
      while (sha && n > 0) {
        const obj = await this.engine.readObject(sha);
        if (!obj || obj.type !== OBJ_COMMIT) return null;
        const info = parseCommit(sha, obj.content);
        sha = info.parents[0] ?? null;
        n--;
      }
      return sha;
    }

    // HEAD^, ref^, ref^2
    const caretMatch = ref.match(/^(.+)\^(\d*)$/);
    if (caretMatch) {
      const sha = await this.resolveRef(caretMatch[1]);
      if (!sha) return null;
      const obj = await this.engine.readObject(sha);
      if (!obj || obj.type !== OBJ_COMMIT) return null;
      const info = parseCommit(sha, obj.content);
      const idx = caretMatch[2] ? parseInt(caretMatch[2], 10) - 1 : 0;
      return info.parents[idx] ?? null;
    }

    // Try as branch
    const branchSha = this.engine.getRef(`heads/${ref}`);
    if (branchSha) return branchSha;

    // Try as tag
    const tagSha = this.engine.getRef(`tags/${ref}`);
    if (tagSha) {
      // Peel annotated tags to commit
      const obj = await this.engine.readObject(tagSha);
      if (obj && obj.type === OBJ_TAG) {
        const text = decoder.decode(obj.content);
        const m = text.match(/^object ([0-9a-f]{40})/m);
        return m ? m[1] : tagSha;
      }
      return tagSha;
    }

    // Try as full ref
    const fullSha = this.engine.getRef(ref);
    if (fullSha) return fullSha;

    return null;
  }

  // === status ===

  /** Compare two commits and return changed files. */
  async status(ref: string, parentRef?: string): Promise<StatusEntry[]> {
    const entries = await this.diff(ref, parentRef);
    return entries.map(e => ({
      path: e.path,
      status: e.status === "renamed" ? "modified" : e.status,
    }));
  }

  // === commit detail ===

  /** Get structured commit data by SHA. */
  async getCommit(sha: string): Promise<CommitInfo | null> {
    const resolved = await this.resolveRef(sha);
    if (!resolved) return null;
    const obj = await this.engine.readObject(resolved);
    if (!obj || obj.type !== OBJ_COMMIT) return null;
    return parseCommit(resolved, obj.content);
  }

  // === file history ===

  /** Walk commit history, filtered to commits that touch a specific file path. */
  async fileLog(ref: string, path: string, maxCount = 50): Promise<CommitInfo[]> {
    const startSha = await this.resolveRef(ref);
    if (!startSha) return [];

    const visited = new Set<string>();
    const queue = [startSha];
    const commits: CommitInfo[] = [];

    while (queue.length > 0 && commits.length < maxCount) {
      const sha = queue.shift()!;
      if (visited.has(sha)) continue;
      visited.add(sha);

      const obj = await this.engine.readObject(sha);
      if (!obj || obj.type !== OBJ_COMMIT) continue;

      const info = parseCommit(sha, obj.content);

      // Check if this commit changed the file relative to its first parent
      const fileSha = await this.getFileShaInTree(info.tree, path);
      let parentFileSha: string | null = null;
      if (info.parents.length > 0) {
        const parentObj = await this.engine.readObject(info.parents[0]);
        if (parentObj && parentObj.type === OBJ_COMMIT) {
          const parentInfo = parseCommit(info.parents[0], parentObj.content);
          parentFileSha = await this.getFileShaInTree(parentInfo.tree, path);
        }
      }

      // Include if file was added, modified, or deleted in this commit
      if (fileSha !== parentFileSha) {
        commits.push(info);
      }

      queue.push(...info.parents);
    }

    return commits;
  }

  // === contributors ===

  /** Aggregate author statistics from the commit index. */
  contributors(): Array<{ name: string; commits: number; lastCommit: number }> {
    const sql = (this.engine as any).sql as SqlStorage;
    if (!sql) return [];
    const rows = [...sql.exec(
      `SELECT author, COUNT(*) as commits, MAX(timestamp) as lastCommit
       FROM commits GROUP BY author ORDER BY commits DESC`
    )];
    return rows.map(r => ({
      name: r.author as string,
      commits: r.commits as number,
      lastCommit: r.lastCommit as number,
    }));
  }

  // === repo stats ===

  /** Get repository statistics. */
  async stats(ref = "HEAD"): Promise<{
    commits: number;
    branches: number;
    tags: number;
    files: number;
    size: number;
  }> {
    // Walk the commit graph to get accurate count
    const allCommits = await this.log(ref, 10000);
    const branches = this.listBranches().length;
    const tags = (await this.listTags()).length;

    // Count files and total size — use SQLite cache, only hit R2 for misses
    const allFiles = await this.listAllFiles(ref);
    const allShas = allFiles.map(f => f.sha);
    const cached = this.engine.getFileSizes(allShas);

    let totalSize = 0;
    const uncached: Array<{ sha: string }> = [];

    for (const f of allFiles) {
      const size = cached.get(f.sha);
      if (size !== undefined) {
        totalSize += size;
      } else {
        uncached.push(f);
      }
    }

    // Fetch uncached sizes from R2 in parallel and cache them
    if (uncached.length > 0) {
      const reads = await Promise.all(
        uncached.map(f => this.engine.readObject(f.sha).then(obj => ({ sha: f.sha, size: obj?.content.length ?? 0 })))
      );
      for (const { sha, size } of reads) {
        totalSize += size;
        this.engine.indexFileSize(sha, size);
      }
    }

    return {
      commits: allCommits.length,
      branches,
      tags,
      files: allFiles.length,
      size: totalSize,
    };
  }

  // === cherry-pick ===

  /** Apply a commit's changes onto a target ref. */
  async cherryPick(opts: {
    commit: string;
    target: string;
    author: string;
    email: string;
    timestamp?: number;
  }): Promise<string> {
    const commitSha = await this.resolveRef(opts.commit);
    if (!commitSha) throw new Error(`Cannot resolve ${opts.commit}`);

    const commitObj = await this.engine.readObject(commitSha);
    if (!commitObj || commitObj.type !== OBJ_COMMIT) throw new Error("Not a commit");
    const commitInfo = parseCommit(commitSha, commitObj.content);

    const targetSha = await this.resolveRef(opts.target);
    if (!targetSha) throw new Error(`Cannot resolve target ${opts.target}`);

    const targetObj = await this.engine.readObject(targetSha);
    if (!targetObj || targetObj.type !== OBJ_COMMIT) throw new Error("Target is not a commit");
    const targetInfo = parseCommit(targetSha, targetObj.content);

    // Get parent tree of the cherry-picked commit
    let parentTree = "";
    if (commitInfo.parents.length > 0) {
      const parentObj = await this.engine.readObject(commitInfo.parents[0]);
      if (parentObj) parentTree = parseCommit(commitInfo.parents[0], parentObj.content).tree;
    }

    // Three-way merge: parent tree (base) + target tree (ours) + commit tree (theirs)
    const mergedTree = await this.mergeTrees(parentTree, targetInfo.tree, commitInfo.tree);

    const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const lines = [
      `tree ${mergedTree}`,
      `parent ${targetSha}`,
      `author ${commitInfo.author} <${commitInfo.authorEmail}> ${commitInfo.authorTimestamp} +0000`,
      `committer ${opts.author} <${opts.email}> ${ts} +0000`,
      "",
      commitInfo.message,
    ];
    const newSha = await this.engine.storeObject(OBJ_COMMIT, encoder.encode(lines.join("\n")));
    const refName = this.refToStorageName(opts.target);
    if (refName) this.engine.setRef(refName, newSha);

    return newSha;
  }

  // === revert ===

  /** Revert a commit by applying its inverse. */
  async revert(opts: {
    commit: string;
    target: string;
    author: string;
    email: string;
    timestamp?: number;
  }): Promise<string> {
    const commitSha = await this.resolveRef(opts.commit);
    if (!commitSha) throw new Error(`Cannot resolve ${opts.commit}`);

    const commitObj = await this.engine.readObject(commitSha);
    if (!commitObj || commitObj.type !== OBJ_COMMIT) throw new Error("Not a commit");
    const commitInfo = parseCommit(commitSha, commitObj.content);

    if (commitInfo.parents.length === 0) throw new Error("Cannot revert initial commit");

    const targetSha = await this.resolveRef(opts.target);
    if (!targetSha) throw new Error(`Cannot resolve target ${opts.target}`);

    const targetObj = await this.engine.readObject(targetSha);
    if (!targetObj || targetObj.type !== OBJ_COMMIT) throw new Error("Target is not a commit");
    const targetInfo = parseCommit(targetSha, targetObj.content);

    // Revert = three-way merge with commit tree as base, parent tree as theirs
    const parentObj = await this.engine.readObject(commitInfo.parents[0]);
    if (!parentObj) throw new Error("Cannot read parent commit");
    const parentTree = parseCommit(commitInfo.parents[0], parentObj.content).tree;

    const mergedTree = await this.mergeTrees(commitInfo.tree, targetInfo.tree, parentTree);

    const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const msg = `Revert "${commitInfo.message.split("\n")[0]}"`;
    const lines = [
      `tree ${mergedTree}`,
      `parent ${targetSha}`,
      `author ${opts.author} <${opts.email}> ${ts} +0000`,
      `committer ${opts.author} <${opts.email}> ${ts} +0000`,
      "",
      msg + "\n",
    ];
    const newSha = await this.engine.storeObject(OBJ_COMMIT, encoder.encode(lines.join("\n")));
    const refName = this.refToStorageName(opts.target);
    if (refName) this.engine.setRef(refName, newSha);

    return newSha;
  }

  // === reset ===

  /** Move a branch ref to a different commit. */
  async reset(ref: string, targetSha: string): Promise<void> {
    const resolved = await this.resolveRef(targetSha);
    if (!resolved) throw new Error(`Cannot resolve ${targetSha}`);
    const refName = this.refToStorageName(ref);
    if (refName) this.engine.setRef(refName, resolved);
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  private refToStorageName(ref: string): string | null {
    if (ref === "HEAD") {
      const head = this.engine.getHead();
      if (!head) return null;
      if (head.startsWith("ref: ")) return head.slice(5).replace(/^refs\//, "");
      return null; // detached HEAD
    }
    if (ref.startsWith("refs/")) return ref.slice(5);
    // Assume branch name
    if (this.engine.getRef(`heads/${ref}`)) return `heads/${ref}`;
    if (this.engine.getRef(`tags/${ref}`)) return `tags/${ref}`;
    return `heads/${ref}`;
  }

  /** Get the SHA of a file at a path in a tree, or null if not present. */
  private async getFileShaInTree(treeSha: string, path: string): Promise<string | null> {
    const parts = path.split("/").filter(Boolean);
    let currentTree = treeSha;

    for (let i = 0; i < parts.length; i++) {
      const obj = await this.engine.readObject(currentTree);
      if (!obj || obj.type !== OBJ_TREE) return null;

      const entries = parseTreeEntries(obj.content);
      const entry = entries.find(e => e.name === parts[i]);
      if (!entry) return null;

      if (i === parts.length - 1) return entry.sha;
      currentTree = entry.sha;
    }
    return null;
  }

  private async readPathFromTree(treeSha: string, path: string): Promise<Uint8Array | null> {
    const parts = path.split("/").filter(Boolean);
    let currentTree = treeSha;

    for (let i = 0; i < parts.length; i++) {
      const obj = await this.engine.readObject(currentTree);
      if (!obj || obj.type !== OBJ_TREE) return null;

      const entries = parseTreeEntries(obj.content);
      const entry = entries.find(e => e.name === parts[i]);
      if (!entry) return null;

      if (i === parts.length - 1) {
        // Last part — read blob
        const blob = await this.engine.readObject(entry.sha);
        return blob?.content ?? null;
      } else {
        // Intermediate — descend into subtree
        currentTree = entry.sha;
      }
    }
    return null;
  }

  private async listTreeEntries(treeSha: string, path: string): Promise<FileEntry[]> {
    let currentTree = treeSha;

    if (path) {
      const parts = path.split("/").filter(Boolean);
      for (const part of parts) {
        const obj = await this.engine.readObject(currentTree);
        if (!obj || obj.type !== OBJ_TREE) return [];
        const entries = parseTreeEntries(obj.content);
        const entry = entries.find(e => e.name === part);
        if (!entry || !entry.mode.startsWith("40")) return [];
        currentTree = entry.sha;
      }
    }

    const obj = await this.engine.readObject(currentTree);
    if (!obj || obj.type !== OBJ_TREE) return [];
    const entries = parseTreeEntries(obj.content);

    return entries.map(e => ({
      path: path ? `${path}/${e.name}` : e.name,
      mode: e.mode,
      type: e.mode.startsWith("40") ? "tree" as const : "blob" as const,
      sha: e.sha,
    }));
  }

  private async walkTree(treeSha: string, prefix: string): Promise<FileEntry[]> {
    const obj = await this.engine.readObject(treeSha);
    if (!obj || obj.type !== OBJ_TREE) return [];
    const entries = parseTreeEntries(obj.content);
    const result: FileEntry[] = [];

    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode.startsWith("40")) {
        const children = await this.walkTree(entry.sha, fullPath);
        result.push(...children);
      } else {
        result.push({ path: fullPath, mode: entry.mode, type: "blob", sha: entry.sha });
      }
    }
    return result;
  }

  private async applyChangesToTree(
    baseTreeSha: string | null,
    files: Array<{ path: string; content: Uint8Array | string | null }>
  ): Promise<string> {
    // Group changes by top-level directory
    const directChanges: Array<{ name: string; content: Uint8Array | string | null }> = [];
    const subdirChanges = new Map<string, Array<{ path: string; content: Uint8Array | string | null }>>();

    for (const file of files) {
      const slashIdx = file.path.indexOf("/");
      if (slashIdx === -1) {
        directChanges.push({ name: file.path, content: file.content });
      } else {
        const dir = file.path.slice(0, slashIdx);
        const rest = file.path.slice(slashIdx + 1);
        if (!subdirChanges.has(dir)) subdirChanges.set(dir, []);
        subdirChanges.get(dir)!.push({ path: rest, content: file.content });
      }
    }

    // Read existing tree
    let existingEntries: Array<{ mode: string; name: string; sha: string }> = [];
    if (baseTreeSha) {
      const obj = await this.engine.readObject(baseTreeSha);
      if (obj && obj.type === OBJ_TREE) {
        existingEntries = parseTreeEntries(obj.content);
      }
    }

    // Apply direct file changes
    const changedNames = new Set(directChanges.map(c => c.name));
    const subdirNames = new Set(subdirChanges.keys());
    const newEntries: Array<{ mode: string; name: string; sha: string }> = [];

    // Keep existing entries not being modified
    for (const entry of existingEntries) {
      if (changedNames.has(entry.name)) continue;
      if (subdirNames.has(entry.name)) continue;
      newEntries.push(entry);
    }

    // Add/update direct files
    for (const change of directChanges) {
      if (change.content === null) continue; // deletion
      const content = typeof change.content === "string"
        ? encoder.encode(change.content)
        : change.content;
      const sha = await this.engine.storeObject(OBJ_BLOB, content);
      newEntries.push({ mode: "100644", name: change.name, sha });
    }

    // Recursively handle subdirectories
    for (const [dir, subFiles] of subdirChanges) {
      const existing = existingEntries.find(e => e.name === dir && e.mode.startsWith("40"));
      const subTreeSha = await this.applyChangesToTree(existing?.sha ?? null, subFiles);

      // Check if subtree is empty (all files deleted)
      const subObj = await this.engine.readObject(subTreeSha);
      if (subObj && subObj.type === OBJ_TREE && subObj.content.length > 0) {
        newEntries.push({ mode: "40000", name: dir, sha: subTreeSha });
      }
    }

    // Build and store new tree
    const treeContent = buildTreeContent(newEntries);
    return this.engine.storeObject(OBJ_TREE, treeContent);
  }

  private async diffTrees(treeASha: string, treeBSha: string, prefix: string): Promise<DiffEntry[]> {
    const entriesA = treeASha ? await this.readTreeMap(treeASha) : new Map();
    const entriesB = treeBSha ? await this.readTreeMap(treeBSha) : new Map();
    const result: DiffEntry[] = [];
    const allNames = new Set([...entriesA.keys(), ...entriesB.keys()]);

    for (const name of allNames) {
      const a = entriesA.get(name);
      const b = entriesB.get(name);
      const fullPath = prefix ? `${prefix}/${name}` : name;

      if (!a && b) {
        if (b.mode.startsWith("40")) {
          result.push(...await this.diffTrees("", b.sha, fullPath));
        } else {
          result.push({ path: fullPath, status: "added", newSha: b.sha });
        }
      } else if (a && !b) {
        if (a.mode.startsWith("40")) {
          result.push(...await this.diffTrees(a.sha, "", fullPath));
        } else {
          result.push({ path: fullPath, status: "deleted", oldSha: a.sha });
        }
      } else if (a && b && a.sha !== b.sha) {
        if (a.mode.startsWith("40") && b.mode.startsWith("40")) {
          result.push(...await this.diffTrees(a.sha, b.sha, fullPath));
        } else {
          result.push({ path: fullPath, status: "modified", oldSha: a.sha, newSha: b.sha });
        }
      }
    }

    return result;
  }

  private async readTreeMap(treeSha: string): Promise<Map<string, { mode: string; sha: string }>> {
    const map = new Map<string, { mode: string; sha: string }>();
    if (!treeSha) return map;
    const obj = await this.engine.readObject(treeSha);
    if (!obj || obj.type !== OBJ_TREE) return map;
    for (const entry of parseTreeEntries(obj.content)) {
      map.set(entry.name, { mode: entry.mode, sha: entry.sha });
    }
    return map;
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const visited = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (sha === ancestor) return true;
      if (visited.has(sha)) continue;
      visited.add(sha);
      const obj = await this.engine.readObject(sha);
      if (!obj || obj.type !== OBJ_COMMIT) continue;
      const info = parseCommit(sha, obj.content);
      queue.push(...info.parents);
    }
    return false;
  }

  private async findMergeBase(a: string, b: string): Promise<string | null> {
    // BFS from both sides, first intersection is the merge base
    const visitedA = new Set<string>();
    const visitedB = new Set<string>();
    const queueA = [a];
    const queueB = [b];

    while (queueA.length > 0 || queueB.length > 0) {
      if (queueA.length > 0) {
        const sha = queueA.shift()!;
        if (visitedB.has(sha)) return sha;
        if (!visitedA.has(sha)) {
          visitedA.add(sha);
          const obj = await this.engine.readObject(sha);
          if (obj && obj.type === OBJ_COMMIT) {
            queueA.push(...parseCommit(sha, obj.content).parents);
          }
        }
      }
      if (queueB.length > 0) {
        const sha = queueB.shift()!;
        if (visitedA.has(sha)) return sha;
        if (!visitedB.has(sha)) {
          visitedB.add(sha);
          const obj = await this.engine.readObject(sha);
          if (obj && obj.type === OBJ_COMMIT) {
            queueB.push(...parseCommit(sha, obj.content).parents);
          }
        }
      }
    }
    return null;
  }

  private async mergeTrees(baseSha: string, oursSha: string, theirsSha: string): Promise<string> {
    const baseEntries = baseSha ? await this.readTreeMap(baseSha) : new Map();
    const oursEntries = oursSha ? await this.readTreeMap(oursSha) : new Map();
    const theirsEntries = theirsSha ? await this.readTreeMap(theirsSha) : new Map();
    const allNames = new Set([...baseEntries.keys(), ...oursEntries.keys(), ...theirsEntries.keys()]);
    const result: Array<{ mode: string; name: string; sha: string }> = [];

    for (const name of allNames) {
      const base = baseEntries.get(name);
      const ours = oursEntries.get(name);
      const theirs = theirsEntries.get(name);

      // Both modified same way — no conflict
      if (ours?.sha === theirs?.sha) {
        if (ours) result.push({ mode: ours.mode, name, sha: ours.sha });
        continue;
      }

      // Only one side changed from base
      if (base?.sha === ours?.sha && (theirs || (!theirs && base))) {
        // Theirs changed (or deleted), ours didn't
        if (!theirs) {
          // Theirs deleted the entry — remove it
          continue;
        }
        if (theirs.mode.startsWith("40") && (ours?.mode.startsWith("40") || !ours)) {
          const mergedSub = await this.mergeTrees(base?.sha ?? "", ours?.sha ?? "", theirs.sha);
          result.push({ mode: "40000", name, sha: mergedSub });
        } else {
          result.push({ mode: theirs.mode, name, sha: theirs.sha });
        }
        continue;
      }
      if (base?.sha === theirs?.sha && (ours || (!ours && base))) {
        // Ours changed (or deleted), theirs didn't
        if (!ours) {
          // Ours deleted the entry — remove it
          continue;
        }
        if (ours.mode.startsWith("40") && (theirs?.mode.startsWith("40") || !theirs)) {
          const mergedSub = await this.mergeTrees(base?.sha ?? "", ours.sha, theirs?.sha ?? "");
          result.push({ mode: "40000", name, sha: mergedSub });
        } else {
          result.push({ mode: ours.mode, name, sha: ours.sha });
        }
        continue;
      }

      // Both sides deleted
      if (!ours && !theirs) continue;

      // Both sides modified differently from base
      // For directories: recurse to merge contents
      if (ours && theirs && ours.mode.startsWith("40") && theirs.mode.startsWith("40")) {
        const mergedSub = await this.mergeTrees(base?.sha ?? "", ours.sha, theirs.sha);
        result.push({ mode: "40000", name, sha: mergedSub });
        continue;
      }

      // Conflict on files: take theirs (agent-friendly default)
      if (theirs) {
        result.push({ mode: theirs.mode, name, sha: theirs.sha });
      } else if (ours) {
        result.push({ mode: ours.mode, name, sha: ours.sha });
      }
    }

    const treeContent = buildTreeContent(result);
    return this.engine.storeObject(OBJ_TREE, treeContent);
  }
}
