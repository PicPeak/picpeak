# Security and quality audit — September 2026

## Summary

Static **security**, **architecture / spaghetti**, and **code-quality** audit of `origin/main` at **`7aa4c0cc`** (`3.135.2-beta.0`), re-checked against `origin/main` at **`4634f093`** (`3.142.0-beta.0`, 42 commits later) on 2026-09-24.

This PR adds the report as `docs/SECURITY_QUALITY_AUDIT_2026-09.md` — **no product code**. The follow-up fix PRs come out of the packaging table at the end. This body is the same text as the file.

| | |
|---|---|
| **Scope** | Auth/JWT, path containment, SSRF, uploads/transfers, backups/restore, gallery visibility, god files, duplication, multi-replica footguns, error handling, SQLite/PG boolean gaps |
| **Not in scope** | Full pentest, every line of every file, runtime exploit reproduction (except the Node `path.join`, knex/sqlite3 and `createReadStream` checks below) |
| **Method** | `git show 7aa4c0cc:<path>`, targeted greps, Node experiments, cross-check of interim claims, then a second claim-by-claim pass (review round 1) and a drift check against `4634f093` |

**Evidence levels**

- **Verified** — re-read at the cited file:line, and/or reproduced with Node.
- **Reported** — plausible from structure / pattern; re-verify before coding.
- **Rejected** — claimed in an interim pass or in round 0, then disproved (kept so nobody re-opens them).

**Line numbers** are from `7aa4c0cc`. Where main has moved since, the current line is given as `main:<line>`.

---

## Verdict

Main is in **strong shape** for a large self-hosted gallery + CRM. Recent GHSA-linked hardening is real: typed JWTs, event mass-assign deny-lists, zip-slip checks, CSV formula neutralization, SSRF DNS+pin, secret redaction on GET, `must_change_password` enforcement, analytics first-party proxy, `adminDev` env gate.

**No remote unauthenticated RCE / classic auth bypass** verified in this pass.

What remains is mostly:

1. **Defense-in-depth** on DB→disk paths (`../` via raw `path.join`), which a crafted `.picpeak` import can reach, and which serves `watermark_path` to gallery guests
2. **Process-crash shape** on unguarded `.pipe(res)` streams, one of them on a public route
3. **Structural debt** (god services/routes, dual mounts, copy-pasted helpers)

**Status on main at `4634f093`:** nothing below is fixed yet. PR 1580 (`951f8f20`) moved business-document paths and `events.hero_logo_path` to storage-relative form with lexical containment, but did not touch `archive_path` or the photo path columns. Line numbers shifted in `adminArchives.js` (+50), `adminSettings.js` (+86), `gallery/media.js` (+37/+64), `adminBackup.js` and `backupService.js`.

---

# 1. Security

## 1.1 Critical / High — exploitable now

None verified that an unauthenticated (or low-privilege gallery) attacker can hit without already having privileged write (admin / DB / malicious restore) or operator misconfig.

Closest items are M1 (guest-facing read once a path column is poisoned) and M2 (public route can crash the process). Both are Medium with explicit prerequisites.

---

## 1.2 Medium

### M1. DB-backed paths joined with `path.join(storage, dbPath)` — `../` escapes storage — Verified

**Node check (Darwin / Node path.posix behaviour used by the app):**

```text
path.join('/var/lib/picpeak/storage', '../../../etc/passwd')
  → /var/etc/passwd          // ESCAPES storage (four `..` would reach /etc/passwd)

path.join('/var/lib/picpeak/storage', '/etc/passwd')
  → /var/lib/picpeak/storage/etc/passwd   // does NOT escape (join ≠ resolve)
```

So the real hole is **relative `../`**, not absolute keys (see Rejected).

**Sites that use raw `path.join(storagePath, …)` without `safePathJoin` / `assertPathInside`:**

