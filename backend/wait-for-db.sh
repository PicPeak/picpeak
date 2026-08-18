#!/bin/sh
# wait-for-db.sh - Wait for PostgreSQL to be ready before starting the application

set -e

# Machine secrets (JWT/DB/Redis): if not supplied via the environment, read them
# from the generated secret files that the compose `secrets-init` service writes
# to /run/secrets. Explicit env ALWAYS wins, so installs that set
# JWT_SECRET/DB_PASSWORD/REDIS_PASSWORD in .env are unaffected. Runs before the
# root -> nodejs re-exec so the exported values survive su-exec.
for _pair in JWT_SECRET:jwt_secret DB_PASSWORD:db_password REDIS_PASSWORD:redis_password; do
  _var="${_pair%%:*}"
  _file="/run/secrets/${_pair##*:}"
  eval "_cur=\${$_var:-}"
  if [ -z "$_cur" ] && [ -s "$_file" ]; then
    export "$_var=$(cat "$_file")"
  fi
done
unset _pair _var _file _cur

# Permission handling (#484): the image starts as root so this script can
# chown bind-mounted host volumes to UID 1001 (nodejs) before dropping
# privileges via su-exec. This avoids the fresh-install restart loop where
# the host directory's UID (commonly 1000) didn't match the container's
# hard-coded nodejs user. Compose deployments that pin `user:` to something
# other than root skip this branch — they own permissions themselves and hit
# the preflight check below instead.
# The writable roots. Defaults are the compose layout; the all-in-one image
# (#1042) points all of them under one mounted volume, so these must follow the
# same env vars the app itself reads rather than hard-coding /app.
DATA_DIRS="${STORAGE_PATH:-/app/storage} ${DATA_DIR:-/app/data} ${LOG_DIR:-/app/logs}"

# The backup root is adopted when explicitly configured, but never gates boot:
# docker-compose.production.yml does not mount /backup, so a hardened non-root
# deployment would fail `mkdir -p /backup` against a root-owned / and refuse to
# start over a directory it never needed.
if [ -n "${BACKUP_DIR:-}" ]; then
  DATA_DIRS="$DATA_DIRS $BACKUP_DIR"
fi

# When every root lives under ONE mounted volume (the all-in-one image, #1042),
# the mount point itself must be adopted too. Chowning only the children leaves
# a host directory created with 0700/0750 and a foreign owner untraversable by
# UID 1001 after the su-exec drop, so the preflight below rejects children the
# script just created. Docker Desktop's permissive bind mounts hide this; a NAS
# share does not.
#
# It is deliberately kept out of DATA_DIRS: everything below it is already
# chowned recursively, so adding it there would walk the whole photo library a
# second time on every restart — minutes of startup delay on exactly the large
# NAS libraries this image targets. The mount point needs its own ownership
# fixed, nothing more, so it gets a shallow chown of its own below.
DATA_ROOT_DIR="${DATA_ROOT:-}"

# Create the roots before touching them. With the compose layout each is its own
# mount point so they always exist — but the AIO image mounts ONE volume at
# /data, and a bind-mounted host directory hides the tree baked into the image.
# chown would then fail on paths that do not exist and report "the filesystem
# rejects chown", which is both wrong and a dead end for NAS users.
# shellcheck disable=SC2086 — intentional word-splitting over the roots
mkdir -p $DATA_ROOT_DIR $DATA_DIRS 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  if [ -n "$DATA_ROOT_DIR" ] && ! chown nodejs:nodejs "$DATA_ROOT_DIR" 2>/dev/null; then
    echo "ERROR: failed to chown $DATA_ROOT_DIR to nodejs (UID 1001)." >&2
    echo "  The mounted volume root must be traversable by UID 1001 after the privilege drop." >&2
    echo "  Workaround: chown 1001:1001 the host directory you mounted at $DATA_ROOT_DIR." >&2
    exit 1
  fi
  if ! chown -R nodejs:nodejs $DATA_DIRS 2>/dev/null; then
    echo "ERROR: failed to chown $DATA_DIRS to nodejs (UID 1001)." >&2
    echo "  This usually means the host filesystem rejects chown (e.g. NFS without root squash" >&2
    echo "  disabled, or a SELinux/AppArmor policy blocking the operation)." >&2
    echo "  Workaround: pre-chown the host directories to 1001:1001 and pin 'user: \"1001:1001\"'" >&2
    echo "  in your compose file so this script never tries to chown them itself." >&2
    echo "  See https://docs.picpeak.app/deployment/docker#permissions" >&2
    exit 1
  fi
  exec su-exec nodejs:nodejs "$0" "$@"
