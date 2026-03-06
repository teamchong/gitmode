#!/usr/bin/env bash
# gitmode stress test
#
# Pushes repos with increasing file counts to find breaking points.
# Requires: gitmode dev server running on localhost:8787
#
# Usage:
#   ./test/stress.sh              # full stress test (node_modules + synthetic)
#   ./test/stress.sh quick        # synthetic files only (no npm install)
#   ./test/stress.sh node_modules # node_modules only

set -euo pipefail

SERVER="${GITMODE_SERVER:-http://localhost:8787}"
OWNER="stresstest"
TMPDIR=$(mktemp -d)
RESULTS="$TMPDIR/results.txt"

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "=== gitmode stress test ==="
echo "Server: $SERVER"
echo "Temp dir: $TMPDIR"
echo ""

millis() {
  python3 -c 'import time; print(int(time.time()*1000))'
}

time_cmd() {
  local start=$(millis)
  "$@" > /dev/null 2>&1
  local rc=$?
  local end=$(millis)
  echo $((end - start))
  return $rc
}

run_test() {
  local label="$1"
  local repo="$2"
  local dir="$3"

  echo "--- $label ---"

  # Count files
  local file_count=$(find "$dir" -type f | wc -l | tr -d ' ')
  local total_size=$(du -sh "$dir" | cut -f1)
  echo "Files: $file_count, Size: $total_size"

  # Init repo
  cd "$dir"
  git init -b main > /dev/null 2>&1
  git add -A > /dev/null 2>&1
  git commit -m "stress test: $label" > /dev/null 2>&1
  git remote add origin "$SERVER/$OWNER/$repo.git" 2>/dev/null || true

  # Init on server
  curl -sf -X POST "$SERVER/api/repos/$OWNER/$repo/init" > /dev/null 2>&1 || true

  # Push
  echo -n "Push: "
  local push_start=$(millis)
  if git push -u origin main --force 2>"$TMPDIR/push-err-$repo.log"; then
    local push_end=$(millis)
    local push_ms=$((push_end - push_start))
    echo "${push_ms}ms"
  else
    local push_end=$(millis)
    local push_ms=$((push_end - push_start))
    echo "${push_ms}ms FAILED"
    tail -5 "$TMPDIR/push-err-$repo.log"
  fi

  # Clone
  local clone_dir="$TMPDIR/clone-$repo"
  echo -n "Clone: "
  local clone_start=$(millis)
  if git clone "$SERVER/$OWNER/$repo.git" "$clone_dir" 2>"$TMPDIR/clone-err-$repo.log"; then
    local clone_end=$(millis)
    local clone_ms=$((clone_end - clone_start))
    echo "${clone_ms}ms"
  else
    local clone_end=$(millis)
    local clone_ms=$((clone_end - clone_start))
    echo "${clone_ms}ms FAILED"
    tail -5 "$TMPDIR/clone-err-$repo.log"
  fi

  # Verify clone integrity
  local clone_files=$(find "$clone_dir" -type f -not -path '*/.git/*' | wc -l | tr -d ' ')
  if [ "$clone_files" -eq "$file_count" ]; then
    echo "Integrity: OK ($clone_files files)"
  else
    echo "Integrity: MISMATCH (pushed $file_count, cloned $clone_files)"
  fi

  # API stats
  echo -n "Stats API: "
  local stats_ms=$(time_cmd curl -sf "$SERVER/api/repos/$OWNER/$repo/stats?ref=main")
  echo "${stats_ms}ms"

  echo -n "Files API: "
  local files_ms=$(time_cmd curl -sf "$SERVER/api/repos/$OWNER/$repo/files/all?ref=main")
  echo "${files_ms}ms"

  # Incremental push (add one file)
  echo "test" > "$dir/stress-incremental.txt"
  git add stress-incremental.txt > /dev/null 2>&1
  git commit -m "incremental" > /dev/null 2>&1
  echo -n "Incremental push (+1 file): "
  local incr_ms=$(time_cmd git push)
  echo "${incr_ms}ms"

  echo "$label | $file_count | $total_size | ${push_ms}ms | ${clone_ms}ms | ${incr_ms}ms | ${stats_ms}ms | ${files_ms}ms" >> "$RESULTS"
  echo ""
  cd "$TMPDIR"
}

