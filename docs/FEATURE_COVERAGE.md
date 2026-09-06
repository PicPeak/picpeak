# Product-usage coverage: usage.v3

Reviewed PicPeak baseline: a5ff9264 (3.124.1-beta.0), plus the usage integration.
The inventory covers 81 backend route families (80 product families plus usage),
all 26 feature flags and all current settings tabs. This is capability coverage,
not instrumentation of every UI field. Source of truth: `usage-coverage.v3.json`.
The prior `usage-coverage.v2.json` and v2 wire catalog remain available unchanged.

## Data scope

There are 86 capabilities: the original 19 in v1, 54 added in v2, and 13 added in
v3. 63 have configured/used booleans; 23 are configuration-only and omit `used`.
ML face recognition was already included: only effective availability and a
successful authenticated admin capability operation, never biometric results.

v3 additionally reports exactly two installation-wide integers under `inventory`:
current gallery records and non-video photo records. Counts include drafts and
retained archive records. They are not uploads, unique files or processing-success
counts. No grouping by gallery, customer, user, content, media format or source.
No extra entity rows are fetched: inventory is computed using database counts.
Each count is a nonnegative integer at most 1,000,000,000; invalid/out-of-range
counts fail rather than being silently rounded or truncated.

No identities, business values, documents, image contents, messages, IPs, domains,
URLs, filenames, secrets, biometric results, per-action timestamps or frequencies.
A stable reporter fingerprint and feature/count combinations remain pseudonymous,
not anonymous. Existing access controls and opt-out deletion apply to all fields.

`configured` means technical availability or configuration, not evidence of use.
`used` is one monotonic bit since confirmed consent to the reporting schema. It
means successful authenticated admin capability operation, not necessarily final
completion of a queued job. New operation-specific bits use trusted success
signals in their handlers; failed operations and no-op conversions do not count.
Configuration-only signals never observe visitor/customer activity. Total photo
records can include guest uploads without observing individual upload actions.

## Consent and version transition

- v1 and v2 keep their exact wire schemas and feature allowlists. Updating code
  does not grant consent or collect v3 markers/inventory for an older participant.
- The local EN/DE dialog lists all 86 capabilities and both inventory definitions.
  An unchecked checkbox requires explicit consent to `usage-consent.v3`.
- A signed v3 consent command upgrades v1 or v2 without changing identity/history.
  Prior queued operations finish first. Only a matching accepted receipt changes
  local consent and atomically clears previous local usage markers. Lost receipts
  remain retryable; a withdrawal always wins over a late upgrade receipt.
- Consent cannot downgrade. Older clients may continue sending their already
  consented older report schema. Old reports retain their original raw envelopes.
- Collector first, client second. Older collectors reject v3 rather than accepting
  undisclosed fields. No second report on the same UTC day; the first v3 report
  may be on the next day of admin activity.
- Summary/history count the latest report per reporter (per period for history).
  Missing older fields are unknown. Feature denominators use only supplied fields.
  Inventory has `{ total, reported }` per key; zero with `reported=0` means unknown,
  while zero with a positive denominator is a reported empty inventory. Never sum
  every daily report as if it were a different installation. Opt-out removes
  current and historical contributions, including these totals.

## Every reported capability

