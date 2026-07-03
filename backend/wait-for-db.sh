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
if [ "$(id -u)" = "0" ]; then
  if ! chown -R nodejs:nodejs /app/storage /app/data /app/logs 2>/dev/null; then
    echo "ERROR: failed to chown /app/storage, /app/data, /app/logs to nodejs (UID 1001)." >&2
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
for _dir in /app/storage /app/data /app/logs; do
  if [ ! -w "$_dir" ]; then
    echo "ERROR: $_dir is not writable by UID $_uid." >&2
    echo "  Either drop the 'user:' override from your compose file so the container starts as" >&2
    echo "  root and can self-fix permissions, or run on the host:" >&2
    echo "    chown -R $_uid:$_gid <host-mount-for-$_dir>" >&2
    echo "  See https://docs.picpeak.app/deployment/docker#permissions" >&2
    exit 1
  fi
done

host="${DB_HOST:-postgres}"
port="${DB_PORT:-5432}"
user="${DB_USER:-picpeak}"
target_db="${DB_NAME:-picpeak}"
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

# Ensure storage directories exist with proper permissions (Issue #67 fix)
# When host directories are bind-mounted, the container's built-in directories are overridden
# This ensures the required directory structure exists before the application starts
echo "Ensuring storage directories exist..."
STORAGE_BASE="${STORAGE_PATH:-/app/storage}"
mkdir -p "$STORAGE_BASE/events/active" "$STORAGE_BASE/events/archived" "$STORAGE_BASE/thumbnails" 2>/dev/null || true

# Run migrations (use safe runner in production)
echo "Running database migrations..."
if [ "$NODE_ENV" = "production" ]; then
  npm run migrate:safe
else
  npm run migrate
fi

# Execute the main command
exec "$@"
