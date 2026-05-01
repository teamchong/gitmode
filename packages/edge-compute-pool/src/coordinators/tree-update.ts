// Tree-update coordinator: produce a new root tree (and all the
// intermediate trees on the path) for adding, replacing, or deleting a
// single path. Pure data flow over an injected loader/hasher pair —
// keeps this composable with any storage backend (R2, in-memory tests,
// future caching layers).
//
// Returns the new root tree sha plus every new object (blob + trees)
// the caller needs to push.

import {
  parseTreeBytes,
  encodeTreeBytes,
  withEntry,
  withoutEntry,
  type TreeEntry,
} from "../protocol/tree-bytes";
import { OBJ_BLOB, OBJ_TREE } from "../pack-format";

const DIR_MODE = "040000";

export interface NewObject {
  sha: string;
  /** OBJ_BLOB or OBJ_TREE — never OBJ_COMMIT (the caller adds that). */
  type: number;
  content: Uint8Array;
}

export type TreeLoader = (sha: string) => Promise<Uint8Array | null>;
/** Hasher must compute the canonical git SHA-1: sha1(`<type> <size>\0<content>`). */
export type ObjectHasher = (type: number, content: Uint8Array) => Promise<string>;

export interface ApplyChangeOptions {
  /** Root tree SHA to start from, or null for an empty repo. */
  baseTreeSha: string | null;
  /** Slash-split path components, e.g. ["src", "foo.ts"]. Must be non-empty. */
  pathParts: string[];
  /** The new file mode + bytes, or null to delete the path. */
  newBlob: { mode: string; content: Uint8Array } | null;
  /** Resolves an existing tree sha to its body bytes. */
  loader: TreeLoader;
  /** Computes a git SHA-1 for new objects. */
  hasher: ObjectHasher;
}

export interface ApplyChangeResult {
  newRootSha: string;
  /** All new blobs + trees that need to be in the push pack. */
  newObjects: NewObject[];
}

/**
 * Apply a single-path change (add/replace/delete) and return the new
 * root tree sha + every new object that needs to be pushed.
 */
export async function applyTreeChange(opts: ApplyChangeOptions): Promise<ApplyChangeResult> {
  const { baseTreeSha, pathParts, newBlob, loader, hasher } = opts;
  if (pathParts.length === 0) {
    throw new Error("applyTreeChange: pathParts must be non-empty");
  }

  const newObjects: NewObject[] = [];

  // Resolve the base entries at the root.
  const baseEntries = await loadEntries(baseTreeSha, loader);

  // For a delete on a path that doesn't exist, this is a no-op.
  if (!newBlob && !pathExists(baseEntries, pathParts, loader)) {
    if (baseTreeSha) {
      return { newRootSha: baseTreeSha, newObjects: [] };
    }
  }

  const newRootSha = await mutateRecursive(baseEntries, pathParts, newBlob, loader, hasher, newObjects);
  return { newRootSha, newObjects };
}

async function loadEntries(sha: string | null, loader: TreeLoader): Promise<TreeEntry[]> {
  if (!sha) return [];
  const body = await loader(sha);
  if (!body) throw new Error(`applyTreeChange: missing tree object ${sha}`);
  return parseTreeBytes(body);
}

async function pathExists(
  rootEntries: TreeEntry[],
  pathParts: string[],
  loader: TreeLoader,
): Promise<boolean> {
  let entries = rootEntries;
  for (let i = 0; i < pathParts.length; i++) {
    const name = pathParts[i]!;
    const entry = entries.find((e) => e.name === name);
    if (!entry) return false;
    if (i === pathParts.length - 1) return true;
    if (entry.mode !== DIR_MODE) return false;
    entries = await loadEntries(entry.sha, loader);
  }
  return false;
}

async function mutateRecursive(
  entries: TreeEntry[],
  pathParts: string[],
  newBlob: { mode: string; content: Uint8Array } | null,
  loader: TreeLoader,
  hasher: ObjectHasher,
  acc: NewObject[],
): Promise<string> {
  const name = pathParts[0]!;

  if (pathParts.length === 1) {
    // Leaf operation.
    let nextEntries: TreeEntry[];
    if (newBlob) {
      // Hash the blob and stage it.
      const blobSha = await hasher(OBJ_BLOB, newBlob.content);
      acc.push({ sha: blobSha, type: OBJ_BLOB, content: newBlob.content });
      nextEntries = withEntry(entries, { mode: newBlob.mode, name, sha: blobSha });
    } else {
      nextEntries = withoutEntry(entries, name);
    }
    return await persistTree(nextEntries, hasher, acc);
  }

  // Descend into a subdirectory (creating it if absent).
  const child = entries.find((e) => e.name === name);
  let childEntries: TreeEntry[] = [];
  if (child) {
    if (child.mode !== DIR_MODE) {
      // Path conflict: trying to traverse through a file.
      throw new Error(
        `applyTreeChange: path traverses through a file (${name} is a ${child.mode}, not a directory)`,
      );
    }
    childEntries = await loadEntries(child.sha, loader);
  }

  const newChildSha = await mutateRecursive(
    childEntries,
    pathParts.slice(1),
    newBlob,
    loader,
    hasher,
    acc,
  );

  // If the descended subtree is now empty (all paths deleted), drop the
  // entry from this level rather than keeping a pointer to an empty tree.
  const childObj = acc[acc.length - 1];
  let nextEntries: TreeEntry[];
  if (childObj && childObj.sha === newChildSha && childObj.type === OBJ_TREE && childObj.content.length === 0) {
    nextEntries = withoutEntry(entries, name);
  } else {
    nextEntries = withEntry(entries, { mode: DIR_MODE, name, sha: newChildSha });
  }
  return await persistTree(nextEntries, hasher, acc);
}

async function persistTree(
  entries: TreeEntry[],
  hasher: ObjectHasher,
  acc: NewObject[],
): Promise<string> {
  const body = encodeTreeBytes(entries);
  const sha = await hasher(OBJ_TREE, body);
  acc.push({ sha, type: OBJ_TREE, content: body });
  return sha;
}
