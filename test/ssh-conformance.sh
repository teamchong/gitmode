#!/usr/bin/env bash
# SSH conformance tests for gitmode
#
# Tests git operations over SSH transport via the SSH-to-HTTP proxy.
# Covers: clone, push, fetch, branches, tags, delete, binary files.
#
# Prerequisites: wrangler, tsx, ssh-keygen, git
# Usage: pnpm run test:ssh

set -euo pipefail

PASS=0
FAIL=0
HTTP_PORT="${HTTP_PORT:-8787}"
SSH_PORT="${SSH_PORT:-2222}"
HTTP_BASE="http://localhost:$HTTP_PORT"
TMPDIR=$(mktemp -d)
RUN_ID=$(date +%s)
GIT_SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p $SSH_PORT"

cleanup() {
  # Kill background processes
  kill "$WRANGLER_PID" 2>/dev/null || true
  kill "$SSH_PID" 2>/dev/null || true
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1 — $2"; fi }

echo "=== gitmode SSH conformance tests ==="
echo ""

# Clean wrangler state
rm -rf .wrangler/state 2>/dev/null || true

# Start wrangler dev
echo "Starting wrangler dev on port $HTTP_PORT..."
npx wrangler dev --config test/wrangler.jsonc --port "$HTTP_PORT" --log-level error &
WRANGLER_PID=$!

# Wait for wrangler
for i in $(seq 1 30); do
  if curl -s "$HTTP_BASE/" | grep -q gitmode; then break; fi
  sleep 1
done

if ! curl -s "$HTTP_BASE/" | grep -q gitmode; then
  echo "FATAL: wrangler dev failed to start"
  exit 1
fi
echo "wrangler dev ready."

# Start SSH proxy
echo "Starting SSH proxy on port $SSH_PORT..."
npx tsx ssh/proxy.ts --port "$SSH_PORT" --http "$HTTP_BASE" &
SSH_PID=$!
sleep 2

# Verify SSH proxy is listening
if ! lsof -i :"$SSH_PORT" >/dev/null 2>&1; then
  echo "FATAL: SSH proxy failed to start"
  exit 1
fi
echo "SSH proxy ready."
echo ""

# --- Helper: init repo via REST API ---
init_repo() {
  local owner="$1" repo="$2"
  curl -sf -X POST "$HTTP_BASE/api/repos/$owner/$repo/init" \
    -H 'Content-Type: application/json' -d '{}' >/dev/null
}

commit_file() {
  local owner="$1" repo="$2" path="$3" content="$4" msg="$5"
  curl -sf -X POST "$HTTP_BASE/api/repos/$owner/$repo/commits" \
    -H 'Content-Type: application/json' \
    -d "{\"ref\":\"main\",\"message\":\"$msg\",\"author\":\"Test\",\"email\":\"test@test.com\",\"files\":[{\"path\":\"$path\",\"content\":\"$content\"}]}" >/dev/null
}

# ==============================
# Test 1: Clone over SSH
# ==============================
echo "--- Clone ---"

init_repo "ssh${RUN_ID}" "repo1"
commit_file "ssh${RUN_ID}" "repo1" "README.md" "# SSH Test" "initial commit"

cd "$TMPDIR"
GIT_SSH_COMMAND="$GIT_SSH" git clone "ssh://git@localhost/ssh${RUN_ID}/repo1.git" clone1 2>/dev/null
check "clone creates directory" "[ -d clone1/.git ]"
check "clone has correct content" "grep -q 'SSH Test' clone1/README.md"
check "clone has correct commit message" "cd clone1 && git log --oneline | grep -q 'initial commit'"

# ==============================
# Test 2: Push over SSH
# ==============================
echo "--- Push ---"

cd "$TMPDIR/clone1"
echo "pushed via SSH" > ssh-file.txt
git add ssh-file.txt
git commit -m "push via SSH" -q
GIT_SSH_COMMAND="$GIT_SSH" git push 2>/dev/null

CONTENT=$(curl -sf "$HTTP_BASE/api/repos/ssh${RUN_ID}/repo1/files?ref=main&path=ssh-file.txt" | python3 -c "import sys,json; print(json.load(sys.stdin)['content'])")
check "push delivers file content" "[ '$CONTENT' = 'pushed via SSH' ]"

# ==============================
# Test 3: Incremental push
# ==============================
echo "--- Incremental push ---"

cd "$TMPDIR/clone1"
echo "second push" > second.txt
git add second.txt
git commit -m "second push" -q
GIT_SSH_COMMAND="$GIT_SSH" git push 2>/dev/null

LOG_COUNT=$(curl -sf "$HTTP_BASE/api/repos/ssh${RUN_ID}/repo1/log?ref=main" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['commits']))")
check "incremental push: 3 commits" "[ '$LOG_COUNT' = '3' ]"

