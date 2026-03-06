#!/usr/bin/env bash
# Git protocol conformance tests using real git CLI against wrangler dev.
#
# Usage: pnpm run test:conformance
#
# Starts wrangler dev in the background, runs git clone/push/fetch/branch/tag
# operations, and verifies correctness. Cleans up on exit.

set -euo pipefail

PORT=8787
BASE_URL="http://localhost:${PORT}"
TMPDIR_BASE=$(mktemp -d)
WRANGLER_PID=""

cleanup() {
  if [[ -n "$WRANGLER_PID" ]]; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

PASS=0
FAIL=0
TOTAL=0

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  echo "  FAIL: $1"
  echo "        $2"
}

echo "=== Git Conformance Tests ==="
echo ""

# Clean wrangler local state to avoid stale DO data
cd "$(dirname "$0")/.."
rm -rf .wrangler/state 2>/dev/null || true

# Unique namespace per run to avoid collisions
RUN_ID=$(date +%s)

# Start wrangler dev
echo "Starting wrangler dev..."
npx wrangler dev --config test/wrangler.jsonc --port "$PORT" --log-level error &
WRANGLER_PID=$!

# Wait for wrangler to be ready
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/" 2>/dev/null | grep -qE "200|404"; then
    break
  fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "FATAL: wrangler dev exited unexpectedly"
    exit 1
  fi
  sleep 1
done

if ! curl -s -o /dev/null "$BASE_URL/" 2>/dev/null; then
  echo "FATAL: wrangler dev did not start within 30s"
  exit 1
fi
echo "wrangler dev ready on port $PORT"
echo ""

# Configure git to not prompt
export GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME="Conformance Test"
export GIT_AUTHOR_EMAIL="test@gitmode.dev"
export GIT_COMMITTER_NAME="Conformance Test"
export GIT_COMMITTER_EMAIL="test@gitmode.dev"

# ============================================================
# Test 1: Push to a new repository
# ============================================================
echo "--- Test: Push to new repository ---"
REPO1="$TMPDIR_BASE/repo1"
mkdir -p "$REPO1"
cd "$REPO1"
git init -b main -q
echo "Hello from gitmode" > README.md
git add README.md
git commit -q -m "Initial commit"

if git push "$BASE_URL/ct${RUN_ID}/repo1.git" main 2>&1; then
  pass "git push to new repo"
else
  fail "git push to new repo" "push failed"
fi

# ============================================================
# Test 2: Clone the pushed repository
# ============================================================
echo ""
echo "--- Test: Clone repository ---"
CLONE1="$TMPDIR_BASE/clone1"
if git clone -q "$BASE_URL/ct${RUN_ID}/repo1.git" "$CLONE1" 2>&1; then
  pass "git clone"
else
  fail "git clone" "clone failed"
fi

# Verify content matches
if [[ -f "$CLONE1/README.md" ]]; then
  CONTENT=$(cat "$CLONE1/README.md")
  if [[ "$CONTENT" == "Hello from gitmode" ]]; then
    pass "cloned content matches"
  else
    fail "cloned content matches" "got: $CONTENT"
  fi
else
  fail "cloned content matches" "README.md not found"
fi

# Verify commit message
cd "$CLONE1"
MSG=$(git log --format=%s -1)
if [[ "$MSG" == "Initial commit" ]]; then
  pass "commit message preserved"
else
  fail "commit message preserved" "got: $MSG"
fi

# Verify author
AUTHOR=$(git log --format='%an <%ae>' -1)
if [[ "$AUTHOR" == "Conformance Test <test@gitmode.dev>" ]]; then
  pass "author preserved"
else
  fail "author preserved" "got: $AUTHOR"
fi

# ============================================================
# Test 3: Incremental push (second commit)
# ============================================================
echo ""
echo "--- Test: Incremental push ---"
cd "$REPO1"
echo "Second line" >> README.md
echo "new file" > extra.txt
git add -A
git commit -q -m "Second commit"

if git push "$BASE_URL/ct${RUN_ID}/repo1.git" main 2>&1; then
  pass "incremental push"
else
  fail "incremental push" "push failed"
fi

# ============================================================
# Test 4: Fetch / pull incremental changes
# ============================================================
echo ""
echo "--- Test: Fetch incremental changes ---"
cd "$CLONE1"
if git pull origin main 2>&1; then
  pass "git pull"
else
  fail "git pull" "pull failed"
fi

