# Product-usage coverage: usage.v2

Reviewed PicPeak baseline: a5ff9264 (3.124.1-beta.0). Review scope:
all 81 current backend route families,
all 26 feature flags, admin routes/settings
and runtime/public boundaries. This is capability coverage, not instrumentation
of every UI field. Source of truth: `usage-coverage.v2.json`; the PicPeak inventory
test fails on an added/removed route family, literal route declaration or feature flag.

## Privacy decision

The purpose remains feature prioritization, fixes and maintenance from #1110.
Only **installation-wide booleans** and the existing fixed gallery-layout enums.
No user/customer/guest identity, business values, documents, photos, messages,
IP/domain/URL, per-action time, event IDs, frequencies or user-level history.
A stable installation fingerprint remains pseudonymous (not anonymous); rare
combinations can be distinctive. Participant-only dataset access and opt-out
deletion therefore remain mandatory.

Of 73 capabilities, 19 were already present in v1 and 54 are new in v2:
56 configured/used pairs and 17 **configuration-only** signals. Configuration-only
signals omit `used` entirely; this is deliberately not a false “unused” value.
Guest-facing capabilities are measured from technical configuration only, never
from actual likes, comments, uploads, downloads, newsletter interactions or views.

`configured` = current technical availability/configuration. Built-in means
available, not evidence of use. `used` = one monotonic yes/no bit since consent
to the current schema (v1: since joining; v2: since joining or explicit upgrade).
It means successful allowlisted **admin capability operation**, not necessarily
completion of a queued job. It is not an event log. Repeated operations do not
store anything more. The marker table contains only constant capability keys.

## Consent and version transition

- Existing participation and migration default to `usage-consent.v1`. A client
  update alone does not collect any of the 54 new local markers or report fields.
- The settings page presents the full local EN/DE catalog before v2 opt-in or
  upgrade; an unchecked checkbox requires an explicit decision.
- A signed `usage.v2 / consent` command updates the same installation, after all
  prior queued operations have finished. It preserves its raw history and lookup
  identity. No downgrade or automatic expansion occurs.
- Only a matching collector receipt upgrades local consent and atomically resets
  local usage markers. Until confirmation, collection remains v1, even if a
  receipt is lost. A pending consent is durable/retryable; opt-out always wins.
- No second report on the same UTC day. The first expanded report may be on the
  next day of admin activity. API integration use alone does not trigger a report.
- Collector must be deployed first. Old collectors reject the new schema;
  the client shows delivery pending instead of assuming consent or sending v2.
- v1 validation remains unchanged and old envelopes remain exportable exactly as
  first received. Raw history contains the original schema version on each packet.
- Aggregate projections include their schema version. Absent v2 fields in v1
  projections are **unknown**, never false. `reported` and `used_reported`
  supply each metric's real denominator. Configuration-only use has denominator
  zero and is displayed as “Not collected”, not 0% adoption.

## Every reported capability

The static bilingual definitions below are also shipped as
`features.v2.json` in both applications, exposed at
`/schema/features.v2.json`, and displayed in both usage interfaces.
“Since” is the schema in which a key was introduced; definitions here describe v2.
Legacy v1 semantics remain documented separately in the protocol reference.