| Area | File (7aa4c0cc → main) | What is joined |
|------|----------------|----------------|
| Watermark send (local branch) | `backend/src/routes/gallery/media.js` 246–254 → `main:297-305` | `path.join(getStoragePath(), photo.watermark_path)` then `res.sendFile` — **served to gallery guests** once watermarking is on |
| Archive download stream | `backend/src/routes/adminArchives.js` 647–662 → `main:697-712` | `archive.archive_path` → `createReadStream` (also **no** `pipeStreamToResponse` error listener, see M2) |
| Archive restore / details / delete | same file 179–185, 231–232, 692–695 → `main:180-181, 232-236, 744-745` | `fs.stat` / `access` / unlink on joined path |
| Settings storage accounting | `backend/src/routes/adminSettings.js` 1877–1889 → `main:1963-1975` | walks `archive_path` |
| System storage | `backend/src/routes/adminSystem.js` 284–297 | same |
| Event cleanup helpers | `backend/src/routes/adminEvents/helpers.js` 206–208 → `main:221-223` | `path.join(storagePath, event.archive_path)` |
| Archive size backfill | `backend/migrations/core/197_add_event_archive_size.js:47` | `fs.stat` only |

**How the value gets there — Verified.** `picpeakImportService.js` 522–537 (`main:620`) loads each table's ndjson with `trx.batchInsert(table, prepared, 100)` and never checks `archive_path` or `watermark_path`. A super_admin who imports a crafted `.picpeak` (`adminBackup.js` 288), or is talked into importing one, plants a `../` value directly. On main, `relocateStoredPaths()` (`picpeakImportService.js` `main:472-483`, from PR 1580) rewrites only `STORED_PATH_COLUMNS` (`utils/storedPath.js:59-72`: business-document columns + `events.hero_logo_path`); `events.archive_path` and `photos.watermark_path` / `path` / `thumbnail_path` are not in the list. Migration 233 converts the same column list only.

The other prerequisite paths are a compromised DB or a future mass-assign regression. Today event update **strips** `archive_path` via `IMMUTABLE_EVENT_COLUMNS` in `adminEvents/crud.js` 1166–1178 (GHSA-3rqx).

**Contrast — already hardened:**

- Managed photo keys go through `photoResolver.js` + `safePathJoin` for local paths
- Contract/quote/invoice PDF reads document the same threat model in `utils/safePath.js` and use `assertPathInside`
- Zip extract uses `assertZipEntriesWithin` (`adminArchives.js` 259+, GHSA-jfhw-fj23-fx6x)
- Backup manifest paths use `safePathJoin` in places (`adminBackup.js` 582–695)
- `hero_logo_path` unlink goes through `resolveStoredPath` on main (`helpers.js` `main:233`) — lexical containment only, and only that column

**Fix shape:** both ends. Every DB→disk read/write through `safePathJoin(storageRoot, rel)` or `assertPathInside(abs, [storageRoot])`, **and** path-column validation on `.picpeak` import (reject `..` segments and absolute values for `archive_path`, `watermark_path`, `path`, `thumbnail_path`). A read-side fix alone leaves every future DB→disk site open to the same import. Ban raw `path.join(getStoragePath(), dbColumn)` in review.

---

### M2. Download streams use raw `.pipe(res)` — a public route can crash the process — Verified

`backend/src/services/transferService.js` 803–828 (photo deliverable 803/805, extra file 811–828):

```js
source.value.pipe(res);
// or
fs.createReadStream(source.value).pipe(res);
stream.pipe(res);
```

No `'error'` listener, and `backend/server.js` has no `uncaughtException` / `unhandledRejection` handler (still true on main). A source error mid-stream (a file removed between stat and the lazy open, or an S3 reset) therefore takes the backend down. The route is `GET /api/public/transfer/:token/download/:fileId`, no login (the download token is 256 bits, so the trigger is a race or storage error, not guessing).

**Same shape, missed in round 0:**

- `backend/src/routes/adminTransfers.js:388` and `:393` — raw pipes (admin).
- `backend/src/routes/adminArchives.js` 651–662 (`main:701-712`) — `fs.access` defaults to `F_OK`, so a directory or unreadable path passes the check and `createReadStream` then throws an unhandled `'error'`. Reproduced with `createReadStream('/tmp').pipe(...)`.