if [[ -f "$CLONE1/extra.txt" ]]; then
  EXTRA=$(cat "$CLONE1/extra.txt")
  if [[ "$EXTRA" == "new file" ]]; then
    pass "pulled new file content"
  else
    fail "pulled new file content" "got: $EXTRA"
  fi
else
  fail "pulled new file content" "extra.txt not found"
fi

COMMIT_COUNT=$(git log --oneline | wc -l | tr -d ' ')
if [[ "$COMMIT_COUNT" == "2" ]]; then
  pass "commit history preserved (2 commits)"
else
  fail "commit history preserved" "expected 2 commits, got $COMMIT_COUNT"
fi

# ============================================================
# Test 5: Branch creation and push
# ============================================================
echo ""
echo "--- Test: Branch operations ---"
cd "$REPO1"
git checkout -q -b feature
echo "feature work" > feature.txt
git add feature.txt
git commit -q -m "Feature branch commit"

if git push "$BASE_URL/ct${RUN_ID}/repo1.git" feature 2>&1; then
  pass "push feature branch"
else
  fail "push feature branch" "push failed"
fi

# Clone and verify branch
CLONE2="$TMPDIR_BASE/clone2"
if git clone -q -b feature "$BASE_URL/ct${RUN_ID}/repo1.git" "$CLONE2" 2>&1; then
  pass "clone feature branch"
  cd "$CLONE2"
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$BRANCH" == "feature" ]]; then
    pass "checked out correct branch"
  else
    fail "checked out correct branch" "got: $BRANCH"
  fi
  if [[ -f "$CLONE2/feature.txt" ]]; then
    pass "feature branch content present"
  else
    fail "feature branch content present" "feature.txt not found"
  fi
else
  fail "clone feature branch" "clone failed"
fi

# ============================================================
# Test 6: Lightweight tag
# ============================================================
echo ""
echo "--- Test: Tag operations ---"
cd "$REPO1"
git checkout -q main
git tag v1.0

if git push "$BASE_URL/ct${RUN_ID}/repo1.git" v1.0 2>&1; then
  pass "push lightweight tag"
else
  fail "push lightweight tag" "push failed"
fi

# ============================================================
# Test 7: Annotated tag
# ============================================================
git tag -a v2.0 -m "Release v2.0"
if git push "$BASE_URL/ct${RUN_ID}/repo1.git" v2.0 2>&1; then
  pass "push annotated tag"
else
  fail "push annotated tag" "push failed"
fi

# Verify tags via clone
CLONE3="$TMPDIR_BASE/clone3"
git clone -q "$BASE_URL/ct${RUN_ID}/repo1.git" "$CLONE3" 2>&1
cd "$CLONE3"
TAGS=$(git tag -l | sort)
if echo "$TAGS" | grep -q "v1.0"; then
  pass "lightweight tag visible after clone"
else
  fail "lightweight tag visible after clone" "tags: $TAGS"
fi
if echo "$TAGS" | grep -q "v2.0"; then
  pass "annotated tag visible after clone"
else
  fail "annotated tag visible after clone" "tags: $TAGS"
fi

# ============================================================
# Test 8: Delete branch via push
# ============================================================
echo ""
echo "--- Test: Delete branch via push ---"
cd "$REPO1"
if git push "$BASE_URL/ct${RUN_ID}/repo1.git" --delete feature 2>&1; then
  pass "delete branch via push"
else
  fail "delete branch via push" "push --delete failed"
fi

# Verify deleted branch is not advertised
REFS_OUT=$(git ls-remote "$BASE_URL/ct${RUN_ID}/repo1.git" 2>&1)
if echo "$REFS_OUT" | grep -q "refs/heads/feature"; then
  fail "branch deleted from remote" "feature still listed"
else
  pass "branch deleted from remote"
fi

# ============================================================
# Test 9: Push all refs
# ============================================================
echo ""
echo "--- Test: Push all refs ---"
cd "$REPO1"
if git push "$BASE_URL/ct${RUN_ID}/repo1.git" --all 2>&1; then
  pass "push --all"
else
  fail "push --all" "push --all failed"
fi

# ============================================================
# Test 10: Push --tags
# ============================================================
git tag v3.0-rc1
if git push "$BASE_URL/ct${RUN_ID}/repo1.git" --tags 2>&1; then
  pass "push --tags"
else
  fail "push --tags" "push --tags failed"
fi

# ============================================================
# Test 11: ls-remote
# ============================================================
echo ""
echo "--- Test: ls-remote ---"
LS_OUTPUT=$(git ls-remote "$BASE_URL/ct${RUN_ID}/repo1.git" 2>&1)
if echo "$LS_OUTPUT" | grep -q "refs/heads/main"; then
  pass "ls-remote shows refs/heads/main"
