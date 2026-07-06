# Database Migrations

This directory contains database migrations for the PicPeak photo sharing platform.

## Directory Structure

### `/core`
Essential migrations that are always run for new deployments. These include:
- `init.js` - Initial database schema creation
- Backup service tables (029-035)
- Gallery feedback tables (033)
- Pre-generated watermarks (061)

### `/legacy`
Migrations needed only when upgrading from older versions. New deployments can skip these as the core schema already includes all necessary tables and columns.

## For New Deployments

If you're deploying this application for the first time:
1. The `initializeDatabase()` function in `src/database/db.js` will create all necessary tables
2. Only migrations in the `/core` directory will be run
3. This ensures a clean, optimized database schema

## For Existing Deployments

If you're upgrading from an older version:
1. All migrations (both core and legacy) will be run in sequence
2. The migration system tracks which migrations have been applied
3. Only new migrations will be executed

## Running Migrations

```bash
# Development
npm run migrate

# Production
npm run migrate:prod
```

## Note on Duplicate Migration Numbers

The legacy directory contains renamed duplicates:
- `014_add_host_name_to_events_duplicate.js` (was duplicate of 014)
- `027_add_rate_limit_settings_duplicate.js` (was duplicate of 027)

These have been renamed to avoid conflicts while preserving the migration history.