| Key (EN / DE) | Since | Configured | Used |
| --- | --- | --- | --- |
| `crm` — Client management / Kundenverwaltung | usage.v1 | The clients capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_quotes` — Quotes / Angebote | usage.v1 | The quotes capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_invoices` — Invoices / Rechnungen | usage.v1 | The bills capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_contracts` — Contracts / Verträge | usage.v1 | The contracts capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_projects` — Projects / Projekte | usage.v1 | The projects capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_calendar` — Admin calendar / Admin-Kalender | usage.v1 | The calendar capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_hours` — Hours logging / Zeiterfassung | usage.v1 | The hoursLogging capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `customer_portal` — Customer portal / Kundenportal | usage.v1 | The customerPortal capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting` — Accounting / Buchhaltung | usage.v1 | The accounting capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `workflows` — Workflows / Workflows | usage.v1 | The workflows capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `newsletters` — Newsletters / Newsletter | usage.v1 | The newsletters capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `face_recognition` — Face recognition / Gesichtserkennung | usage.v1 | The faces capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `custom_css` — Custom CSS / Eigenes CSS | usage.v1 | Custom CSS is configured globally or applied through a gallery/theme/template; CSS text is not sent. | Applied CSS observed after consent, without observing visitors. |
| `oauth` — Admin SSO / Admin-SSO | usage.v1 | Admin OIDC is enabled and issuer/client configuration is present; no provider or credential values. | Successful admin SSO login; no account, identity-provider or session details. |
| `smtp` — SMTP delivery / SMTP-Versand | usage.v1 | An outgoing SMTP host is configured; no host, account, address or credentials. | A successful explicitly initiated admin SMTP test/send; no recipients or messages. |
| `whatsapp` — WhatsApp integration / WhatsApp-Integration | usage.v1 | The WhatsApp capability is enabled and a usable configuration is present; no phone number, token or template. | Successful admin integration test; no recipient, message or delivery history. |
| `backup` — Backups / Sicherungen | usage.v1 | A full or database backup schedule is enabled; no schedule, path, storage sizes or backup names. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `s3_storage` — S3 storage / S3-Speicher | usage.v1 | S3 is configured for media or backups; no bucket, endpoint, credentials or object keys. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `share_mounts` — External folders / Externe Ordner | usage.v1 | At least one gallery uses an external folder; only existence, no folder paths or gallery identifiers. | An admin initiated an accepted external-folder import; no scanned paths, files or counts. |
| `galleries` — Gallery management / Galerieverwaltung | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `photo_management` — Media management / Medienverwaltung | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `photo_exports` — Admin media export / Admin-Medienexport | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `photo_processing` — Media maintenance tools / Medien-Wartungswerkzeuge | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `archive_management` — Gallery archives / Galeriearchive | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `gallery_sharing` — Gallery sharing and QR / Galeriefreigabe und QR | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `short_links` — Short links / Kurzlinks | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `gallery_categories` — Photo categories / Fotokategorien | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `event_types` — Event types and presets / Ereignistypen und Vorlagen | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `slideshow` — Live slideshow / Live-Diashow | usage.v2 | The slideshow capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `transfers` — PicTransfer / PicTransfer | usage.v2 | The transfers capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `video_uploads` — Admin video uploads / Admin-Video-Uploads | usage.v2 | Video extensions are allowed in global upload settings; no uploaded-file metadata. | At least one admin video file was successfully stored/accepted; no names, formats, lengths, sizes or processing/visitor history. |
| `camera_raw_uploads` — Admin camera RAW uploads / Admin-Kamera-RAW-Uploads | usage.v2 | Camera RAW (DNG) is allowed in global upload settings; no camera models or EXIF. | At least one admin camera RAW upload was stored/accepted; only the capability bit, no filename or metadata. |
| `messaging` — Messaging tools / Nachrichtenwerkzeuge | usage.v2 | The messaging capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `incoming_mail` — IMAP intake / IMAP-Empfang | usage.v2 | Incoming mail is enabled and an IMAP configuration is present; no mailbox, server, folders or credentials. | A successful explicit admin connection test or non-skipped manual poll; no background intake, messages, attachments or counts. |
| `reminder_emails` — Automatic event reminders / Automatische Ereigniserinnerungen | usage.v2 | The reminderEmails capability switch is effectively enabled; only a boolean. | **Not collected. Configuration only.** |
| `email_templates` — Email templates / E-Mail-Vorlagen | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `email_webhook` — Email webhook transport / E-Mail-Webhook-Transport | usage.v2 | Both email webhook settings are present; no URL or secret. | Successful explicitly initiated admin send/test through the webhook transport; no recipients, messages or automatic deliveries. |
| `accounting_incoming_invoices` — Incoming invoices / Eingangsrechnungen | usage.v2 | The incomingInvoices capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_expenses` — Expenses / Ausgaben | usage.v2 | The expenses capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_tax_report` — Tax reports / Steuerberichte | usage.v2 | The taxReport capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_ledger` — Ledger and accounting export / Kontenplan und Buchhaltungsexport | usage.v2 | The accounting capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_installments` — Installment-plan tools / Ratenplan-Werkzeuge | usage.v2 | Quotes or invoices are enabled; no actual payment plans, amounts or statuses are inspected. | An admin saved an installment plan; no dates, amounts, currencies, payment status or document IDs. |
| `document_templates` — Document presets and blocks / Dokumentvorlagen und Bausteine | usage.v2 | Quotes or contracts are enabled, making document presets/blocks available; no template content. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `cms` — CMS pages / CMS-Seiten | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `public_site` — Public landing page / Öffentliche Startseite | usage.v2 | The public landing-page setting is enabled; no page HTML, texts, domains or visitors. | **Not collected. Configuration only.** |
| `branding` — Branding settings / Branding-Einstellungen | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `seo_customization` — SEO settings / SEO-Einstellungen | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `admin_management` — Admin and role management / Admin- und Rollenverwaltung | usage.v2 | The userManagement capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `api_integration` — HTTP API integration / HTTP-API-Integration | usage.v2 | An unrevoked, unexpired API credential exists; no tokens, names, scopes or owner data. | Successful authenticated HTTP API capability call; only this bit, never URLs, request values, token/owner IDs or call counts. Does not trigger a report. |
| `webhooks` — Outbound webhooks / Ausgehende Webhooks | usage.v2 | At least one active webhook is configured; no destinations, subscriptions, secrets or delivery logs. | Successful explicit admin webhook test/replay; no automatic or visitor-triggered deliveries. |
| `restore` — Restore / Wiederherstellung | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `portable_backup` — Portable PicPeak export/import / Portabler PicPeak-Export/Import | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `database_backup` — Database backups / Datenbanksicherungen | usage.v2 | Scheduled database backups are enabled; no schedules, file names or database contents. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `s3_photo_storage` — S3 media storage / S3-Medienspeicher | usage.v2 | S3 is the configured media backend and required credentials are present; no values are sent. | Successful admin media storage/accepted upload to S3; no buckets, objects or sizes. |
| `s3_backups` — S3 backup destination / S3-Sicherungsziel | usage.v2 | The configured backup destination is S3 with a bucket present; no bucket or credentials. | An admin started a backup to the configured S3 destination or a successful S3 test upload; local exports never imply S3 use. |
| `analytics_dashboard` — Existing analytics module / Bestehendes Analytics-Modul | usage.v2 | The analytics capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `feedback_moderation` — Feedback moderation / Feedback-Moderation | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `guest_management` — Guest administration tools / Gastverwaltungswerkzeuge | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `gallery_feedback_likes` — Gallery likes enabled / Galerie-Likes aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_feedback_ratings` — Gallery star ratings enabled / Galerie-Sternebewertungen aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_feedback_comments` — Gallery comments enabled / Galerie-Kommentare aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_feedback_favorites` — Gallery favorites enabled / Galerie-Favoriten aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_feedback_reactions` — Gallery reactions enabled / Galerie-Reaktionen aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_feedback_color_labels` — Gallery color labels enabled / Galerie-Farblabels aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_guest_accounts` — Guest identities enabled / Gastidentitäten aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_guest_uploads` — Guest uploads enabled / Gast-Uploads aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_downloads` — Gallery downloads allowed / Galerie-Downloads erlaubt | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `download_resolution_picker` — Download resolution picker enabled / Download-Auflösungswahl aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_client_access` — Client access enabled / Client-Zugang aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_watermarks` — Watermarks enabled / Wasserzeichen aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_image_protection` — Image protection enabled / Bildschutz aktiviert | usage.v2 | Enabled beyond the shipped defaults — a stronger protection level, canvas rendering, or right-click disabled — globally or on at least one gallery; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_reveal` — Gallery reveal enabled / Galerie-Enthüllung aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | **Not collected. Configuration only.** |
| `gallery_expiration` — Gallery expiration configured / Galerieablauf konfiguriert | usage.v2 | At least one gallery has an expiry configured; no dates, gallery IDs or counts. | **Not collected. Configuration only.** |

Gallery layouts (unchanged): `grid`, `masonry`, `carousel`, `timeline`,
`mosaic`, `gallery-premium`, `gallery-story`, `other`. Only set membership,
not how many galleries use a layout. Unknown names are normalized to other.

## Exact observation sources

PicPeak `backend/src/usage/capabilityRules.js` is the fixed method/path
allowlist; request paths, query/body/response values never leave the middleware.
Only the resulting constant keys reach `markUsed`, with active schema consent,
authenticated admin and 2xx response checks. Status/health polls are excluded.

Additional trusted success evidence in `capabilityEvidence.js`:
accepted admin file storage (video / DNG / S3 booleans only, not chunk
initialization), successful manual SMTP or email-webhook send/test, non-skipped
manual IMAP poll/connection test, successful manual WhatsApp test, and successful
S3 backup roundtrip test. SMTP vs webhook uses the actual selected transport
(including per-account SMTP overrides), not just environment presence.
Webhook test/replay means **accepted enqueue**, never remote delivery tracking.

`UsageService.snapshot` and `expandedSnapshot.js` inspect allowlisted settings,
effective flags and technical configuration existence. They do not query
customer/guest profiles, financial records, photos/EXIF, message/feedback bodies,
audit/security logs or delivery histories. Inherited technical defaults count as
configuration; disabled feature dependencies cannot be inferred as active.
Optional-module tables/columns are guarded. CSS/layout inspection maps locally
to presence/enums; no free-form CSS/theme content is sent.

OAuth is marked only by the successful **admin** OIDC callback, without claims
or provider metadata. S3 backup use is inferred only for backup operations
writing to the configured destination; a local DB/portable export is not S3 use.
Background jobs and public/customer/visitor handlers never record product use.

## Complete route-family decision matrix

Paths below are relative to PicPeak `backend/src/routes/`. “Partial” means only
the disclosed allowlist/evidence, not every endpoint in that file. All literal
route declarations are captured in the companion inventory, with excluded
methods remaining unobserved.

| Source | Decision / signals | Reason / limits |
| --- | --- | --- |
| `acceptInvite.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `admin.js` | composition | Router composition / helpers; decisions are recorded for each mounted family. |
| `adminApiTokens.js` | configuration: `api_integration` | Only existence of a valid credential; no marker from token listing/creation, no scope, owner, token, expiry date or last-used time. |
| `adminArchives.js` | partial: `galleries`, `archive_management`, `photo_exports` | Admin archive/delete/restore/download initiation only; filenames, histories, storage sizes and polling excluded. |
| `adminAuth.js` | excluded | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminBackup.js` | partial: `backup`, `portable_backup`, `restore`, `s3_storage`, `s3_backups` | Admin backup initiation, portable export/import and successful S3 roundtrip test. Local export never implies S3; names, schedules, sizes, contents and history excluded. |
| `adminBusinessProfile.js` | excluded | Business identity/bank/tax-address configuration and VAT-code helper surface are not separate usage signals. Billing/accounting capabilities are covered without profiling the business. |
| `adminCalendar.js` | partial: `crm`, `crm_calendar` | Authenticated admin calendar retrieval is capability use; no calendar entries, dates, recurrence, availability or bookings. |
| `adminCategories.js` | partial: `gallery_categories` | Admin category CRUD; no names, descriptions, colors or ordering values. |
| `adminCMS.js` | partial: `cms` | Admin CMS page CRUD only. Public page traffic, slug, HTML, text, links and media excluded. |
| `adminContracts.js` | partial: `crm`, `crm_contracts`, `document_templates` | Admin contract/block operations only; no legal text, signatures, signing parties or customer signing events. |
| `adminCssTemplates.js` | configuration: `custom_css` | Only existence of enabled applied CSS and locally observed application, not editing/viewing templates or any CSS text. |
| `adminCustomers.js` | partial: `crm`, `crm_hours`, `customer_portal` | Successful admin CRM/hour-entry/invitation operations only. No customer/account names, IDs, rates, billed hours, payment state or portal behavior. |
| `adminDashboard.js` | partial: `analytics_dashboard` | Admin analytics capability endpoint only; no stats, activities, health/CRM polls, underlying visitor data or dashboard values. |
| `adminDatabaseBackup.js` | partial: `backup`, `database_backup` | Admin database-backup initiation plus schedule-enabled boolean, no file data/history. |
| `adminDeals.js` | partial: `crm`, `crm_installments` | Admin installment-plan changes only. No actual plans, invoice links, amounts, paid states or deal reporting. |
| `adminDev.js` | excluded | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminEmail.js` | partial: `messaging`, `incoming_mail`, `smtp`, `email_templates`, `email_webhook`, `reminder_emails` | Admin message operation/template edit, actual successful manual send/test transport and non-skipped manual IMAP poll/test. Reminder flag configuration only. No automated sends/polls, received-message or recipient data, queue/log reads, mailbox addresses or templates. |
| `adminEventRename.js` | partial: `galleries` | Successful rename only, not validate-rename. No former/new names or identifiers. |
| `adminEvents/archiveBulk.js` | partial: `galleries`, `archive_management`, `photo_exports` | Admin archive/delete/restore/download initiation only; filenames, histories, storage sizes and polling excluded. |
| `adminEvents/crud.js` | partial: `galleries`, `gallery_guest_uploads`, `gallery_downloads`, `gallery_client_access`, `gallery_watermarks`, `gallery_reveal`, `gallery_expiration`, `gallery_sharing`, `custom_css` | Admin creation/edit/publish etc. set galleries; sharing has its own fixed key. Guest/download/protection/reveal/expiry are configuration only; themes contribute controlled layouts and CSS presence. No gallery metadata or guest action history. |
| `adminEvents/downloadResolutions.js` | configuration: `download_resolution_picker` | Only whether a picker is configured globally or in a gallery. No chosen resolution, download event or counts. |
| `adminEvents/faces.js` | partial: `face_recognition` | Effective flag plus successful admin faces/people operation. No health polling, embeddings, names, groups, detections or visitor searches. |
| `adminEvents/helpers.js` | composition | Router composition / helpers; decisions are recorded for each mounted family. |
| `adminEvents/index.js` | composition | Router composition / helpers; decisions are recorded for each mounted family. |
| `adminEvents/logo.js` | partial: `branding` | Successful admin logo operation only; image/filename/content excluded. |
| `adminEvents/qr.js` | partial: `gallery_sharing` | Admin QR generation only; no scans, tokens or URLs. |
| `adminEvents/resets.js` | partial: `galleries`, `gallery_sharing` | Admin gallery reset/sharing capability only; no password, recipient, token or reset statistics. |
| `adminEvents/slideshow.js` | partial: `slideshow` | Admin generate/disable/configure only, never kiosk viewers or slide advances. |
| `adminEventTypes.js` | partial: `event_types` | Admin event-type CRUD; preset contents/names excluded. |
| `adminExpenses.js` | partial: `accounting`, `accounting_expenses`, `accounting_incoming_invoices` | Admin expense/inbound-invoice operations; no financial values, suppliers, mileage/location, dates, receipt files or OCR text. |
| `adminExternalMedia.js` | partial: `share_mounts` | Only admin import operation; status/list/browse are not use. Snapshot checks external-path presence, never reports a path. |
| `adminFeatureFlags.js` | configuration: `crm`, `crm_quotes`, `crm_invoices`, `crm_contracts`, `crm_projects`, `crm_calendar`, `crm_hours`, `customer_portal`, `accounting`, `workflows`, `newsletters`, `face_recognition`, `slideshow`, `transfers`, `messaging`, `reminder_emails`, `accounting_incoming_invoices`, `accounting_expenses`, `accounting_tax_report`, `accounting_ledger`, `admin_management`, `analytics_dashboard` | Only allowlisted effective capability booleans. No marker from reading or saving feature flags. Disabled roadmap/developer flags excluded. |
| `adminFeedback.js` | partial: `feedback_moderation`, `gallery_feedback_likes`, `gallery_feedback_ratings`, `gallery_feedback_comments`, `gallery_feedback_favorites`, `gallery_feedback_reactions`, `gallery_feedback_color_labels`, `gallery_guest_accounts` | Admin moderation/word-filter operations only. Visitor feedback is not observed. Master-enabled per-gallery feedback-option booleans only; no contents, ratings, likes, colors, identities or word lists. |
| `adminGuests.js` | partial: `guest_management` | Admin guest management/export initiation only. No guest names, invitations, tokens, contact data, guest counts or visitor interactions. |
| `adminImageSecurity.js` | configuration: `gallery_image_protection` | Only gallery/global technical protection configuration existence. No security events, blocked IPs, request counts, threat scores or admin monitoring access. |
| `adminInvoices.js` | partial: `crm`, `crm_invoices` | Admin invoice operations only; no amounts, VAT/customer/payment values or payment-check responses. |
| `adminLedger.js` | partial: `accounting`, `accounting_ledger` | Admin ledger-account/VAT/mapping edits and ledger export initiation only; no account/currency/VAT identifiers or exported records. |
| `adminNewsletters.js` | partial: `newsletters` | Admin campaign changes/test/queue/cancel only. Recipient resolution, previews, subscriptions/unsubscribes, delivery/open/click data and automatic sending excluded. |
| `adminNotifications.js` | excluded | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminPhotoDimensions.js` | partial: `photo_processing` | Admin repair/regenerate/configuration initiation, never status polling or processing totals. |
| `adminPhotoExport.js` | partial: `photo_exports` | Admin export initiation only; export filters, selected files, sizes and contents excluded. |
| `adminPhotos.js` | partial: `photo_management`, `photo_exports`, `photo_processing`, `video_uploads`, `camera_raw_uploads`, `s3_storage`, `s3_photo_storage` | Successful admin edits/exports and accepted upload evidence only. Chunk init/status, failed uploads and public downloads excluded. Only video/RAW/S3 booleans survive, never file metadata/EXIF/content. |
| `adminProjects.js` | partial: `crm`, `crm_projects` | Admin project operations only; project/person names, business performance, metadata and totals excluded. |
| `adminQuotes.js` | partial: `crm`, `crm_quotes`, `document_templates` | Admin quote/preset operations only; no quote content, prices, customer acceptance or signatures. |
| `adminRestore.js` | partial: `restore` | Admin restore initiation only, never file selection, content, progress, errors or timing. |
| `adminRoles.js` | partial: `admin_management` | Admin account/role management capability; no names, permissions, role labels, password reset operations or active-user counts. Auth/self-profile endpoints excluded. |
| `adminSettings.js` | partial: `custom_css`, `oauth`, `smtp`, `backup`, `s3_storage`, `video_uploads`, `camera_raw_uploads`, `public_site`, `branding`, `seo_customization`, `slideshow`, `download_resolution_picker`, `gallery_watermarks`, `database_backup` | Only specified configuration presence/booleans and explicit branding/SEO/slideshow operations. Generic settings reads, security policies, passwords, storage data, SMTP/OIDC credentials, custom HTML/CSS/SEO values excluded. |
| `adminShortUrls.js` | partial: `gallery_sharing`, `short_links` | Admin short-link creation/deletion only; link/token/click metadata excluded. |
| `adminSystem.js` | excluded | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminSystemHealth.js` | excluded | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminTaxReport.js` | partial: `accounting`, `accounting_tax_report` | Admin tax report generation/export only; no totals, dates, tax regimes, geography or currency. |
| `adminThumbnails.js` | partial: `photo_processing` | Admin repair/regenerate/configuration initiation, never status polling or processing totals. |
| `adminTransfers.js` | partial: `transfers` | Admin transfer CRUD/files/link management/download only. Public recipients, received-file data, upload and download statistics excluded. |
| `adminUsage.js` | excluded | Consent, inspection, export, feedback, voting and deletion are explicit protocol operations; not product-use signals. Activity only triggers a due fixed report. |
| `adminUsers.js` | partial: `admin_management` | Admin account/role management capability; no names, permissions, role labels, password reset operations or active-user counts. Auth/self-profile endpoints excluded. |
| `adminVatCodes.js` | excluded | Business identity/bank/tax-address configuration and VAT-code helper surface are not separate usage signals. Billing/accounting capabilities are covered without profiling the business. |
| `adminWebhooks.js` | partial: `webhooks` | Active configuration existence plus successful admin manual test/replay enqueue. Actual network delivery/results/subscriptions/destinations excluded. |
| `adminWhatsapp.js` | partial: `whatsapp` | Effective configured sender and successful manual test only. No automated deliveries, phone numbers, templates or delivery statuses. |
| `adminWorkflows.js` | partial: `workflows` | Admin workflow authoring/approval/test initiation only. Runtime triggers, payloads, execution frequency/results and public approvals excluded. |
| `analyticsTrackerProxy.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `auth.js` | partial: `oauth` | Only successful admin OIDC callback sets oauth. Password/gallery authentication, MFA, account claims and provider details excluded. |
| `customer.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `customerAuth.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `gallery.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `galleryFeedback.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `galleryGuests.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `protectedImages.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicCMS.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicContracts.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicFonts.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicNewsletter.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicPaymentCheck.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicQuotes.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicSettings.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicTransfer.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicTransferUpload.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicWorkflowApprovals.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `secureImages.js` | excluded | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `setup.js` | excluded | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `v1/events.js` | partial: `api_integration` | Single bit after successful admin-owned scoped API authentication. No request/response values; API requests do not trigger reports. |