else
  fail "ls-remote shows refs/heads/main" "output: $LS_OUTPUT"
fi
if echo "$LS_OUTPUT" | grep -q "refs/tags/v1.0"; then
  pass "ls-remote shows refs/tags/v1.0"
else
  fail "ls-remote shows refs/tags/v1.0" "output: $LS_OUTPUT"
fi
if echo "$LS_OUTPUT" | grep -q "HEAD"; then
  pass "ls-remote shows HEAD"
else
  fail "ls-remote shows HEAD" "output: $LS_OUTPUT"
fi

# ============================================================
# Test 12: Binary file roundtrip
# ============================================================
echo ""
echo "--- Test: Binary file roundtrip ---"
cd "$REPO1"
git checkout -q main
dd if=/dev/urandom bs=1024 count=64 of=binary.bin 2>/dev/null
ORIG_SHA=$(shasum -a 256 binary.bin | cut -d' ' -f1)
git add binary.bin
git commit -q -m "Add binary file"
if git push "$BASE_URL/ct${RUN_ID}/repo1.git" main 2>&1; then
  pass "push binary file"
else
  fail "push binary file" "push failed"
fi

CLONE4="$TMPDIR_BASE/clone4"
git clone -q "$BASE_URL/ct${RUN_ID}/repo1.git" "$CLONE4" 2>&1
CLONE_SHA=$(shasum -a 256 "$CLONE4/binary.bin" | cut -d' ' -f1)
if [[ "$ORIG_SHA" == "$CLONE_SHA" ]]; then
  pass "binary file content preserved"
else
  fail "binary file content preserved" "sha256 mismatch"
fi

# ============================================================
# Test 13: Multiple files in subdirectories
# ============================================================
echo ""
echo "--- Test: Nested directory structure ---"
cd "$REPO1"
mkdir -p src/lib src/test docs
echo "export const x = 1;" > src/lib/mod.ts
echo "import { x } from './lib/mod';" > src/test/mod.test.ts
echo "# Docs" > docs/guide.md
git add -A
git commit -q -m "Add nested structure"
if git push "$BASE_URL/ct${RUN_ID}/repo1.git" main 2>&1; then
  pass "push nested directories"
else
  fail "push nested directories" "push failed"
fi

CLONE5="$TMPDIR_BASE/clone5"
git clone -q "$BASE_URL/ct${RUN_ID}/repo1.git" "$CLONE5" 2>&1
if [[ -f "$CLONE5/src/lib/mod.ts" && -f "$CLONE5/src/test/mod.test.ts" && -f "$CLONE5/docs/guide.md" ]]; then
  pass "nested directories preserved"
else
  fail "nested directories preserved" "missing files"
fi

# ============================================================
# Test 14: Empty commit (tree unchanged)
# ============================================================
echo ""
echo "--- Test: Empty commit ---"
cd "$REPO1"
git commit -q --allow-empty -m "Empty commit"
if git push "$BASE_URL/ct${RUN_ID}/repo1.git" main 2>&1; then
  pass "push empty commit"
else
  fail "push empty commit" "push failed"
fi

# ============================================================
# Test 15: Second independent repository
# ============================================================
echo ""
echo "--- Test: Independent repository ---"
REPO2="$TMPDIR_BASE/repo2"
mkdir -p "$REPO2"
cd "$REPO2"
git init -b main -q
echo "Different repo" > file.txt
git add file.txt
git commit -q -m "Independent repo"
if git push "$BASE_URL/ct${RUN_ID}/repo2.git" main 2>&1; then
  pass "push to second repo"
else
  fail "push to second repo" "push failed"
fi

# Verify repos are isolated
CLONE6="$TMPDIR_BASE/clone6"
git clone -q "$BASE_URL/ct${RUN_ID}/repo2.git" "$CLONE6" 2>&1
cd "$CLONE6"
FILE_COUNT=$(find . -name '*.txt' -not -path './.git/*' | wc -l | tr -d ' ')
if [[ "$FILE_COUNT" == "1" ]]; then
  pass "repos are isolated"
else
  fail "repos are isolated" "expected 1 file, got $FILE_COUNT"
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo "=== Results ==="
echo "  Total: $TOTAL"
echo "  Pass:  $PASS"
echo "  Fail:  $FAIL"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "CONFORMANCE TESTS FAILED"
  exit 1
else
  echo "ALL CONFORMANCE TESTS PASSED"
  exit 0
fi