fi

# Belt-and-suspenders: if we got here as non-root (compose `user:` override),
# verify the bind mounts are actually writable before proceeding. Failing
# loud here beats the previous behavior — silent mkdir-||-true at line 69
# followed by a confusing migration error and a restart loop.
_uid="$(id -u)"
_gid="$(id -g)"
for _dir in $DATA_ROOT_DIR $DATA_DIRS; do
  if [ ! -w "$_dir" ]; then
    echo "ERROR: $_dir is not writable by UID $_uid." >&2
    echo "  Either drop the 'user:' override from your compose file so the container starts as" >&2
    echo "  root and can self-fix permissions, or run on the host:" >&2
    echo "    chown -R $_uid:$_gid <host-mount-for-$_dir>" >&2
    echo "  See https://docs.picpeak.app/deployment/docker#permissions" >&2
    exit 1
  fi
done

# Explicit SQLite boots (DATABASE_CLIENT=sqlite3 — the all-in-one image's
# default, #1042) have no Postgres to wait for: skip the whole readiness/
# create/verify section below. The engine resolver further down still runs,
# still logs the resolved engine, and still refuses the populated-both
# conflict (#1038). Compose deployments pin DATABASE_CLIENT=pg and knexfile's
# production block defaults to pg when unset, so nothing changes for them.
if [ "${DATABASE_CLIENT:-}" != "sqlite3" ]; then

host="${DB_HOST:-postgres}"
port="${DB_PORT:-5432}"
user="${DB_USER:-picpeak}"
target_db="${DB_NAME:-picpeak}"

# Hand the app EXACTLY the connection this script verified. knexfile's
# production block defaults DB_HOST to `db` while this script defaults to
# `postgres`, so a bare `docker run` with no DB_HOST would have had the
# readiness check pass against one host and the app then dial another (#1038
# review). Compose sets DB_HOST explicitly and is unaffected.
export DB_HOST="$host"
export DB_PORT="$port"
export DB_USER="$user"
export DB_NAME="$target_db"
# Use target database for checks - the picpeak user may not have access to 'postgres' database
default_db="${DB_CHECK_DB:-$target_db}"

sanitize_identifier() {
  printf '%s' "$1" | sed "s/'/''/g"
}

echo "Waiting for PostgreSQL at $host:$port..."

# First, wait for PostgreSQL server to be reachable
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
  if PGPASSWORD="$DB_PASSWORD" psql -h "$host" -p "$port" -U "$user" -d "$target_db" -c '\q' >/dev/null 2>&1; then
    >&2 echo "PostgreSQL is up - database \"$target_db\" is accessible."
    break
  fi

  # If target DB doesn't work, try connecting to 'postgres' or 'template1' to create it
  if PGPASSWORD="$DB_PASSWORD" psql -h "$host" -p "$port" -U "$user" -d "template1" -c '\q' >/dev/null 2>&1; then
    >&2 echo "PostgreSQL is up - checking if database \"$target_db\" needs to be created..."

    # Check if database exists
    db_exists=$(PGPASSWORD="$DB_PASSWORD" psql -h "$host" -p "$port" -U "$user" -d "template1" -tAc "SELECT 1 FROM pg_database WHERE datname = '$(sanitize_identifier "$target_db")'" 2>/dev/null || echo 0)

    if [ "$db_exists" != "1" ]; then
      >&2 echo "Database \"$target_db\" not found. Attempting to create..."
      if PGPASSWORD="$DB_PASSWORD" psql -h "$host" -p "$port" -U "$user" -d "template1" -c "CREATE DATABASE \"$target_db\";" >/dev/null 2>&1; then
        >&2 echo "Database \"$target_db\" created successfully."
      else
        >&2 echo "Warning: Could not create database. It may already exist or user lacks permissions."
      fi
    fi
    break
  fi

  attempt=$((attempt + 1))
  >&2 echo "PostgreSQL is unavailable - sleeping (attempt $attempt/$max_attempts)"
  sleep 2