## Every admin settings tab

These 29 current SettingsPage tabs are also inventoried and tested against
the frontend TabType. Page navigation itself is not tracked.

| Tab | Capability / exclusion |
| --- | --- |
| `usage` | Explicit consent/report inspection/feedback is not itself adoption telemetry. |
| `features` | Only the allowlisted effective feature booleans; no settings visit/save marker. |
| `general` | `video_uploads`, `camera_raw_uploads`, `public_site`, `custom_css`. General technical upload/public-site/CSS configuration only; no title, URLs, limits, times, HTML or identity. |
| `events` | `galleries`, `gallery_guest_uploads`, `gallery_downloads`, `gallery_client_access`, `gallery_watermarks`, `gallery_image_protection`, `gallery_reveal`, `gallery_expiration`. Gallery operations and disclosed configuration only; no event/customer values or visitor use. |
| `eventTypes` | `event_types`. General admin event-type capability; no names or preset contents. |
| `branding` | `branding`, `gallery_watermarks`. Branding operation and watermark configuration only; no branding text, logos or colors. |
| `categories` | `gallery_categories`. Category management capability only; no names/order/category membership. |
| `thumbnails` | `photo_processing`. Admin processing settings/regeneration initiation only; no image data or progress. |
| `downloads` | `download_resolution_picker`. Configuration boolean only; no actual download/selection behavior or resolution values. |
| `styling` | `custom_css`. Presence/application only plus controlled gallery-layout enums, never CSS/theme values. |
| `cms` | `cms`, `public_site`. Admin page editing capability/public-site enabled only; no HTML, slugs or traffic. |
| `email` | `smtp`, `incoming_mail`, `messaging`, `email_templates`, `email_webhook`. Configuration and documented manual admin capability operations only; messages, recipients, automatic activity and mailbox values excluded. |
| `moderation` | `feedback_moderation`. Admin moderation/word-filter capability, never feedback content or visitor behavior. |
| `security` | Excluded password/MFA/session/rate-limit/security profiles and operations. |
| `sso` | `oauth`. Enabled/config-present and successful admin callback only; no claims/provider details. |
| `imageSecurity` | `gallery_image_protection`. Configuration presence only; no blocked-IP/security analytics or monitoring history. |
| `seo` | `seo_customization`. Admin SEO configuration operation only; no meta tags, URLs, robots or verification tokens. |
| `apiTokens` | `api_integration`. Valid credential presence and one successful scoped API capability bit; no tokens/scopes/owner metadata. |
| `webhooks` | `webhooks`. Active configuration and manual test/replay enqueue only; no delivery data. |
| `status` | Excluded operational health, diagnostics, resource data, update and storage polling. |
| `analytics` | `analytics_dashboard`. Analytics capability and admin aggregate-view use only; no embedded analytics results/tracker IDs or visitors. |
| `backup` | `backup`, `database_backup`, `portable_backup`, `restore`, `s3_backups`. Schedule presence/manual capability initiation only, no histories, sizes, paths or files. |
| `businessProfile` | Excluded business identity, bank accounts and addresses. |
| `crm` | `crm`, `crm_quotes`, `crm_invoices`, `crm_projects`, `crm_hours`, `customer_portal`, `crm_installments`. Only coarse module capabilities; no policies/amounts/customer/payment values. |
| `contracts` | `crm_contracts`, `document_templates`. Admin contract/template capability only; no legal text or signatures. |
| `reminderTemplates` | `reminder_emails`, `email_templates`. Reminder flag configuration and admin template editing only; no automatic reminder sends/recipients/content. |
| `accounting` | `accounting`, `accounting_incoming_invoices`, `accounting_expenses`, `accounting_tax_report`, `accounting_ledger`. Only module capabilities, no tax codes, rates, balances or business identity. |
| `whatsapp` | `whatsapp`. Configured integration plus manual test only; no phone numbers, tokens or automatic delivery. |
| `slideshow` | `slideshow`. Admin setup capability only; no kiosk viewers, slide progress or photos. |

