#!/usr/bin/env bash
# gitmode performance benchmark
#
# Measures push/clone/fetch/API latency at different repo sizes.
# Requires: gitmode dev server running on localhost:5173
#
# Usage: bash test/bench.sh [base_url]

set -euo pipefail

BASE=${1:-http://localhost:5173}
TMPDIR=$(mktemp -d)
RESULTS="$TMPDIR/results.txt"
trap 'rm -rf "$TMPDIR"' EXIT

# Colors
G='\033[0;32m' Y='\033[0;33m' R='\033[0;31m' B='\033[0;34m' N='\033[0m'

log() { echo -e "${B}[bench]${N} $*"; }
result() { echo -e "${G}  ✓${N} $1: ${Y}${2}ms${N}"; echo "$1: ${2}ms" >> "$RESULTS"; }

# Timing helper (returns ms)
ms() {
  local start end
  start=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
  "$@" > /dev/null 2>&1
  end=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
  echo $(( (end - start) / 1000000 ))
}

# macOS doesn't have date +%s%N, use python fallback
if ! date +%s%N > /dev/null 2>&1; then
  ms() {
    local start end
    start=$(python3 -c 'import time; print(int(time.time()*1e9))')
    "$@" > /dev/null 2>&1
    end=$(python3 -c 'import time; print(int(time.time()*1e9))')
    echo $(( (end - start) / 1000000 ))
  }
fi

echo ""
echo -e "${B}═══════════════════════════════════════════${N}"
echo -e "${B}  gitmode performance benchmark${N}"
echo -e "${B}  target: $BASE${N}"
echo -e "${B}═══════════════════════════════════════════${N}"
echo ""

# ─── Small repo (3 files, ~100 bytes) ───

log "Creating small repo (3 files)..."
SMALL="$TMPDIR/small"
mkdir -p "$SMALL" && cd "$SMALL"
git init -q && git checkout -q -b main
echo "# Small" > README.md
echo "const x = 1;" > index.js
echo "body{}" > style.css
git add -A && git commit -q -m "init"
git remote add origin "$BASE/bench/small.git"

echo -e "\n${Y}── Small repo (3 files, ~50B) ──${N}"

t=$(ms git push -u origin main)
result "push (small, initial)" "$t"

cd "$TMPDIR"
t=$(ms git clone "$BASE/bench/small.git" small-clone)
result "clone (small)" "$t"

cd "$SMALL"
echo "update" >> README.md && git add -A && git commit -q -m "update"
t=$(ms git push)
result "push (small, incremental)" "$t"

cd "$TMPDIR/small-clone"
t=$(ms git fetch origin)
result "fetch (small, 1 new commit)" "$t"

# ─── Medium repo (50 files, ~50KB) ───

log "Creating medium repo (50 files)..."
MEDIUM="$TMPDIR/medium"
mkdir -p "$MEDIUM/src" "$MEDIUM/lib" "$MEDIUM/test" && cd "$MEDIUM"
git init -q && git checkout -q -b main
echo "# Medium" > README.md
for i in $(seq 1 20); do
  printf 'export function fn%d() { return %d; }\n' "$i" "$i" > "src/mod${i}.ts"
done
for i in $(seq 1 15); do
  printf 'import { fn%d } from "../src/mod%d";\nexport const val%d = fn%d();\n' "$i" "$i" "$i" "$i" > "lib/helper${i}.ts"
done
for i in $(seq 1 14); do
  printf 'import { val%d } from "../lib/helper%d";\nconsole.assert(val%d === %d);\n' "$i" "$i" "$i" "$i" > "test/test${i}.ts"
done
git add -A && git commit -q -m "init: 50 files"
git remote add origin "$BASE/bench/medium.git"

echo -e "\n${Y}── Medium repo (50 files, ~3KB) ──${N}"

t=$(ms git push -u origin main)
result "push (medium, initial)" "$t"

cd "$TMPDIR"
t=$(ms git clone "$BASE/bench/medium.git" medium-clone)
result "clone (medium)" "$t"

# Add 10 commits
cd "$MEDIUM"
for i in $(seq 1 10); do
  echo "// update $i" >> "src/mod1.ts"
  git add -A && git commit -q -m "update $i"
done
t=$(ms git push)
result "push (medium, 10 commits)" "$t"

cd "$TMPDIR/medium-clone"
t=$(ms git fetch origin)
result "fetch (medium, 10 new commits)" "$t"

# ─── Large repo (500 files, ~500KB) ───

log "Creating large repo (500 files)..."
LARGE="$TMPDIR/large"
mkdir -p "$LARGE" && cd "$LARGE"
git init -q && git checkout -q -b main
for d in src lib test docs config scripts; do mkdir -p "$d"; done
echo "# Large" > README.md
for i in $(seq 1 200); do
  printf 'export class Service%d {\n  async execute() {\n    return { id: %d, data: "%s" };\n  }\n}\n' \
    "$i" "$i" "$(head -c 200 /dev/urandom | base64 | head -c 200)" > "src/service${i}.ts"
done
for i in $(seq 1 150); do
  printf 'import { Service%d } from "../src/service%d";\nexport const s%d = new Service%d();\n' \
    "$i" "$i" "$i" "$i" > "lib/init${i}.ts"
done
for i in $(seq 1 100); do
  printf 'describe("Service%d", () => {\n  it("works", async () => {\n    expect(true).toBe(true);\n  });\n});\n' \
    "$i" > "test/service${i}.test.ts"
done
for i in $(seq 1 49); do
  printf '# Document %d\n\nSome content for doc %d.\n' "$i" "$i" > "docs/page${i}.md"
done
git add -A && git commit -q -m "init: 500 files"
git remote add origin "$BASE/bench/large.git"

echo -e "\n${Y}── Large repo (500 files, ~150KB) ──${N}"

t=$(ms git push -u origin main)
result "push (large, initial)" "$t"

cd "$TMPDIR"
t=$(ms git clone "$BASE/bench/large.git" large-clone)
result "clone (large)" "$t"

cd "$LARGE"
for i in $(seq 1 5); do
  echo "// change $i" >> "src/service1.ts"
  git add -A && git commit -q -m "hotfix $i"
done
t=$(ms git push)
result "push (large, 5 commits)" "$t"

cd "$TMPDIR/large-clone"
t=$(ms git fetch origin)
result "fetch (large, 5 new commits)" "$t"

# ─── API latency ───

echo -e "\n${Y}── API response times ──${N}"

api_ms() {
  local start end
  start=$(python3 -c 'import time; print(int(time.time()*1e9))')
  curl -s "$1" > /dev/null
  end=$(python3 -c 'import time; print(int(time.time()*1e9))')
  echo $(( (end - start) / 1000000 ))
}

t=$(api_ms "$BASE/api/repos")
result "GET /api/repos (list)" "$t"

t=$(api_ms "$BASE/api/repos/bench/large")
result "GET /api/repos/:o/:r (meta)" "$t"

t=$(api_ms "$BASE/api/repos/bench/large/branches")
result "GET /branches" "$t"

t=$(api_ms "$BASE/api/repos/bench/large/log?ref=main&max=50")
result "GET /log (50 commits)" "$t"

t=$(api_ms "$BASE/api/repos/bench/large/files?ref=main")
result "GET /files (root listing)" "$t"

t=$(api_ms "$BASE/api/repos/bench/large/files/all?ref=main")
result "GET /files/all (500 files)" "$t"

t=$(api_ms "$BASE/api/repos/bench/large/stats")
result "GET /stats (500 files)" "$t"

t=$(api_ms "$BASE/api/repos/bench/large/contributors")
result "GET /contributors" "$t"

# ─── Summary ───

echo ""
echo -e "${B}═══════════════════════════════════════════${N}"
echo -e "${B}  Results summary${N}"
echo -e "${B}═══════════════════════════════════════════${N}"
echo ""
cat "$RESULTS"
echo ""
echo -e "Full results saved to: ${Y}$RESULTS${N}"
