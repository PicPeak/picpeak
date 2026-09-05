# Optional product usage and feedback (#1110)

Tracking is disabled by default. After updating, settings editors see a
dismissible invitation in the admin shell. Only explicit consent in Settings →
Product usage & feedback registers an installation. Public galleries never
load the usage UI chunk or trigger product reports.

The backend builds and signs allowlisted feature packets, sending them at most
daily on authenticated admin use. It does not send gallery visitors, click
histories, photo/gallery counts, names, emails, domains, filenames, or secrets.
The settings page provides disclosure, raw preview/export, a private lookup
hash, delivery status, feedback, and a short-lived voting connection.

## Deployment

Run the normal core migrations; migration 201 creates dedicated state/marker
tables. No identity or key is created by the migration. No extra browser
tracker or CORS policy is required. The collector is the separate
`picpeak-usage` app from [#1110](https://github.com/PicPeak/picpeak/issues/1110).

| Backend variable | Default | Meaning |
| --- | --- | --- |
| `USAGE_COLLECTOR_URL` | https://usage.picpeak.app | Fixed operator-configured collector origin, HTTPS in production |
| `USAGE_ENCRYPTION_KEY` | JWT_SECRET | 32+ characters, encrypts the local Ed25519 key with AES-256-GCM |

Both database engines are supported. The state and marker tables are created
by migrations 201-203 on PostgreSQL and SQLite alike, and the engine-sensitive
paths are covered by `__tests__/integration/productUsagePg.test.js` against a
real PostgreSQL — bigint columns come back as strings there, booleans are real
booleans rather than 0/1, and the marker write takes `SELECT ... FOR UPDATE`
only on that engine. That suite is gated behind `PICPEAK_PG_TEST_URL` and runs
in CI, which provides one.

If `USAGE_COLLECTOR_URL` is unset, empty or blank the built-in default
`https://usage.picpeak.app` is used. A value that is present but malformed is
reported as a configuration error rather than being replaced by the default:
silently retargeting a self-hosted collector at ours would send reports
somewhere the operator did not choose.

Local development can use an HTTP loopback collector outside production. The
collector URL is never writable through generic settings or request payloads.
Keep the encryption material stable and protected; losing it makes the old
identity unable to sign deletion requests. Note that `USAGE_ENCRYPTION_KEY`
defaults to `JWT_SECRET`, so rotating `JWT_SECRET` without setting a dedicated
`USAGE_ENCRYPTION_KEY` first loses it. The settings page then reports
`SIGNING_KEY_UNREADABLE` rather than a generic delivery failure, because the
consequence is specific: reports stop and the deletion request can no longer
be signed either. Keys live in a dedicated database
table, not the generic readable settings. A random mode-0600 file at
`getStoragePath()/usage-instance.key` binds the database to its local storage.

## Consent and deletion lifecycle

Disabled → activation pending → active. Registration/delivery failures are
durable and retried. Multiple admin tabs/processes share a database lease;
only accepted receipts advance the sequence and report date. Re-signed retries
reuse the immutable packet ID so lost acknowledgements do not duplicate data.

Opt-out immediately stops collection, clears markers/previews/feedback
preferences, and enters deletion pending. It keeps only credentials and the
deletion operation until the collector confirms deletion. The collector removes
reports, projections, feedback/publications, votes, and sessions. PicPeak then
erases the local fingerprint, private key and binding. A later join generates
a fresh identity. Repeated deletion handles lost receipts safely.

A missing/mismatched storage binding or conflicting collector sequence stops
reporting with identity conflict. A full clone of a signing identity cannot be
distinguished cryptographically. Do not run the same participation identity in
two deployments; disable/delete the old participation and rejoin. Deletion
affects any other copy that shared the same identity.

## Feedback and permissions

Only settings.edit can inspect identity/packets or change participation and
feedback preferences. Any authenticated admin may trigger the fixed daily
report; the activity endpoint accepts no telemetry input. Every usage endpoint
uses adminAuth, including token-type checks. Gallery tokens cannot use it.

Feedback is sent only on explicit submission. Each item defaults anonymous and
private; names, publication permission, and testimonial marketing permission
are separate choices. Published requests/testimonials require maintainer review.
Public voting uses a backend-authorized 15-minute session, never the lookup hash.

## Contract

The closed schema is in `backend/src/usage/schema.cjs`, with signing in
`protocol.cjs`. Keep both byte-identical to the collector's `protocol/` copies.
The collector serves the schema, complete source archive, public projections,
and full raw exports. Feature semantics and retention are documented in its
`docs/PROTOCOL.md` and `docs/OPERATIONS.md`.

Used flags represent successful allowlisted admin capability calls since
joining, not visitor behavior or counts. OAuth marks successful admin SSO;
applied CSS is observed during report generation. Gallery layouts are controlled
enums extracted from event themes without IDs or counts. Other signals use the
explicit rules in `middleware/productUsage.js` and `usage/UsageService.js`.

Tests: `backend/__tests__/routes/adminUsage.test.js`, frontend
`features/settings/__tests__/ProductUsageTab.test.tsx`, and the collector's
cross-repository integration suite with isolated databases and real HTTP.