## Every feature flag (configuration decisions)

| Flag | Signal / exclusion |
| --- | --- |
| `accounting` | `accounting`, `accounting_ledger`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `analytics` | `analytics_dashboard`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `bills` | `crm_invoices`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `calendar` | `crm_calendar`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `calendarBooking` | Excluded: disabled roadmap placeholder, not an implemented booking capability. |
| `clients` | `crm`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `contracts` | `crm_contracts`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `crmDevelopment` | Excluded: internal development/test helpers, not product adoption. |
| `customerPortal` | `customer_portal`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `expenses` | `accounting_expenses`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `faces` | `face_recognition`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `galleries` | `galleries`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `hoursLogging` | `crm_hours`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `incomingInvoices` | `accounting_incoming_invoices`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `incomingMail` | `incoming_mail`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `messaging` | `messaging`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `newsletters` | `newsletters`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `projects` | `crm_projects`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `quotes` | `crm_quotes`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `reminderEmails` | `reminder_emails`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `slideshow` | `slideshow`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `taxReport` | `accounting_tax_report`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `transfers` | `transfers`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `userManagement` | `admin_management`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `whatsapp` | `whatsapp`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |
| `workflows` | `workflows`. Only effective configuration boolean; dependency rules apply, no flag values/history beyond this boolean. |

