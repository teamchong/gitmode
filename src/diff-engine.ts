// diff-engine.ts — Myers diff algorithm for git blob content
//
// Computes unified diffs between two text buffers. Used by both
// the coordinator (local diff) and compute workers (fan-out diff).
//
// Returns a compact unified diff string, similar to `git diff --unified=3`.

/**
 * Compute a unified diff between two text strings.
 * Returns empty string if content is identical.
 */
export function unifiedDiff(
  oldContent: string,
  newContent: string,
  oldPath: string,
  newPath: string,
  contextLines = 3,
): string {
  if (oldContent === newContent) return "";

  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const edits = myersDiff(oldLines, newLines);
  const hunks = buildHunks(edits, oldLines, newLines, contextLines);

  if (hunks.length === 0) return "";

  const parts: string[] = [];
  parts.push(`--- a/${oldPath}`);
  parts.push(`+++ b/${newPath}`);

  for (const hunk of hunks) {
    parts.push(hunk);
  }

  return parts.join("\n") + "\n";
}

/** Binary detection: null byte in first 8KB. */
export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8192).includes(0x00);
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  // Split preserving line content (without terminators)
  return text.split("\n");
}

// Myers diff — O(ND) algorithm for computing shortest edit script
// Returns an array of edit operations.

const EDIT_EQUAL = 0;
const EDIT_DELETE = 1;
const EDIT_INSERT = 2;

interface Edit {
  type: number;
  oldIdx: number;
  newIdx: number;
}

function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
  const N = oldLines.length;
  const M = newLines.length;

  if (N === 0 && M === 0) return [];
  if (N === 0) {
    return newLines.map((_, i) => ({ type: EDIT_INSERT, oldIdx: 0, newIdx: i }));
  }
  if (M === 0) {
    return oldLines.map((_, i) => ({ type: EDIT_DELETE, oldIdx: i, newIdx: 0 }));
  }

  // For very large files, fall back to a simple LCS approach
  const MAX = N + M;
  if (MAX > 20000) {
    return simpleDiff(oldLines, newLines);
  }

  // Forward Myers diff
  const size = 2 * MAX + 1;
  const v = new Int32Array(size);
  v.fill(-1);
  const offset = MAX;
  v[offset + 1] = 0;

  const trace: Int32Array[] = [];

  outer:
  for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;

      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      v[offset + k] = x;
      if (x >= N && y >= M) break outer;
    }
  }

  // Backtrack to build edit script
  return backtrack(trace, offset, oldLines, newLines);
}

function backtrack(
  trace: Int32Array[],
  offset: number,
  oldLines: string[],
  newLines: string[],
): Edit[] {
  const edits: Edit[] = [];
  let x = oldLines.length;
  let y = newLines.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;

    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;

    // Diagonal (equal lines)
    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push({ type: EDIT_EQUAL, oldIdx: x, newIdx: y });
    }

    if (d > 0) {
      if (x === prevX) {
        // Insert
        y--;
        edits.push({ type: EDIT_INSERT, oldIdx: x, newIdx: y });
      } else {
        // Delete
        x--;
        edits.push({ type: EDIT_DELETE, oldIdx: x, newIdx: y });
      }
    }
  }

  edits.reverse();
  return edits;
}

/** Simple O(NM) fallback for very large files. */
function simpleDiff(oldLines: string[], newLines: string[]): Edit[] {
  const edits: Edit[] = [];

  // Find common prefix
  let prefixLen = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    edits.push({ type: EDIT_EQUAL, oldIdx: prefixLen, newIdx: prefixLen });
    prefixLen++;
  }

  // Find common suffix
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Middle section: all deletes then all inserts
  for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
    edits.push({ type: EDIT_DELETE, oldIdx: i, newIdx: prefixLen });
  }
  for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
    edits.push({ type: EDIT_INSERT, oldIdx: oldLines.length - suffixLen, newIdx: i });
  }

  // Common suffix
  for (let i = 0; i < suffixLen; i++) {
    const oi = oldLines.length - suffixLen + i;
    const ni = newLines.length - suffixLen + i;
    edits.push({ type: EDIT_EQUAL, oldIdx: oi, newIdx: ni });
  }

  return edits;
}

function buildHunks(
  edits: Edit[],
  oldLines: string[],
  newLines: string[],
  context: number,
): string[] {
  if (edits.length === 0) return [];

  // Group edits into hunks with context
  const changes: Array<{ edit: Edit; line: string }> = [];
  for (const edit of edits) {
    if (edit.type === EDIT_EQUAL) {
      changes.push({ edit, line: oldLines[edit.oldIdx] });
    } else if (edit.type === EDIT_DELETE) {
      changes.push({ edit, line: oldLines[edit.oldIdx] });
    } else {
      changes.push({ edit, line: newLines[edit.newIdx] });
    }
  }

  // Find runs of non-equal edits, extend by context
  const hunks: string[] = [];
  let i = 0;

  while (i < changes.length) {
    // Skip to next non-equal
    while (i < changes.length && changes[i].edit.type === EDIT_EQUAL) i++;
    if (i >= changes.length) break;

    // Start of hunk: back up by context
    let start = i;
    for (let c = 0; c < context && start > 0; c++) {
      start--;
    }

    // Find end of change cluster (merge hunks that are close)
    let end = i;
    while (end < changes.length) {
      if (changes[end].edit.type !== EDIT_EQUAL) {
        end++;
        continue;
      }
      // Count consecutive equals
      let eqRun = 0;
      let j = end;
      while (j < changes.length && changes[j].edit.type === EDIT_EQUAL) {
        eqRun++;
        j++;
      }
      if (eqRun > context * 2 || j >= changes.length) {
        // End the hunk
        end = Math.min(end + context, changes.length);
        break;
      }
      // Merge — continue through the equal run
      end = j;
    }

    // Build hunk header and lines
    let oldStart = start < changes.length ? changes[start].edit.oldIdx + 1 : 1;
    let oldCount = 0;
    let newStart = start < changes.length
      ? (changes[start].edit.type === EDIT_INSERT ? changes[start].edit.newIdx + 1 : changes[start].edit.newIdx + 1)
      : 1;
    let newCount = 0;

    // Recalculate starts from first change in range
    oldStart = changes[start].edit.oldIdx + 1;
    newStart = changes[start].edit.newIdx + 1;

    const lines: string[] = [];
    for (let h = start; h < end; h++) {
      const { edit, line } = changes[h];
      if (edit.type === EDIT_EQUAL) {
        lines.push(` ${line}`);
        oldCount++;
        newCount++;
      } else if (edit.type === EDIT_DELETE) {
        lines.push(`-${line}`);
        oldCount++;
      } else {
        lines.push(`+${line}`);
        newCount++;
      }
    }

    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join("\n")}`);
    i = end;
  }

  return hunks;
}