# ---- Synthetic file tests ----
run_synthetic() {
  for count in 100 1000 5000 10000; do
    local dir="$TMPDIR/synthetic-$count"
    mkdir -p "$dir"

    echo "Generating $count synthetic files..."
    for i in $(seq 1 $count); do
      # Create nested structure similar to node_modules
      local depth=$((i % 5))
      local subdir="$dir"
      for d in $(seq 1 $depth); do
        subdir="$subdir/d$((i % (d * 7 + 3)))"
      done
      mkdir -p "$subdir"
      # Vary file sizes: small (100B), medium (1KB), large (10KB)
      local size_class=$((i % 3))
      if [ $size_class -eq 0 ]; then
        head -c 100 /dev/urandom | base64 > "$subdir/file-$i.txt"
      elif [ $size_class -eq 1 ]; then
        head -c 1024 /dev/urandom | base64 > "$subdir/file-$i.js"
      else
        head -c 10240 /dev/urandom | base64 > "$subdir/file-$i.ts"
      fi
    done

    run_test "Synthetic ${count} files" "stress-synth-$count" "$dir"
  done
}

# ---- node_modules test ----
run_node_modules() {
  local dir="$TMPDIR/nm-project"
  mkdir -p "$dir"
  cd "$dir"

  echo "Installing npm packages for node_modules stress test..."
  cat > package.json << 'PKGJSON'
{
  "name": "stress-test",
  "private": true,
  "dependencies": {
    "express": "^4",
    "lodash": "^4",
    "moment": "^2",
    "chalk": "^4",
    "debug": "^4",
    "commander": "^11",
    "yargs": "^17",
    "glob": "^10",
    "minimatch": "^9",
    "semver": "^7",
    "uuid": "^9",
    "dotenv": "^16",
    "axios": "^1",
    "cheerio": "^1",
    "ws": "^8"
  }
}
PKGJSON

  npm install --no-audit --no-fund > /dev/null 2>&1
  echo "README" > README.md

  run_test "node_modules (15 packages)" "stress-nm" "$dir"

  # Round 2: add heavier packages
  echo "Installing heavier packages..."
  cd "$dir"
  cat > package.json << 'PKGJSON2'
{
  "name": "stress-test-heavy",
  "private": true,
  "dependencies": {
    "express": "^4",
    "lodash": "^4",
    "moment": "^2",
    "chalk": "^4",
    "debug": "^4",
    "commander": "^11",
    "yargs": "^17",
    "glob": "^10",
    "minimatch": "^9",
    "semver": "^7",
    "uuid": "^9",
    "dotenv": "^16",
    "axios": "^1",
    "cheerio": "^1",
    "ws": "^8",
    "typescript": "^5",
    "webpack": "^5",
    "babel-core": "^6",
    "@babel/preset-env": "^7",
    "eslint": "^8",
    "prettier": "^3",
    "jest": "^29",
    "mocha": "^10",
    "sinon": "^17"
  }
}
PKGJSON2

  rm -rf node_modules package-lock.json
  npm install --no-audit --no-fund > /dev/null 2>&1

  # Reset git for fresh push
  rm -rf .git
  local repo2="stress-nm-heavy"

  run_test "node_modules (24 packages)" "$repo2" "$dir"
}

# ---- Main ----
echo "Checking server..."
if ! curl -sf "$SERVER/" > /dev/null 2>&1; then
  echo "ERROR: Server not reachable at $SERVER"
  echo "Start with: pnpm wrangler dev"
  exit 1
fi

mode="${1:-full}"

case "$mode" in
  quick)
    run_synthetic
    ;;
  node_modules)
    run_node_modules
    ;;
  full)
    run_synthetic
    run_node_modules
    ;;
  *)
    echo "Usage: $0 [quick|node_modules|full]"
    exit 1
    ;;
esac

echo "=== Results Summary ==="
echo ""
printf "%-30s | %6s | %6s | %8s | %8s | %8s | %8s | %8s\n" \
  "Test" "Files" "Size" "Push" "Clone" "Incr" "Stats" "FilesAPI"
echo "-------------------------------|--------|--------|----------|----------|----------|----------|----------"
while IFS='|' read -r label files size push clone incr stats filesapi; do
  printf "%-30s |%6s |%6s |%8s |%8s |%8s |%8s |%8s\n" \
    "$label" "$files" "$size" "$push" "$clone" "$incr" "$stats" "$filesapi"
done < "$RESULTS"
echo ""
echo "Done. Results in $RESULTS"