Gallery downloads already use `pipeStreamToResponse` (`utils/streamResponse.js`) after the #1128 class of "stream error after headers → unhandled crash". Transfers and archives did not get the same treatment. Note `gallery/media.js` uses `pipeStreamToResponse` on its S3 watermark branch (`main:294`) but `res.sendFile` on the local branch, which is fine (`sendFile` handles its own errors).

**Fix:** route all transfer and archive streams through `pipeStreamToResponse` with a context string (and `missingStatus` where appropriate); mirror the gallery tests that assert a stream error does not crash the process.

---

### M6. Backup rsync disables SSH host-key checks — Verified

```text
adminBackup.js:497   sshArgs.push('-o', 'StrictHostKeyChecking=no');
backupService.js:797 args.push('-e', `ssh -i ${sshKey} -o StrictHostKeyChecking=no`);
```

SSRF to private IPs is already blocked via `isHostAllowed` on the test path — this is **MITM on the path to an allowed public host** (credential / probe leakage on “test connection”, or silently wrong backup destination).

**Fix:** known_hosts file / fingerprint pin / trust-on-first-use with stored fingerprint in settings.

**Not injectable:** the `-e ssh -i ${sshKey}` string is safe because `validateRsyncParam` (`backupService.js:764`) allows only `[a-zA-Z0-9._/@:-]`, and only super_admin can set the key. The comment at `backupService.js:796` ("separate array elements") describes the opposite of what `:797` does. Lines on main: `adminBackup.js:609`, `backupService.js:841`; PRs 1642/1644 touched neither.

---

## 1.3 Low / hardening

### M3. Secure-image tokens are process-local — Verified, re-rated Low

`backend/src/services/secureImageService.js`:

- Issue: builds HMAC'd token, then **`this.tokenCache.set(token, tokenData)`** (~95–97)
- Verify: **`const cached = this.tokenCache.get(token); if (!cached) return { valid: false, reason: 'Token not found or expired' }`** — HMAC success is not enough without the Map hit
- Secret: `IMAGE_SECRET || JWT_SECRET + '_IMAGE_PROTECTION'`, then HMAC over `JWT_SECRET + imageSecret` (~73–75, ~108)

**Why Low:** PicPeak is single-process by design — `docs/single-container.md:231` ("No Redis, so nothing here scales horizontally — run one container"), the compose `backend` has a fixed `container_name`, and there is no Redis client in `package.json`. So the failure mode is a 403 after a process restart, only at `protection_level` enhanced/maximum (default `standard`, migration 038).

**Separate finding to check:** on main the shipped frontend never calls the secure-token flow — `frontend/src/services/secureToken.service.ts` is imported nowhere under `frontend/src`. Verify in the running app that full-size images still load at enhanced/maximum; if they do, the token path is dead code and this item collapses into cleanup.

**Related doc bug:** `.github/workflows/README-DOCKER.md:92` shows `replicas: 3`, which the single-container doc contradicts.

**Fix:** verify from signed payload (embed exp/uses/fingerprint claims) if the flow stays; otherwise delete it. Either way document "single replica".

---

### M4. Multi-replica: rate limits, IP blocks, backup mutex — Verified, re-rated Low

| Mechanism | Where | Problem |
|-----------|--------|---------|
| `suspiciousIPs` / `blockedFingerprints` / `rateLimitViolations` | `secureImageMiddleware.js` (in-process `Set`/`Map`, `main:13-15`) | Per-instance only |
| Image rate windows | `secureImageService.checkRateLimit` keyed in-process (`main:10-13`) | Same |
| Auth / general limiters | `rateLimitService.js` default `MemoryStore` (`:230, :297, :363`) | Same |
| Backup "already running" | `backupService.js` ~1075–1080 (`main:1130-1135`) `if (isRunning) return` | Two replicas can run overlapping backups |

**Why Low:** same reason as M3 — one container is the documented deployment. PRs 1570 and 1575 changed the limiter **key** (IPv6 /64 as one client), not the store.

**Fix:** if horizontal scaling ever becomes a goal, design the shared store first (Redis or DB row claim / advisory lock for backups). Until then, keep the single-replica statement in the docs and fix `README-DOCKER.md`.

---

