#!/usr/bin/env bash
# Local-only API docs sync. Generates docs/openapi.{json,yaml} from
# the @openapi JSDoc blocks in backend/src/routes/v1/*, then copies the
# result into the picpeak-docs Nextra site at /Users/paul/Development/picpeak-docs/app/api/.
#
# Writes only — never commits or pushes the docs repo. Review the diff
# in picpeak-docs and commit there manually when ready.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS_REPO="${PICPEAK_DOCS_REPO:-/Users/paul/Development/picpeak-docs}"
SRC_DIR="$REPO_ROOT/docs"
TARGET_DIR="$DOCS_REPO/app/api"

cd "$REPO_ROOT/backend"

# 1. Generate fresh spec from JSDoc.
echo "▶ Generating OpenAPI spec from src/routes/v1/*"
node scripts/generate-openapi.js

# 2. Verify docs repo is reachable. Soft-fail so this doesn't block a
#    push when the docs repo isn't on this machine.
if [ ! -d "$DOCS_REPO" ]; then
  echo "▶ Docs repo not found at $DOCS_REPO — skipping sync."
  echo "  (Set PICPEAK_DOCS_REPO to override, or create the path to enable sync.)"
  exit 0
fi
if [ ! -d "$TARGET_DIR" ]; then
  echo "▶ Target dir $TARGET_DIR doesn't exist — creating."
  mkdir -p "$TARGET_DIR"
fi

# 3. Copy spec files into the docs repo. We do NOT git-add or commit
#    here — the user reviews and commits picpeak-docs manually.
cp "$SRC_DIR/openapi.json" "$TARGET_DIR/openapi.json"
cp "$SRC_DIR/openapi.yaml" "$TARGET_DIR/openapi.yaml"
echo "▶ Wrote openapi.{json,yaml} to $TARGET_DIR"

# 4. Brief drop-in MDX page that references the spec, so the Nextra
#    nav has a stable target. Won't overwrite a hand-edited file —
#    only writes if missing.
REF_MDX="$TARGET_DIR/reference.mdx"
if [ ! -f "$REF_MDX" ]; then
  cat > "$REF_MDX" <<'EOF'
---
title: API Reference
---

# API Reference

The PicPeak v1 REST API is documented as an OpenAPI 3 spec.

- [Download `openapi.yaml`](./openapi.yaml)
- [Download `openapi.json`](./openapi.json)
- A live, browseable Swagger UI is served by every PicPeak instance at
  `/api/docs` (admin login required).

This page is auto-generated from JSDoc annotations on the v1 route files.
Do not hand-edit. The narrative pages (auth, recipes) live alongside.
EOF
  echo "▶ Created $REF_MDX (placeholder — replace with your preferred renderer)"
fi

echo "✓ API docs synced. Review changes in $DOCS_REPO before committing."
