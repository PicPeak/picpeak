# Database Migrations

This directory contains database migrations for the PicPeak photo sharing platform.

## Directory Structure

### `/core`
Migrations that run on every deployment, new or existing:
- `001_init.js` - Initial database schema (calls `initializeDatabase()` in `src/database/db.js`)
- `029` onwards - every later schema change, numbered in sequence

### `/legacy`
Migrations `004` to `028`, needed only when upgrading from older versions. New deployments skip these, as the core schema already includes all necessary tables and columns.

Only `core/` and `legacy/` are read. A migration file placed directly in this directory is never run.

## For New Deployments

If you're deploying this application for the first time:
1. No migration has been recorded yet, so only migrations in the `/core` directory are run
2. `001_init.js` creates the base schema and the later core migrations build on it

## For Existing Deployments

If you're upgrading from an older version:
1. All migrations (both core and legacy) are run in number order
2. The `migrations` table tracks which migrations have been applied
3. Only new migrations are executed

## Running Migrations

```bash
# Development (run-migrations.js)
npm run migrate

# Production (run-migrations-safe.js)
npm run migrate:safe
```

The container entrypoint (`wait-for-db.sh`) runs the safe runner with `node migrations/run-migrations-safe.js` when `NODE_ENV=production` and `run-migrations.js` otherwise. The safe runner also detects a schema created before migrations were tracked and tolerates "already exists" errors.

## Note on Duplicate Migration Numbers

The legacy directory contains renamed duplicates:
- `014_add_host_name_to_events_duplicate.js` (was duplicate of 014)
- `027_add_rate_limit_settings_duplicate.js` (was duplicate of 027)

These have been renamed to avoid conflicts while preserving the migration history.
