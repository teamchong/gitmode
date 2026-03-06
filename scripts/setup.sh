#!/usr/bin/env bash
set -euo pipefail

# gitmode setup — creates all Cloudflare resources and deploys
#
# Prerequisites:
#   - wrangler (npm i -g wrangler)
#   - zig 0.15.2+
#   - pnpm
#
# Usage:
#   ./scripts/setup.sh

echo "=== gitmode setup ==="

# 1. Build WASM
echo "[1/5] Building Zig WASM module..."
cd wasm && zig build wasm && cd ..
mkdir -p src/wasm
cp wasm/zig-out/bin/gitmode.wasm src/wasm/

# 2. Install dependencies
echo "[2/5] Installing dependencies..."
pnpm install

# 3. Create Cloudflare resources
echo "[3/5] Creating Cloudflare resources..."

# Create D1 database
D1_OUTPUT=$(wrangler d1 create gitmode-meta --json 2>/dev/null || echo '{"uuid":"exists"}')
D1_ID=$(echo "$D1_OUTPUT" | grep -o '"uuid":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$D1_ID" != "exists" ] && [ -n "$D1_ID" ]; then
    echo "  Created D1 database: $D1_ID"
    # Update wrangler.toml with real database ID
    sed -i.bak "s/database_id = \"gitmode-meta\"/database_id = \"$D1_ID\"/" wrangler.toml
    rm -f wrangler.toml.bak
fi

# Create R2 bucket
wrangler r2 bucket create gitmode-objects 2>/dev/null || echo "  R2 bucket already exists"

# Create KV namespace
KV_OUTPUT=$(wrangler kv namespace create gitmode-refs --json 2>/dev/null || echo '{"id":"exists"}')
KV_ID=$(echo "$KV_OUTPUT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$KV_ID" != "exists" ] && [ -n "$KV_ID" ]; then
    echo "  Created KV namespace: $KV_ID"
    sed -i.bak "s/id = \"gitmode-refs\"/id = \"$KV_ID\"/" wrangler.toml
    rm -f wrangler.toml.bak
fi

# 4. Initialize D1 schema
echo "[4/5] Initializing database schema..."
wrangler d1 execute gitmode-meta --file=src/schema.sql

# 5. Deploy
echo "[5/5] Deploying to Cloudflare Workers..."
wrangler deploy

echo ""
echo "=== gitmode deployed ==="
echo ""
echo "Your git server is live. Configure git to use it:"
echo ""
echo "  git clone https://gitmode.<your-subdomain>.workers.dev/<owner>/<repo>.git"
echo "  git remote add origin https://gitmode.<your-subdomain>.workers.dev/<owner>/<repo>.git"
echo ""