### M5. PicTransfer public upload tokens ~30 bits — Verified, re-rated Low

`transferService.js` 35–39:

```js
// 6 chars ≈ 31 bits; brute force mitigated by per-route rate limiter + IP lockout
const UPLOAD_TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const UPLOAD_TOKEN_LENGTH = 6;
```

The alphabet has **31** characters, not 32, so 31^6 ≈ 2^29.7; the code comment's "≈ 31 bits" is slightly off too.

`publicTransferUpload.js`: unauthenticated; feature-flagged; per-minute limiters keyed by `rateLimitKey` (IPv6 /64); `tokenLock` IP lockout **before** multer. The lockout, however, is called with `clientIpForAudit(req)` (`publicTransferUpload.js:53-55, :66`), i.e. the full address, while the shared guard's own middleware uses `rateLimitKey(req)` (`utils/publicTokenGuards.js:97`). Rotating IPv6 addresses inside one /64 therefore gets around the lockout but not the limiter.

**Why Low:** a hit lands in the photographer's admin view, not the client's; the payoff is spam / unwanted files in someone's transfer, not photo theft. No total quota per transfer was found.

**Fix:** lengthen to ≥10 chars (or use high-entropy download-style tokens for upload too), key the lockout on `rateLimitKey(req)`, fix the comment.

---

### M7. Non-constant-time HMAC compare on image tokens — Verified, nit

`secureImageService.js` ~108–109 (`main:115`): `if (signature !== expectedSignature)`.

Reachable in theory only: `verifySecureToken` looks the whole token up in the Map before the compare, so a caller without the exact issued token never reaches it. Use `crypto.timingSafeEqual(Buffer.from(a,'hex'), Buffer.from(b,'hex'))` after a length check, for consistency.

---

### L1. Missing-roles schema fallback → `super_admin` — Verified

`sessionAccessService.js` ~55–64 (`main:56, :64`): on `isMissingRolesSchema(error)`, loads admin without roles join and **`Object.assign(account, { role_id: null, role_name: 'super_admin' })`**.

Narrower than it first looks: the classifier matches only PG `42P01`/`42703` or the exact SQLite messages. The residual gap is that on PG *any* missing column in the join projection (e.g. `roles.display_name`) raises `42703` and falls through to `super_admin`.

**Fix:** match the column name in the classifier; fail closed outside a versioned migration gate.

---

### L2. Dual mount of `adminBackup` — Verified

```text
server.js ~817:  app.use('/api/admin', adminRoutes);
admin.js  ~27:   router.use('/backup', backupRoutes);   // → /api/admin/backup

server.js ~825:  app.use('/api/admin/backup', require('./src/routes/adminBackup'));  // again
```

Same router registered twice on the same path. Confusing middleware order / double-init risk.

**Fix:** keep one mount (prefer the explicit `server.js` line or the `admin.js` aggregator — not both).

---

No practical effect today: it is the same router instance and the first mount answers every route. Still one mount too many.

---

### L4. Derived `IMAGE_SECRET` — Verified, not a weakness

Default `JWT_SECRET + '_IMAGE_PROTECTION'` — an HMAC key derived from a secret that is never exposed is sound. At most, offer a separate `IMAGE_SECRET` for key separation and document it.

---

### L5. Iframe sandbox posture — Reported

- Email preview: `EmailPreviewModal` uses `sandbox="allow-same-origin"` in places; Messages path prefers empty `sandbox` — align.
- Umami embed on `AnalyticsPage` — admin-configured URL, unsandboxed embed risk if tracker host is hostile (trusted-admin model, same as analytics proxy docs).

---

### L6. Client-facing `error.message` — Reported

Examples called out in quality pass: `adminPhotos.js` (~1726, 1801), `adminWhatsapp.js` (~183), `adminArchives.js` (~592). Prefer stable generic strings to clients; log full error server-side.

---

### L7. Analytics proxy DNS-rebinding residual — Verified (documented)

`analyticsTrackerProxy.js` header comments: host checked at config load; `fetch` resolves again; rebinding window up to `CONFIG_TTL_MS` (30s). Threat model = trusted admin + possibly hostile tracker. Same posture as S3/MinIO.