done

if [ $attempt -eq $max_attempts ]; then
  >&2 echo "Failed to connect to PostgreSQL after $max_attempts attempts."
  exit 1
fi

# Final verification - wait for target database to accept connections
until PGPASSWORD="$DB_PASSWORD" psql -h "$host" -p "$port" -U "$user" -d "$target_db" -c '\q' >/dev/null 2>&1; do
  >&2 echo "Waiting for database \"$target_db\" to accept connections..."
  sleep 2
done

>&2 echo "Target database \"$target_db\" is ready."

else
  >&2 echo "DATABASE_CLIENT=sqlite3 — skipping the PostgreSQL readiness wait."
fi # end Postgres wait (skipped for explicit sqlite3 boots)

# Ensure storage directories exist with proper permissions (Issue #67 fix)
# When host directories are bind-mounted, the container's built-in directories are overridden
# This ensures the required directory structure exists before the application starts
echo "Ensuring storage directories exist..."
STORAGE_BASE="${STORAGE_PATH:-/app/storage}"
mkdir -p "$STORAGE_BASE/events/active" "$STORAGE_BASE/events/archived" "$STORAGE_BASE/thumbnails" 2>/dev/null || true

# Backup destinations seeded by migrations 029 + 030 (/backup/picpeak and
# /backup/database). Creating the root alone is not enough: on a bind mount the
# subdirectories baked into the image are hidden and the backup services do not
# create them, so a backup would fail with ENOENT.
BACKUP_BASE="${BACKUP_DIR:-/backup}"
if [ -d "$BACKUP_BASE" ]; then
  mkdir -p "$BACKUP_BASE/picpeak" "$BACKUP_BASE/database" 2>/dev/null || true
fi

# Resolve which database engine this boot should use (#1038) BEFORE migrations
# run, while the Postgres target is still untouched. An install that has been
# unknowingly running on SQLite (the image used to leave NODE_ENV unset, so
# knexfile.js fell back to sqlite3 and ignored DB_HOST/DB_USER/DB_PASSWORD)
# keeps serving from its SQLite file instead of coming up against an empty
# Postgres. The exported value survives the `exec` below, so the migration
# runner and the server agree on the engine.
RESOLVED_DB_CLIENT="$(node scripts/resolve-db-engine.js)"
RESOLVER_STATUS=$?
# Exit 3 means two populated databases with no record of which is current
# (#1038). Starting either would hide the other's data, so stop here — the
# resolver has already printed what to do.
if [ "$RESOLVER_STATUS" = "3" ]; then
  exit 1
fi
# Validate rather than trust: anything unexpected on stdout (a stray log line
# from a library that writes to the console) must not become DATABASE_CLIENT,
# which would break knexfile for every process that follows.
case "$RESOLVED_DB_CLIENT" in
  pg|sqlite3)
    export DATABASE_CLIENT="$RESOLVED_DB_CLIENT"
    ;;
  "")
    >&2 echo "Database engine resolver returned nothing; falling back to the configured client."
    ;;
  *)
    >&2 echo "Database engine resolver returned an unexpected value; ignoring it and falling back to the configured client."
    ;;
esac

# Run migrations (use safe runner in production). Invoked via node directly —
# the runtime image no longer ships npm (see Dockerfile: its bundled deps kept
# tripping CVE scanners while npm itself never runs in production).
echo "Running database migrations..."
if [ "$NODE_ENV" = "production" ]; then
  node migrations/run-migrations-safe.js
else
  node migrations/run-migrations.js
fi

# Execute the main command
exec "$@"