Definitions are shipped byte-identically in both applications as
`features.v3.json`, served at `/schema/features.v3.json`, and shown in EN and DE.

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
| `face_recognition` — ML face recognition / ML-Gesichtserkennung | usage.v1 | The faces capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
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
| `reminder_emails` — Automatic event reminders / Automatische Ereigniserinnerungen | usage.v2 | The reminderEmails capability switch is effectively enabled; only a boolean. | Not collected: configuration only. |
| `email_templates` — Email templates / E-Mail-Vorlagen | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `email_webhook` — Email webhook transport / E-Mail-Webhook-Transport | usage.v2 | Both email webhook settings are present; no URL or secret. | Successful explicitly initiated admin send/test through the webhook transport; no recipients, messages or automatic deliveries. |
| `accounting_incoming_invoices` — Incoming invoices / Eingangsrechnungen | usage.v2 | The incomingInvoices capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_expenses` — Expenses / Ausgaben | usage.v2 | The expenses capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_tax_report` — Tax reports / Steuerberichte | usage.v2 | The taxReport capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_ledger` — Ledger and accounting export / Kontenplan und Buchhaltungsexport | usage.v2 | The accounting capability switch is effectively enabled; only a boolean. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_installments` — Installment-plan tools / Ratenplan-Werkzeuge | usage.v2 | Quotes or invoices are enabled; no actual payment plans, amounts or statuses are inspected. | An admin saved an installment plan; no dates, amounts, currencies, payment status or document IDs. |
| `document_templates` — Document presets and blocks / Dokumentvorlagen und Bausteine | usage.v2 | Quotes or contracts are enabled, making document presets/blocks available; no template content. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `cms` — CMS pages / CMS-Seiten | usage.v2 | Built-in capability is available; this is not evidence of use. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `public_site` — Public landing page / Öffentliche Startseite | usage.v2 | The public landing-page setting is enabled; no page HTML, texts, domains or visitors. | Not collected: configuration only. |
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
| `gallery_feedback_likes` — Gallery likes enabled / Galerie-Likes aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_feedback_ratings` — Gallery star ratings enabled / Galerie-Sternebewertungen aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_feedback_comments` — Gallery comments enabled / Galerie-Kommentare aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_feedback_favorites` — Gallery favorites enabled / Galerie-Favoriten aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_feedback_reactions` — Gallery reactions enabled / Galerie-Reaktionen aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_feedback_color_labels` — Gallery color labels enabled / Galerie-Farblabels aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_guest_accounts` — Guest identities enabled / Gastidentitäten aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_guest_uploads` — Guest uploads enabled / Gast-Uploads aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_downloads` — Gallery downloads allowed / Galerie-Downloads erlaubt | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `download_resolution_picker` — Download resolution picker enabled / Download-Auflösungswahl aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_client_access` — Client access enabled / Client-Zugang aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_watermarks` — Watermarks enabled / Wasserzeichen aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_image_protection` — Image protection enabled / Bildschutz aktiviert | usage.v2 | Enabled beyond the shipped defaults — a stronger protection level, canvas rendering, or right-click disabled — globally or on at least one gallery; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_reveal` — Gallery reveal enabled / Galerie-Enthüllung aktiviert | usage.v2 | Enabled in applicable gallery/global configuration; only existence across the installation, never gallery IDs or counts. | Not collected: configuration only. |
| `gallery_expiration` — Gallery expiration configured / Galerieablauf konfiguriert | usage.v2 | At least one gallery has an expiry configured; no dates, gallery IDs or counts. | Not collected: configuration only. |
| `photo_xmp_export` — XMP export / XMP-Export | usage.v3 | Built-in capability is available; this is not evidence of use. | An admin successfully generated an XMP export; no sidecars, filenames, ratings, selections or counts. |
| `photo_replacement` — Photo replacement / Fotoersetzung | usage.v3 | Built-in capability is available; this is not evidence of use. | An admin upload actually replaced a photo successfully; no filenames, matching values, IDs or counts. |
| `photo_admin_marks` — Photographer marks / Fotografenmarkierungen | usage.v3 | Built-in capability is available; this is not evidence of use. | An admin successfully saved their own photo mark; no rating, color, photo or admin identity. |
| `gallery_folders` — Gallery folders configured / Galerieordner eingerichtet | usage.v3 | An applicable global or gallery category is configured as a folder; no names, contents, counts or visitor activity. | Not collected: configuration only. |
| `transfer_upload_links` — PicTransfer upload links enabled / PicTransfer-Uploadlinks aktiviert | usage.v3 | PicTransfer is enabled and a non-deleted transfer allows unexpired uploads; no links, tokens, dates, recipients or uploads. | Not collected: configuration only. |
| `workflow_automation_enabled` — Workflow automation enabled / Workflow-Automation aktiviert | usage.v3 | The workflows module and at least one workflow are enabled; no names, graphs, triggers, decisions or runs. | Not collected: configuration only. |
| `s3_auto_import` — S3 automatic import enabled / Automatischer S3-Import aktiviert | usage.v3 | S3 media storage is configured and STORAGE_AUTO_IMPORT is enabled; no bucket, prefix, credentials, polling or imported objects. | Not collected: configuration only. |
| `crm_invoice_import` — Invoice import / Rechnungsimport | usage.v3 | The required product capabilities are effectively enabled; only a boolean. | An admin successfully imported an existing invoice; no PDF, invoice number, amount, currency, customer or payment status. |
| `crm_combined_billing` — Combined billing / Kombinierte Abrechnung | usage.v3 | The required product capabilities are effectively enabled; only a boolean. | An admin successfully created a combined bill; no hours, expenses, customer, documents or financial values. |
| `crm_monthly_billing_manual` — Manual monthly billing / Manuelle Monatsabrechnung | usage.v3 | The required product capabilities are effectively enabled; only a boolean. | An admin successfully released a monthly draft for delivery; actual email delivery is not measured. No scheduler activity, customer, cadence or invoice values. |
| `crm_document_conversion` — Document conversion / Dokumentumwandlung | usage.v3 | The required product capabilities are effectively enabled; only a boolean. | An admin successfully converted a quote or contract into a document or gallery; no content, links, acceptance states or automatic workflows. |
| `gallery_capture_date_sort` — Capture-date sorting configured / Sortierung nach Aufnahmezeit eingerichtet | usage.v3 | A gallery defaults to sorting by capture date; no capture dates, EXIF or visitor sorting actions. | Not collected: configuration only. |
| `download_original_filenames` — Original download filenames enabled / Originaldateinamen für Downloads aktiviert | usage.v3 | The original-download-filenames switch is enabled; no filenames or downloads are read or sent. | Not collected: configuration only. |