---

### L8. `jwt.verify` without issuer on some auxiliary paths — Reported

Auth middleware itself uses `algorithms: ['HS256'], issuer: 'picpeak-auth'`. Interim pass noted looser verify on logout / rate-limit skip paths (`auth.js`, `rateLimitService.js`) — confirm each call site still cannot mint privilege.

---

### L9. Setup wizard `/complete` — Verified shape

`setup.js` `POST /complete` is `adminAuth` only (any authenticated admin can mark wizard complete and lock system event-type deletion). Small privilege quirk, not a guest issue.

---

## 1.4 Rejected (do not re-open without new evidence)

### R1. `adminSettings` `GET /:type` shadows `/password/complexity` and `/storage/info` — Rejected

`router.get('/:type', …)` at ~907 is **one** path segment.  
`GET /password/complexity` (~984) and `GET /storage/info` (~1857) are **two** segments — Express does not match them with `/:type`.

Frontend calls work:

- `settings.service.ts` → `/admin/settings/storage/info`
- `settings.service.ts` → `/admin/settings/password/complexity`

Optional cleanup: still register static paths above `/:type` for human readability — not a live bug.

### R2. `LocalFsStorage._resolve` absolute keys escape via `path.join` — Rejected

Claim was `path.join(root, '/etc/passwd') → /etc/passwd`. On current Node:

```text
path.join('/storage', '/etc/passwd') → '/storage/etc/passwd'   // contained
path.resolve('/storage', '/etc/passwd') → '/etc/passwd'      // WOULD escape
```

LocalFs uses **`path.join`**, and already rejects normalized `..` segments (`LocalFsStorage.js` ~41–49). Absolute-key escape via join is false. Still worth adding resolve+`startsWith(root+sep)` for clarity and symlink safety (defense-in-depth), but do not treat as an open absolute-path RCE.

---

### R3. `formatBoolean` gaps on `.where(col, false)` (was L3) — Rejected

Round 0 claimed `middleware/guestAuth.js:46` (`is_deleted: false`), `routes/gallery/styles.js:23` (`is_enabled: true`) and `routes/gallery/downloads.js:439` (`allow_downloads` = `false`) miss on SQLite because the column holds `0`/`1`.

All three columns are `table.boolean` (migrations 078, 052, 135), and node-sqlite3 binds JS `false`/`true` as `0`/`1`. Reproduced with the repo's knex 2.5.1 + sqlite3 5.1.7 in memory:

```text
where {is_deleted:false}   → rows inserted as false AND as 0
where('is_deleted', true)  → rows inserted as true AND as 1
sql: select * from `t` where `is_deleted` = ?   bindings: [ false ]
```

On PG they are real `boolean` columns, so `= false` is valid there too. The downloads case is covered on migrated SQLite by `galleryDownloadAllCategoryCache.test.js` ("streams the filtered archive instead of the prebuilt zip"), which passes.

The real SQLite boolean bug class is JS-side strict comparison of *read* values (`row.allow_downloads === false` against `0`), fixed in issue 1028 and covered by `gallerySqliteBooleanFlags.test.js`. Do not build a follow-up package on this.

---

## 1.5 Verified hardened (preserve — do not regress)

