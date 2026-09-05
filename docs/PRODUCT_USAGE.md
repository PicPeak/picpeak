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
by migrations 201-205 on PostgreSQL and SQLite alike, and the engine-sensitive
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

### Versioned, explicit scope upgrades

New participants explicitly consent to usage.v2. Existing v1 participants stay
on v1 until they review and explicitly accept the expanded scope; migration 205
defaults their consent to v1. A signed consent command preserves the identity
and raw history. Collector confirmation atomically upgrades local consent and
resets the local used-marker observation period. Lost receipts/outages leave the
upgrade visibly pending and retryable, with v1-only collection until confirmed.
Opt-out still stops everything immediately. Deploy the v2 collector first.

The [complete feature and privacy matrix](FEATURE_COVERAGE.md) lists all 73
signals (19 existing, 54 new), all 81 current route families and 26 feature flags.
56 capabilities have configured/used booleans; 17 guest-facing or automatic
capabilities are configuration-only, without a used field. The full catalog is
available locally before consent in EN/DE and publicly in the usage portal.
Missing signals from older versions are unknown in aggregates, not unused.

### Participation lifecycle

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

Migration 204 adds bounded, local-only privacy receipts and removes any legacy
plaintext voting token from the last collector receipt. A completed export
records its time and report count; confirmed opt-out replaces this with a
deletion receipt containing only a random receipt ID, time, status and fixed
scope. It retains no old installation hash, key, payload or credential. The
settings page can download these receipts even after opt-out. They are local
records of the collector acknowledgement, not independent proof of storage
erasure. Downloaded exports carry their own dated receipt; the collector does
not create a permanent per-person access/export log.

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

The closed v1/v2 schemas are in `backend/src/usage/schema.cjs`, with signing in
`protocol.cjs`. Keep these and `features.v2.json` byte-identical to the collector's `protocol/` copies.
The collector serves its schema and complete source archive publicly. Aggregate
projections and the complete dataset are accessible to participating
installations only; raw reports require the installation's confidential lookup
hash. Raw exports contain the first accepted envelope of every unique usage
report. Re-signed transport retries are deduplicated; feedback, registration,
sessions and rejected requests are not usage reports. Full exports use a
consistent database snapshot at their start, not a 200-record total limit.
Feature semantics and retention are documented in its
`docs/PROTOCOL.md` and `docs/OPERATIONS.md`.

Public, reviewed testimonials are separate from marketing approval. Homepage
integrations must use `/api/public/marketing-testimonials`, never the general
portal testimonial feed. Each page is bounded and exposes its continuation
cursor. Deletion removes the source publication; operators must also remove
any externally copied content and follow the documented backup/log policies.

Used flags represent successful allowlisted admin capability calls since
consent to the current schema (v1: joining; v2: joining or explicit upgrade),
not visitor behavior or counts. OAuth marks successful admin SSO;
applied CSS is observed during report generation. Gallery layouts are controlled
enums extracted from event themes without IDs or counts. Other signals use the
explicit rules in `middleware/productUsage.js`, `usage/capabilityRules.js`,
`usage/capabilityEvidence.js`, `usage/expandedSnapshot.js` and `usage/UsageService.js`.

Tests: `backend/__tests__/routes/adminUsage.test.js`, frontend
`features/settings/__tests__/ProductUsageTab.test.tsx`, and the collector's
cross-repository integration suite with isolated databases and real HTTP.