## Inventory totals

- `inventory.galleries` — Current number of gallery records, including drafts, inactive and archived galleries. Deleted galleries are excluded. One total for the installation, no breakdown or identifiers.
- `inventory.photos` — Current number of non-video photo records, including RAW, guest uploads and records of archived galleries. One total for the installation; not unique files, thumbnails, processing success or photo contents. Deleted records are excluded.

## Route-family decisions

| Family | Coverage | Boundary |
| --- | --- | --- |
| `acceptInvite.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `admin.js` | composition: no telemetry | Router composition / helpers; decisions are recorded for each mounted family. |
| `adminApiTokens.js` | configuration: `api_integration` | Only existence of a valid credential; no marker from token listing/creation, no scope, owner, token, expiry date or last-used time. |
| `adminArchives.js` | partial: `galleries`, `archive_management`, `photo_exports` | Admin archive/delete/restore/download initiation only; filenames, histories, storage sizes and polling excluded. |
| `adminAuth.js` | excluded: no telemetry | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminBackup.js` | partial: `backup`, `portable_backup`, `restore`, `s3_storage`, `s3_backups` | Admin backup initiation, portable export/import and successful S3 roundtrip test. Local export never implies S3; names, schedules, sizes, contents and history excluded. |
| `adminBusinessProfile.js` | excluded: no telemetry | Business identity/bank/tax-address configuration and VAT-code helper surface are not separate usage signals. Billing/accounting capabilities are covered without profiling the business. |
| `adminCalendar.js` | partial: `crm`, `crm_calendar` | Authenticated admin calendar retrieval is capability use; no calendar entries, dates, recurrence, availability or bookings. |
| `adminCategories.js` | partial: `gallery_categories`, `gallery_folders` | Admin category CRUD; no names, descriptions, colors or ordering values. v3 adds only: gallery_folders. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminCMS.js` | partial: `cms` | Admin CMS page CRUD only. Public page traffic, slug, HTML, text, links and media excluded. |
| `adminContracts.js` | partial: `crm`, `crm_contracts`, `document_templates`, `crm_document_conversion` | Admin contract/block operations only; no legal text, signatures, signing parties or customer signing events. v3 adds only: crm_document_conversion. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminCssTemplates.js` | configuration: `custom_css` | Only existence of enabled applied CSS and locally observed application, not editing/viewing templates or any CSS text. |
| `adminCustomers.js` | partial: `crm`, `crm_hours`, `customer_portal`, `crm_combined_billing`, `crm_monthly_billing_manual` | Successful admin CRM/hour-entry/invitation operations only. No customer/account names, IDs, rates, billed hours, payment state or portal behavior. v3 adds only: crm_combined_billing, crm_monthly_billing_manual. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminDashboard.js` | partial: `analytics_dashboard` | Admin analytics capability endpoint only; no stats, activities, health/CRM polls, underlying visitor data or dashboard values. |
| `adminDatabaseBackup.js` | partial: `backup`, `database_backup` | Admin database-backup initiation plus schedule-enabled boolean, no file data/history. |
| `adminDeals.js` | partial: `crm`, `crm_installments` | Admin installment-plan changes only. No actual plans, invoice links, amounts, paid states or deal reporting. |
| `adminDev.js` | excluded: no telemetry | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminEmail.js` | partial: `messaging`, `incoming_mail`, `smtp`, `email_templates`, `email_webhook`, `reminder_emails` | Admin message operation/template edit, actual successful manual send/test transport and non-skipped manual IMAP poll/test. Reminder flag configuration only. No automated sends/polls, received-message or recipient data, queue/log reads, mailbox addresses or templates. |
| `adminEventRename.js` | partial: `galleries` | Successful rename only, not validate-rename. No former/new names or identifiers. |
| `adminEvents/archiveBulk.js` | partial: `galleries`, `archive_management`, `photo_exports` | Admin archive/delete/restore/download initiation only; filenames, histories, storage sizes and polling excluded. |
| `adminEvents/crud.js` | partial: `galleries`, `gallery_guest_uploads`, `gallery_downloads`, `gallery_client_access`, `gallery_watermarks`, `gallery_reveal`, `gallery_expiration`, `gallery_sharing`, `custom_css`, `gallery_capture_date_sort` | Admin creation/edit/publish etc. set galleries; sharing has its own fixed key. Guest/download/protection/reveal/expiry are configuration only; themes contribute controlled layouts and CSS presence. No gallery metadata or guest action history. v3 adds only: gallery_capture_date_sort. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminEvents/downloadResolutions.js` | configuration: `download_resolution_picker` | Only whether a picker is configured globally or in a gallery. No chosen resolution, download event or counts. |
| `adminEvents/faces.js` | partial: `face_recognition` | Effective flag plus successful admin faces/people operation. No health polling, embeddings, names, groups, detections or visitor searches. |
| `adminEvents/helpers.js` | composition: no telemetry | Router composition / helpers; decisions are recorded for each mounted family. |
| `adminEvents/index.js` | composition: no telemetry | Router composition / helpers; decisions are recorded for each mounted family. |
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
| `adminInvoices.js` | partial: `crm`, `crm_invoices`, `crm_invoice_import` | Admin invoice operations only; no amounts, VAT/customer/payment values or payment-check responses. v3 adds only: crm_invoice_import. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminLedger.js` | partial: `accounting`, `accounting_ledger` | Admin ledger-account/VAT/mapping edits and ledger export initiation only; no account/currency/VAT identifiers or exported records. |
| `adminNewsletters.js` | partial: `newsletters` | Admin campaign changes/test/queue/cancel only. Recipient resolution, previews, subscriptions/unsubscribes, delivery/open/click data and automatic sending excluded. |
| `adminNotifications.js` | excluded: no telemetry | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminPhotoDimensions.js` | partial: `photo_processing` | Admin repair/regenerate/configuration initiation, never status polling or processing totals. |
| `adminPhotoExport.js` | partial: `photo_exports`, `photo_xmp_export` | Admin export initiation only; export filters, selected files, sizes and contents excluded. v3 adds only: photo_xmp_export. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminPhotos.js` | partial: `photo_management`, `photo_exports`, `photo_processing`, `video_uploads`, `camera_raw_uploads`, `s3_storage`, `s3_photo_storage`, `photo_replacement`, `photo_admin_marks` | Successful admin edits/exports and accepted upload evidence only. Chunk init/status, failed uploads and public downloads excluded. Only video/RAW/S3 booleans survive, never file metadata/EXIF/content. v3 adds only: photo_replacement, photo_admin_marks. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminProjects.js` | partial: `crm`, `crm_projects` | Admin project operations only; project/person names, business performance, metadata and totals excluded. |
| `adminQuotes.js` | partial: `crm`, `crm_quotes`, `document_templates`, `crm_document_conversion` | Admin quote/preset operations only; no quote content, prices, customer acceptance or signatures. v3 adds only: crm_document_conversion. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminRestore.js` | partial: `restore` | Admin restore initiation only, never file selection, content, progress, errors or timing. |
| `adminRoles.js` | partial: `admin_management` | Admin account/role management capability; no names, permissions, role labels, password reset operations or active-user counts. Auth/self-profile endpoints excluded. |
| `adminSettings.js` | partial: `custom_css`, `oauth`, `smtp`, `backup`, `s3_storage`, `video_uploads`, `camera_raw_uploads`, `public_site`, `branding`, `seo_customization`, `slideshow`, `download_resolution_picker`, `gallery_watermarks`, `database_backup`, `s3_auto_import`, `download_original_filenames` | Only specified configuration presence/booleans and explicit branding/SEO/slideshow operations. Generic settings reads, security policies, passwords, storage data, SMTP/OIDC credentials, custom HTML/CSS/SEO values excluded. v3 adds only: s3_auto_import, download_original_filenames. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminShortUrls.js` | partial: `gallery_sharing`, `short_links` | Admin short-link creation/deletion only; link/token/click metadata excluded. |
| `adminSystem.js` | excluded: no telemetry | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminSystemHealth.js` | excluded: no telemetry | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `adminTaxReport.js` | partial: `accounting`, `accounting_tax_report` | Admin tax report generation/export only; no totals, dates, tax regimes, geography or currency. |
| `adminThumbnails.js` | partial: `photo_processing` | Admin repair/regenerate/configuration initiation, never status polling or processing totals. |
| `adminTransfers.js` | partial: `transfers`, `transfer_upload_links` | Admin transfer CRUD/files/link management/download only. Public recipients, received-file data, upload and download statistics excluded. v3 adds only: transfer_upload_links. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `adminUsage.js` | excluded: no telemetry | Consent, inspection, export, feedback, voting, deletion and abandoning an unsignable deletion are explicit protocol operations; not product-use signals. Activity only triggers a due fixed report. |
| `adminUsers.js` | partial: `admin_management` | Admin account/role management capability; no names, permissions, role labels, password reset operations or active-user counts. Auth/self-profile endpoints excluded. |
| `adminVatCodes.js` | excluded: no telemetry | Business identity/bank/tax-address configuration and VAT-code helper surface are not separate usage signals. Billing/accounting capabilities are covered without profiling the business. |
| `adminWebhooks.js` | partial: `webhooks` | Active configuration existence plus successful admin manual test/replay enqueue. Actual network delivery/results/subscriptions/destinations excluded. |
| `adminWhatsapp.js` | partial: `whatsapp` | Effective configured sender and successful manual test only. No automated deliveries, phone numbers, templates or delivery statuses. |
| `adminWorkflows.js` | partial: `workflows`, `workflow_automation_enabled` | Admin workflow authoring/approval/test initiation only. Runtime triggers, payloads, execution frequency/results and public approvals excluded. v3 adds only: workflow_automation_enabled. Exact definitions are in features.v3.json; configuration-only signals never observe the public surface. |
| `analyticsTrackerProxy.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `auth.js` | partial: `oauth` | Only successful admin OIDC callback sets oauth. Password/gallery authentication, MFA, account claims and provider details excluded. |
| `customer.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `customerAuth.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `gallery.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `galleryFeedback.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `galleryGuests.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `protectedImages.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicCMS.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicContracts.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicFonts.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicNewsletter.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicPaymentCheck.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicQuotes.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicSettings.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicTransfer.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicTransferUpload.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `publicWorkflowApprovals.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `secureImages.js` | excluded: no telemetry | Public/customer/gallery/visitor surface or existing optional third-party analytics proxy: no product-usage middleware, callbacks, counters or report triggers. |
| `setup.js` | excluded: no telemetry | Bootstrap, passwords/MFA/session/profile, per-person notifications, developer helpers and operational health/update/log polling are outside the prioritization purpose. |
| `v1/events.js` | partial: `api_integration` | Single bit after successful admin-owned scoped API authentication. No request/response values; API requests do not trigger reports. |

## Excluded runtime

- Gallery/customer/public events and optional website analytics
- Automated newsletter, reminder, WhatsApp, webhook and IMAP jobs
- Security/audit logs, biometric embeddings and recognition results
- Operational health, migration, update and polling metrics
- Business/customer/user identities, geography, financial amounts and document contents; only explicit v3 inventory totals are permitted.
- Disabled calendarBooking and internal crmDevelopment; hosted future product #1111
- Image fragmentation: removed from current PicPeak, not a live capability