## Deliberately excluded runtime and future features

- Gallery/customer/public events and optional website analytics
- Automated newsletter, reminder, WhatsApp, webhook and IMAP jobs
- Security/audit logs, biometric embeddings and recognition results
- Operational health, migration, update and polling metrics
- Business/customer/user identities, geography, amounts and document contents
- Disabled calendarBooking and internal crmDevelopment; hosted future product #1111
- Image fragmentation: removed from current PicPeak, not a live capability

The Messages and Reminder Emails implementations were reviewed as real features,
despite stale placeholder comments. Reminder Emails remains configuration-only.
Calendar booking is still a disabled placeholder and is not presented as a
working capability. This review does not approve any public visitor tracking,
even if another optional analytics integration is configured.

All exclusion decisions still permit the existing product functions themselves.
They restrict this usage program; they do not disable galleries, email or jobs.
Adding capabilities requires a documented scope review, updated inventory,
closed schema, both UI disclosures/docs and tests; a wider collection scope
requires renewed explicit consent, not a silent catalog expansion.

## Verification obligations

Required checks include unchanged v1 validation, closed v2 fields, all 73
configuration signals and privacy canaries, all route/flag decisions, no
configuration-only use, disabled/pending/upgrade/opt-out boundaries, mixed-version
denominators, byte-identical protocol/catalogs, EN/DE UI catalog consistency,
raw export and deletion, SQLite/PostgreSQL and paired local Docker/browser tests.
Test outcomes are recorded separately; this document is not a claim of legal
certification or proof that modified self-hosted clients report truthfully.
