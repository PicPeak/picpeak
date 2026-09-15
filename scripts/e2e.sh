#!/usr/bin/env bash
# Runs the Playwright E2E suite against the isolated stack in
# docker-compose.e2e.yml (issue 1500). Used locally and by CI.
#
#   scripts/e2e.sh                                   # full suite, both projects
#   scripts/e2e.sh --project=chromium --grep @smoke  # any Playwright arguments
#
# Brings the stack up from the checked-out code, waits for health, seeds a
# known state, runs Playwright, and tears the stack down again (its database is
# a tmpfs, so nothing survives). E2E_KEEP_STACK=1 leaves it running for
# debugging; E2E_NO_BUILD=1 reuses already-built images.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE=(docker compose -f docker-compose.e2e.yml)

BUILD_FLAG="--build"
if [ "${E2E_NO_BUILD:-0}" = "1" ]; then
  BUILD_FLAG=""
fi

teardown() {
  if [ "${E2E_KEEP_STACK:-0}" = "1" ]; then
    echo "▶ E2E_KEEP_STACK=1 — leaving the stack up (down: set -a; . .e2e/credentials.env; set +a; ${COMPOSE[*]} down -v)"
    return
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap teardown EXIT

# Per-run credentials for the throwaway stack, generated rather than committed.
# New values recreate the containers, and Postgres runs on tmpfs, so the admin
# the migrations seed always matches. Saved to .e2e/credentials.env so a stack
# kept up with E2E_KEEP_STACK=1 can be reused: `set -a; . .e2e/credentials.env; set +a`.
mkdir -p "$REPO_ROOT/.e2e"
export E2E_JWT_SECRET="${E2E_JWT_SECRET:-$(openssl rand -hex 32)}"
export E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-$(openssl rand -hex 16)}"
export E2E_DB_PASSWORD="${E2E_DB_PASSWORD:-$(openssl rand -hex 16)}"
(
  umask 077
  cat > "$REPO_ROOT/.e2e/credentials.env" <<ENV
E2E_JWT_SECRET=$E2E_JWT_SECRET
E2E_ADMIN_PASSWORD=$E2E_ADMIN_PASSWORD
E2E_DB_PASSWORD=$E2E_DB_PASSWORD
PLAYWRIGHT_BASE_URL=http://localhost:7200
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=$E2E_ADMIN_PASSWORD
WEBHOOK_RECEIVER_URL=http://localhost:7207
E2E_EXTERNAL_MEDIA_DIR=$REPO_ROOT/.e2e/external-media
ENV
  # What the backend container reads (env_file in docker-compose.e2e.yml).
  # The seeded admin's username and email are the migration defaults
  # (admin / admin@example.com), so only its password is set here.
  cat > "$REPO_ROOT/.e2e/backend.env" <<ENV
JWT_SECRET=$E2E_JWT_SECRET
ADMIN_PASSWORD=$E2E_ADMIN_PASSWORD
DB_PASSWORD=$E2E_DB_PASSWORD
ENV
)

# Host side of the backend's external-media mount. Created here so it belongs
# to the user running the specs, not to root (which Docker would use).
export E2E_EXTERNAL_MEDIA_DIR="$REPO_ROOT/.e2e/external-media"
mkdir -p "$E2E_EXTERNAL_MEDIA_DIR"

echo "▶ Starting the E2E stack…"
# shellcheck disable=SC2086 — empty when E2E_NO_BUILD=1
"${COMPOSE[@]}" up -d $BUILD_FLAG --wait

# Known state on top of the fresh database:
#  - the migration seeds the admin with must_change_password=true; the specs
#    log in with the password directly, so clear it
#  - /api/auth/* allows 5 requests per 15 minutes by default, which a full run
#    exceeds within its first few specs
#  - a fresh install opens the one-time usage-reporting dialog over every admin
#    page until it is answered, which blocks every click behind it
#  - video uploads are off by default; admin-video-upload.spec.ts needs mp4.
#    Seeded here rather than in the spec because saving the setting does not
#    clear the backend's 60-second allowed-types cache
echo "▶ Seeding admin, rate limits and install prompts…"
"${COMPOSE[@]}" exec -T postgres psql -U picpeak -d picpeak_e2e -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE admin_users SET must_change_password = false;
UPDATE product_usage_state SET prompt_shown = true WHERE id = 1;
DELETE FROM app_settings
 WHERE setting_key IN ('rate_limit_auth_max_requests', 'rate_limit_max_requests', 'general_allowed_file_types');
INSERT INTO app_settings (setting_key, setting_value, setting_type, updated_at) VALUES
  ('rate_limit_auth_max_requests', '10000', 'number', now()),
  ('rate_limit_max_requests', '100000', 'number', now()),
  ('general_allowed_file_types', '"jpg,jpeg,png,webp,mp4"', 'general', now());
SQL

# The limiters and the upload filter cache their settings, so restart the
# backend to pick up the rows above.
"${COMPOSE[@]}" restart backend >/dev/null
"${COMPOSE[@]}" up -d --wait >/dev/null

# The same values a kept stack is reused with.
set -a
. "$REPO_ROOT/.e2e/credentials.env"
set +a

echo "▶ Running Playwright…"
set +e
npx playwright test "$@"
status=$?
set -e

if [ "$status" -ne 0 ]; then
  "${COMPOSE[@]}" logs --no-color backend > test-results/e2e-backend.log 2>&1 || true
  echo "▶ Backend log saved to test-results/e2e-backend.log"
fi

exit "$status"