| Area | Evidence |
|------|----------|
| Token type enforcement | `sessionAccessService.assertActive(session, type)`; gallery rejects non-`gallery` (`gallery.js` ~104–106); guest requires `type === 'guest'`; admin preview requires `type === 'admin'` |
| `must_change_password` | Enforced in `adminAuth` with exempt paths only change-password + logout |
| Share link ≠ password bypass | Share-login returns `requires_password` without minting JWT when password required |
| Event mass-assign | `IMMUTABLE_EVENT_COLUMNS` includes identity, tokens, hashes, `archive_path`, lifecycle flags (`adminEvents/crud.js` ~1166+) |
| Ownership | `requireEventOwnership`, `scopeEventsListQuery`, `withoutForeignEventSecrets`, `filterOwnedEventIds` |
| Zip-slip | `assertZipEntriesWithin` on archive restore |
| CSV formula | `neutralizeSpreadsheetFormula` / `spreadsheetSafe.js` on feedback, guests, ledger, tax, photo export, archives |
| SSRF | `networkValidation.isHostAllowed` + pinned requests on webhooks, email webhook, S3 endpoint, SMTP/IMAP, analytics proxy path allowlist + private-IP check in production |
| Secret redaction | Backup S3/rsync keys, SMTP, OIDC, recaptcha, analytics API keys masked on GET |
| XSS | DOMPurify on CMS / welcome / markdown / legal; CSS sanitizer blocks `@import` / escapes |
| Feature flags | Server-side re-checks on tax report, transfers, CRM surfaces; `adminDev` needs flag **and** `PICPEAK_ENABLE_DEV_TOOLS=1` |
| Static uploads | Only logos/favicons via `secureStatic`; contracts/transfers not an open tree |
| Env | Short/example `JWT_SECRET` rejected in `validateEnv` |
| Authz regressions | `backend/__tests__/routes/authzPermissionGaps.test.js` (API tokens, event mass-assign, category hero) |

---

# 2. Architecture / spaghetti

## 2.1 God files (LOC at `7aa4c0cc` → `4634f093`)

| LOC | Path | Why it hurts |
|-----|------|----------------|
| 2970 → 2982 | `backend/src/services/quoteService.js` | CRUD + PDF/email + convert; **lazy-requires `invoiceService`** and **`../routes/adminEvents/helpers`** at ~2387 (service → route layer inversion) |
| 2388 → 2551 | `backend/src/services/pdfService.js` | Quote/invoice/contract drawing + QR/EPC in one module |
| 2303 → 2389 | `backend/src/routes/adminSettings.js` | Settings + branding + SSO + storage + SEO + rate-limit + public-site in one router (~37 `db(` touchpoints) |
| 2009 → 2075 | `backend/src/services/restoreService.js` | High blast-radius restore in one file |
| 1835 → 1920 | `backend/src/routes/adminPhotos.js` | Upload / chunked / bulk / serve mixed (~35 `db(`) |
| 1808 → 1842 | `backend/src/routes/adminEvents/crud.js` | Event lifecycle still monolithic despite `adminEvents/` split |
| 1748 | `frontend/src/pages/public/ContractResponsePage.tsx` | Multi-flow public page (invite / sign / countersign) |
| 1687 | `frontend/src/components/gallery/GalleryView.tsx` | Filters, people, feedback, hero, layout, downloads; heavy prop fan-out |
| 1404 | `frontend/src/components/gallery/PhotoLightbox.tsx` | Lightbox god |
| 1376 → 1421 | `backend/server.js` | ~70+ `app.use('/api/...')` registrations |
| 1321 | `backend/src/routes/adminEmail.js` | Template/queue logic in routes |
| 1249 | `backend/src/routes/adminBackup.js` | Backup admin surface |

**Refactor templates that already work:** `services/invoice/*` (split modules), `services/contract/*`, `routes/adminEvents/*` (index + focused files). Apply the same to quotes, settings, photos, PDF-by-document-type.

---

## 2.2 Circular / tangled deps — Reported

Lazy `require` cycles observed among:

- `quoteService` ↔ `invoice/*`
- `contractService` ↔ `signingV2` ↔ `signatures` ↔ `publicView`
- `emailProcessor` ↔ `newsletterService`
- `eventService` ↔ `eventCreationService`
- `imageProcessor` ↔ `videoProcessor`

Keep lazy requires only until dependency inversion lands; do not add new cycles.

---

## 2.3 Dual registration / dual auth surfaces — Verified, one live finding

| Pattern | Detail |
|---------|--------|
| Backup double-mount | L2 above |
| Photos two URL trees | `admin.js` mounts photos under `/api/admin/events`; `server.js` also mounts `adminPhotos` at `/api/admin/photos` (plus `adminPhotoDimensions` on the same prefix) |
| Admin session endpoints | Password change / logout exist under `/api/admin/auth/…` (`adminAuth.js`) **and** `/api/auth/admin/change-password`, `/api/auth/logout` (`auth.js`) |