# ==============================
# Test 4: Clone from second client
# ==============================
echo "--- Second clone ---"

cd "$TMPDIR"
GIT_SSH_COMMAND="$GIT_SSH" git clone "ssh://git@localhost/ssh${RUN_ID}/repo1.git" clone2 2>/dev/null
check "second clone has all files" "[ -f clone2/ssh-file.txt ] && [ -f clone2/second.txt ]"
check "second clone has 3 commits" "cd clone2 && [ \$(git log --oneline | wc -l | tr -d ' ') = '3' ]"

# ==============================
# Test 5: Fetch changes
# ==============================
echo "--- Fetch ---"

# Push from clone1
cd "$TMPDIR/clone1"
echo "fetched content" > fetch-test.txt
git add fetch-test.txt
git commit -m "for fetch test" -q
GIT_SSH_COMMAND="$GIT_SSH" git push 2>/dev/null

# Fetch from clone2
cd "$TMPDIR/clone2"
GIT_SSH_COMMAND="$GIT_SSH" git fetch 2>/dev/null
git merge origin/main -q --no-edit 2>/dev/null
check "fetch delivers new file" "[ -f fetch-test.txt ]"
check "fetch has correct content" "grep -q 'fetched content' fetch-test.txt"

# ==============================
# Test 6: Branch create + push
# ==============================
echo "--- Branches ---"

cd "$TMPDIR/clone1"
git checkout -b feature-ssh -q
echo "feature work" > feature.txt
git add feature.txt
git commit -m "feature commit" -q
GIT_SSH_COMMAND="$GIT_SSH" git push -u origin feature-ssh 2>/dev/null
check "branch push succeeds" "true"

# Clone the branch
cd "$TMPDIR"
GIT_SSH_COMMAND="$GIT_SSH" git clone -b feature-ssh "ssh://git@localhost/ssh${RUN_ID}/repo1.git" clone-branch 2>/dev/null
check "branch clone has feature file" "[ -f clone-branch/feature.txt ]"
check "branch clone on correct branch" "cd clone-branch && [ \$(git rev-parse --abbrev-ref HEAD) = 'feature-ssh' ]"

# ==============================
# Test 7: Delete branch via push
# ==============================
echo "--- Delete branch ---"

cd "$TMPDIR/clone1"
git checkout main -q
GIT_SSH_COMMAND="$GIT_SSH" git push origin --delete feature-ssh 2>/dev/null

BRANCHES=$(curl -sf "$HTTP_BASE/api/repos/ssh${RUN_ID}/repo1/branches" | python3 -c "import sys,json; print(' '.join(b['name'] for b in json.load(sys.stdin)['branches']))")
check "branch deleted" "! echo '$BRANCHES' | grep -q feature-ssh"

# ==============================
# Test 8: Lightweight tag
# ==============================
echo "--- Tags ---"

cd "$TMPDIR/clone1"
git tag v1.0-ssh
GIT_SSH_COMMAND="$GIT_SSH" git push origin v1.0-ssh 2>/dev/null

TAGS=$(curl -sf "$HTTP_BASE/api/repos/ssh${RUN_ID}/repo1/tags" | python3 -c "import sys,json; print(' '.join(t['name'] for t in json.load(sys.stdin)['tags']))")
check "lightweight tag pushed" "echo '$TAGS' | grep -q v1.0-ssh"

# ==============================
# Test 9: Annotated tag
# ==============================
echo "--- Annotated tag ---"

cd "$TMPDIR/clone1"
git tag -a v2.0-ssh -m "SSH release"
GIT_SSH_COMMAND="$GIT_SSH" git push origin v2.0-ssh 2>/dev/null

TAG_TYPE=$(curl -sf "$HTTP_BASE/api/repos/ssh${RUN_ID}/repo1/tags" | python3 -c "import sys,json; tags=json.load(sys.stdin)['tags']; t=[x for x in tags if x['name']=='v2.0-ssh']; print(t[0]['type'] if t else 'none')")
check "annotated tag pushed" "[ '$TAG_TYPE' = 'annotated' ]"

# ==============================
# Test 10: Push --tags
# ==============================
echo "--- Push all tags ---"

cd "$TMPDIR/clone1"
git tag v3.0-ssh
GIT_SSH_COMMAND="$GIT_SSH" git push --tags 2>/dev/null

TAGS=$(curl -sf "$HTTP_BASE/api/repos/ssh${RUN_ID}/repo1/tags" | python3 -c "import sys,json; print(' '.join(t['name'] for t in json.load(sys.stdin)['tags']))")
check "push --tags delivers all tags" "echo '$TAGS' | grep -q v3.0-ssh"

# ==============================
# Test 11: ls-remote over SSH
# ==============================
echo "--- ls-remote ---"

REFS=$(GIT_SSH_COMMAND="$GIT_SSH" git ls-remote "ssh://git@localhost/ssh${RUN_ID}/repo1.git" 2>/dev/null)
check "ls-remote shows HEAD" "echo '$REFS' | grep -q HEAD"
check "ls-remote shows main" "echo '$REFS' | grep -q refs/heads/main"
check "ls-remote shows tags" "echo '$REFS' | grep -q refs/tags/v1.0-ssh"

# ==============================
# Test 12: Binary file roundtrip
# ==============================
echo "--- Binary file ---"

cd "$TMPDIR/clone1"
dd if=/dev/urandom of=binary.dat bs=1024 count=64 2>/dev/null
ORIG_SHA=$(shasum binary.dat | awk '{print $1}')
git add binary.dat
git commit -m "add binary file" -q
GIT_SSH_COMMAND="$GIT_SSH" git push 2>/dev/null

cd "$TMPDIR"
GIT_SSH_COMMAND="$GIT_SSH" git clone "ssh://git@localhost/ssh${RUN_ID}/repo1.git" clone-binary 2>/dev/null
CLONE_SHA=$(shasum clone-binary/binary.dat | awk '{print $1}')
check "64KB binary roundtrip" "[ '$ORIG_SHA' = '$CLONE_SHA' ]"

# ==============================
# Test 13: Nested directories
# ==============================
echo "--- Nested directories ---"

cd "$TMPDIR/clone1"
mkdir -p src/components/ui
echo "button" > src/components/ui/button.tsx
echo "input" > src/components/ui/input.tsx
git add -A
git commit -m "add nested dirs" -q
GIT_SSH_COMMAND="$GIT_SSH" git push 2>/dev/null

cd "$TMPDIR"
GIT_SSH_COMMAND="$GIT_SSH" git clone "ssh://git@localhost/ssh${RUN_ID}/repo1.git" clone-nested 2>/dev/null
check "nested dir: button.tsx exists" "[ -f clone-nested/src/components/ui/button.tsx ]"
check "nested dir: content correct" "grep -q button clone-nested/src/components/ui/button.tsx"

# ==============================
# Test 14: Repo isolation
# ==============================
echo "--- Repo isolation ---"

init_repo "ssh${RUN_ID}" "repo2"
commit_file "ssh${RUN_ID}" "repo2" "other.txt" "other repo" "other init"

cd "$TMPDIR"
GIT_SSH_COMMAND="$GIT_SSH" git clone "ssh://git@localhost/ssh${RUN_ID}/repo2.git" clone-other 2>/dev/null
check "other repo has its own file" "[ -f clone-other/other.txt ]"
check "other repo does NOT have repo1 files" "[ ! -f clone-other/README.md ]"

# ==============================
# Test 15: SSH + HTTP interop
# ==============================
echo "--- SSH/HTTP interop ---"

# Commit via REST API
curl -sf -X POST "$HTTP_BASE/api/repos/ssh${RUN_ID}/repo1/commits" \
  -H 'Content-Type: application/json' \
  -d "{\"ref\":\"main\",\"message\":\"api commit\",\"author\":\"API\",\"email\":\"api@test.com\",\"files\":[{\"path\":\"api-file.txt\",\"content\":\"from api\"}]}" >/dev/null

# Pull over SSH
cd "$TMPDIR/clone1"
GIT_SSH_COMMAND="$GIT_SSH" git pull 2>/dev/null
check "SSH pull sees HTTP commit" "[ -f api-file.txt ]"
check "SSH pull has correct content" "grep -q 'from api' api-file.txt"

# Push over SSH, verify via HTTP
echo "ssh after api" > ssh-after-api.txt
git add ssh-after-api.txt
git commit -m "ssh after api" -q
GIT_SSH_COMMAND="$GIT_SSH" git push 2>/dev/null

API_CONTENT=$(curl -sf "$HTTP_BASE/api/repos/ssh${RUN_ID}/repo1/files?ref=main&path=ssh-after-api.txt" | python3 -c "import sys,json; print(json.load(sys.stdin)['content'])")
check "HTTP API sees SSH push" "[ '$API_CONTENT' = 'ssh after api' ]"

# ==============================
# Summary
# ==============================
echo ""
echo "=== SSH conformance: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