**The finding:** `auth.js:840` `POST /api/auth/admin/change-password` has **no `adminAuth`** in its chain — only three `body()` validators. It always answers 401 today (no `req.admin`), so it is dead but safe. Its body differs from the live `/api/admin/auth/change-password`: a different validator, no token reissue, no activity log. Anyone who "fixes" it by adding `adminAuth` opens a second, weaker path. **Delete it** rather than wire it up.

`auth-enhanced.js` is **gone** on main (0 files) — docs/mental model should say `auth.js` + `adminAuth.js` + `customerAuth.js` + `guestAuth.js`.

---

## 2.4 Copy-paste helpers — Verified

- **`getStoragePath`**: ~20+ local copies across routes/services/middleware (`multerConfig`, `adminCMS`, `adminContracts`, `adminPhotos`, `adminSettings`, `publicTransferUpload`, `v1/events`, `backupService`, `chunkedUploadService`, `fileWatcher`, `photoResolver`, …). Canonical: `config/storage.js`.
- **`convertToCSV`**: duplicated in `adminFeedback.js`, `adminImageSecurity.js`, `archiveService.js` while `neutralizeSpreadsheetFormula` is correctly shared from `spreadsheetSafe.js`.
- **Ownership / role checks**: mix of `requireEventOwnership` and ad-hoc `roleName === 'editor' | !== 'super_admin'` in events/photos/feedback — prefer the middleware helpers everywhere.
- **Usage feature JSON**: `backend/src/usage/features.v{2–5}.json` mirrored under frontend — generate one side or serve from API.
- **i18n size**: `en.json` ~439KB, `de.json` ~492KB — maintainability, not runtime spaghetti.

---

## 2.5 Frontend service-layer leaks — Reported

Most UI goes through `*.service.ts`, but ~27 components/pages still hit `config/api` directly (upload, restore wizard, backup history, some settings tabs, event information card, …). Drift risk vs typed services.

---

## 2.6 Migrations — Reported

Large migration set; most core migrations use `hasTable`/`hasColumn` guards. Widespread `hasColumnCached` in services masks incomplete rollouts — treat new `hasColumnCached` as a smell that a migration isn’t finished.

---

# 3. Code quality

### Q1. Hidden-photo guards inconsistent — Verified

Canonical helper: `utils/photoVisibility.js` → `canSeeHiddenPhotos(accessLevel)` (PIN-client only).

Still inlined in places:

- `gallery/downloads.js` ~94: `photo.visibility === 'hidden' && req.accessLevel !== 'client'`
- Multiple spots in `gallery/media.js` (~33, 63, 321, 437, 535)

Download-all path correctly uses `canSeeHiddenPhotos` (~425). Same rule today; easy to drift (e.g. forgetting portal `viaCustomer` semantics — note: portal guest-level tokens are **not** supposed to see hidden photos; only PIN-client).

**Fix:** always `isPhotoHiddenFromViewer` / `canSeeHiddenPhotos`; delete inlined duplicates.

---

### Q2. Fire-and-forget / empty catches — Reported

- `downloads.js` ~459–465: inserts with `.catch(() => {})` — download stats can silently skew; at least `logger.warn`
- `CarouselGalleryLayout.tsx` ~190, 211: empty `catch` after optimistic like — UI can stay wrong; revert + toast
- `secureImageMiddleware.js` ~359: `.catch(console.error)` bypasses structured logger

---

### Q3. `new Date()` into Knex inserts — Reported

Project Jest/SQLite landmine: Dates can store as `"[object Object]"`. Prefer `.toISOString()`. Quality pass flagged `backgroundProcessor.js`, `backupService.js` (backup_runs `started_at: startTime` ~1102 area), `eventCreationService.js`, `adminSettings.js`.

---

### Q4. TypeScript `as any` concentration — Verified count

`customerAdmin.service.ts` ~14×; also `events.service.ts`, gallery download tests, `PaymentCheckPage`, etc. Tighten API envelopes first on customer admin.

---

### Q5. `fileWatcher` magic numbers — Reported

`stabilityThreshold: 2000`, `pollInterval: 100` not env-tunable (unlike concurrency via `pLimit`). Ops pain on slow NAS.

---

### Q6. Archive restore writes raw booleans — style only

`adminArchives.js` ~602–603 (`main:652-653`) writes `is_archived: false` / `is_active: true` while sibling queries use `formatBoolean`. Works on both engines (see R3); use `formatBoolean` on writes for consistency, nothing more.

---

### Q7. Permission gaps that looked scary but are intentional — Verified

Automated scan of `adminAuth` without `requirePermission` on the same line found:

- `adminAuth.js` profile / logout / MFA — intentional
- `adminUsers.js` `/me/permissions` — intentional
- `adminDashboard.js` `/crm-stats` — **inline** `userHasAnyPermission(['bills.view','quotes.view'])` — OK
- `adminEventTypes.js` `/active` — any authenticated admin (dropdown feed) — product choice; document or gate if needed
- `setup.js` `/complete` — see L9

---

# 4. Suggested packaging (follow-up PRs)

Ordered by ROI × risk. Each should be its own PR with tests. Packages 1 and 2 have pre-auth or guest reach on a public repo, so they go first.

| # | Focus | Checklist IDs | Notes |
|---|--------|---------------|-------|
| 1 | Path containment, both ends | M1 | `safePathJoin` on watermark + archive + remaining DB→disk sites **and** path-column validation in `picpeakImportService`; include a `../` fixture that must 403 on read and be rejected on import |
| 2 | Stream error handling | M2 | `pipeStreamToResponse` on `transferService`, `adminTransfers`, `adminArchives` download; assert a stream error does not crash the process |
| 3 | Dead admin change-password route | §2.3 | Delete `auth.js:840`; collapse or document the dual photos URL trees; single backup mount (L2) |
| 4 | Image token flow | M3, M7, L4 | First confirm whether `secureToken.service.ts` is dead; then either signed-payload verify + `timingSafeEqual`, or delete the flow |
| 5 | Product / ops | M5, M6 | Longer upload tokens + /64-keyed lockout; SSH host-key pinning; fix the `:796` comment |
| 6 | Docs | M4 | State single-replica in `README-DOCKER.md` (drop `replicas: 3`) |
| 7 | Debt (no rush) | §2.1–2.2 | quote/PDF split; settings router split; GalleryView extraction |
| 8 | Hygiene | Q1–Q6, §2.4 | `canSeeHiddenPhotos` everywhere; one `getStoragePath`; one CSV helper; `formatBoolean` on writes |

**Already in flight from fork survey (issue 1563) — do not duplicate here:**

- Nodemon / `path.delimiter` restore roots → PR 1613 (merged)
- nginx `$http_host` → PR 1612 (merged)
- Gallery auto-login / download fallback / jest env / create-event toast → PR 1611 (merged)

---

## Test plan (this PR)

- [x] No runtime change (docs file only)
- [ ] When taking checklist items: fail-first Jest on the cited path; for M1 a `../` fixture must 403 on read and be rejected on import; for M2 assert stream errors do not crash the process

---

## How this was produced

Round 0: parallel review of `origin/main` @ `7aa4c0cc`, then re-verification of every Medium/Rejected claim at file:line (including Node `path.join` / `path.resolve` experiments). Interim false positives (R1, R2) are listed so they are not re-filed.

Round 1 (review on this PR, 2026-09-23): every Medium, every Verified Low, both Rejected items and Q1/Q6 re-read with `git show 7aa4c0cc:<path>`, plus knex/sqlite3 and `createReadStream` experiments. Outcome: L3 moved to Rejected (R3); M1 and M2 raised in wording (import-borne path, guest-facing `watermark_path`, public crash, three missed sites); M3, M4, M5 re-rated Low; M7 and L4 downgraded; §2.3 promoted to a finding.

Round 2 (2026-09-24): drift check of every cited site against `origin/main` @ `4634f093`. Nothing fixed; PR 1580 partially covers `hero_logo_path` only; line numbers updated above.

Not re-checked in rounds 1–2: R1, the Reported items (L5, L6, L8, §2.2, §2.5, §2.6, Q2–Q5).
