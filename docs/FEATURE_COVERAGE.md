# Product-usage coverage: usage.v6

## What the numbers mean

The 86 v4 capabilities have all been reviewed for the distinction between
availability, a present configuration, and observed use. v5 asks 87 questions:
six broad admin-management questions are replaced by precisely defined edit
signals, and one question measures real template-mail transport acceptance.
v6 asks the same 87 questions; its one change is that `webhooks` use counts
any successful delivery (HTTP 2xx), automatic or manual, instead of only an
explicit admin test/replay (issue 1740). Still one bit, no delivery data.
There are 64 configured/used pairs and 23 configuration-only signals.
Historical views retain all 94 keys separately. No old value is renamed,
backfilled, reinterpreted, or combined with its replacement.

- **Built in** is availability, never an adoption percentage. This applies to
  gallery/media management, export/maintenance/archive/share/short-link tools,
  restore/import, moderation, guest administration, XMP, replacement and marks,
  as well as the built-in editors. An operation remains the evidence of use.
- **Enabled / configuration present** can be the shipped default, an inherited
  value or an explicit choice. Flags and configuration-only signals do not
  establish deliberate setup, successful delivery, or visitor activity.
- **Observed since consent** is one monotonic boolean. It is not frequency,
  recent activity, the present configuration, or proof of a job's completion.
  Existing operation signals keep their documented boundaries (including
  explicit connection tests, accepted jobs and admin calendar/analytics reads).
- The six new edit signals compare accepted, persisted product values. Empty
  requests, timestamps, previews, unchanged saves and automatically seeded
  records do not establish editing. Restoring a different default does count
  as an edit. Missing setting baselines are conservatively not inferred.
- CMS editing means a real internal title/body change. Changing only a logo or
  external link does not establish internal content editing; no page-view
  hooks are added. Earlier customization is not inferred from row existence,
  creation/update timestamps, activity logs or current private contents.
- Template editing and template sending are independent. An unchanged shipped
  template can be sent. Sending means SMTP accepted at least one recipient or
  the configured mail webhook accepted the real message. Preview, test, raw
  composer and newsletter messages do not set this bit. It includes queued
  and background template mail, but proves neither receipt nor reading.

A false edit/use bit means no qualifying observation since accepted consent;
it must never be presented as proof of unchanged defaults or lifetime non-use.
Old reporters' missing new questions are unknown, not false.

## Privacy and consent

New observations contain only fixed allowlisted booleans. The existing two
installation inventory totals (galleries and non-video photo records) are
unchanged. No content, recipient, template name/key, category/event identifiers,
logo, business value, per-action count, timestamp or content hash is stored in
usage markers or transmitted. Comparisons take place locally in the existing
admin operation; no content is scanned to reconstruct past usage.

Reports retain the existing stable installation fingerprint, PicPeak version,
daily date/generation time and gallery-layout enum. They are pseudonymous,
not fully anonymous. Existing retention, access controls and deletion apply.

Every v1–v5 wire schema/catalog remains immutable. New evidence is retained only
under active, confirmed usage-consent.v6. The signed consent upgrade preserves
identity and raw history, finishes pending old packets unchanged and resets
markers only after the matching receipt. Opt-out wins over late receipts.
A marker write failure must not retry a successfully sent email.
Deploy the collector before the PicPeak client; existing clients keep working.

## Full audit

The table is the decision for every active v6 capability. The route/flag/settings
inventory is `usage-coverage.v6.json`; historical inventories remain unchanged.
Exact definitions are served at `/schema/features.v6.json` and disclosed in the
PicPeak EN/DE consent catalog. A retired broad management signal remains under
its original definition in the collector's earlier-measurements view/history.

| Capability | Availability/configuration | Evidence of use |
| --- | --- | --- |
| `crm` — Client management | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_quotes` — Quotes | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_invoices` — Invoices | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_contracts` — Contracts | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_projects` — Projects | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_calendar` — Admin calendar | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_hours` — Hours logging | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `customer_portal` — Customer portal | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting` — Accounting | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `workflows` — Workflows | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `newsletters` — Newsletters | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `face_recognition` — ML face recognition | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `custom_css` — Custom CSS | Technical configuration exists; may be a default, not activity. | Applied CSS observed after consent, without observing visitors. |
| `oauth` — Admin SSO | Technical configuration exists; may be a default, not activity. | Successful admin SSO login; no account, identity-provider or session details. |
| `smtp` — SMTP delivery | Technical configuration exists; may be a default, not activity. | A successful explicitly initiated admin SMTP test/send; no recipients or messages. |
| `whatsapp` — WhatsApp integration | Technical configuration exists; may be a default, not activity. | Successful admin integration test; no recipient, message or delivery history. |
| `backup` — Backups | Technical configuration exists; may be a default, not activity. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `s3_storage` — S3 storage | Technical configuration exists; may be a default, not activity. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `share_mounts` — External folders | Technical configuration exists; may be a default, not activity. | An admin initiated an accepted external-folder import; no scanned paths, files or counts. |
| `galleries` — Gallery management | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `photo_management` — Media management | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `photo_exports` — Admin media export | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `photo_processing` — Media maintenance tools | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `archive_management` — Gallery archives | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `gallery_sharing` — Gallery sharing and QR | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `short_links` — Short links | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `category_editing` — Category customization | Built in; display a label, not a percentage. | An admin created, changed or deleted a category since consent. Seeded categories, reading and unchanged saves do not count. No names, memberships or identifiers are retained. |
| `event_type_editing` — Event type customization | Built in; display a label, not a percentage. | An admin created, changed or deleted an event type since consent. Seeded presets, reading and unchanged saves do not count. No names, presets or identifiers are retained. |
| `slideshow` — Live slideshow | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `transfers` — PicTransfer | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `video_uploads` — Admin video uploads | Technical configuration exists; may be a default, not activity. | At least one admin video file was successfully stored/accepted; no names, formats, lengths, sizes or processing/visitor history. |
| `camera_raw_uploads` — Admin camera RAW uploads | Technical configuration exists; may be a default, not activity. | At least one admin camera RAW upload was stored/accepted; only the capability bit, no filename or metadata. |
| `messaging` — Messaging tools | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `incoming_mail` — IMAP intake | Technical configuration exists; may be a default, not activity. | A successful explicit admin connection test or non-skipped manual poll; no background intake, messages, attachments or counts. |
| `reminder_emails` — Automatic event reminders | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `email_template_editing` — Email template customization | Built in; display a label, not a percentage. | An admin created a nonempty template or saved a real subject/body change since consent. Defaults, unchanged saves, previews and sending are excluded. This does not establish the current customization of templates edited before consent. |
| `email_webhook` — Email webhook transport | Technical configuration exists; may be a default, not activity. | Successful explicitly initiated admin send/test through the webhook transport; no recipients, messages or automatic deliveries. |
| `accounting_incoming_invoices` — Incoming invoices | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_expenses` — Expenses | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_tax_report` — Tax reports | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `accounting_ledger` — Ledger and accounting export | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `crm_installments` — Installment-plan tools | Technical configuration exists; may be a default, not activity. | An admin saved an installment plan; no dates, amounts, currencies, payment status or document IDs. |
| `document_templates` — Document presets and blocks | Technical configuration exists; may be a default, not activity. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `cms_content_editing` — CMS content editing | Built in; display a label, not a percentage. | An admin saved a real change to an internal CMS page title or body since consent. Unchanged saves, external links, logos, seeded pages and page views do not count. This does not measure whether anyone read the page. |
| `public_site` — Public landing page | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `branding_editing` — Branding customization | Built in; display a label, not a percentage. | An admin changed branding settings, a theme or a logo since consent. Reading settings and unchanged saves do not count. A change can also restore a default; this is not a claim about the current design. |
| `seo_editing` — SEO customization | Built in; display a label, not a percentage. | An admin saved a real change to an allowlisted SEO setting since consent. Defaults, reading and unchanged saves do not count; no rules, paths or search-engine activity are collected. |
| `admin_management` — Admin and role management | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `api_integration` — HTTP API integration | Technical configuration exists; may be a default, not activity. | Successful authenticated HTTP API capability call; only this bit, never URLs, request values, token/owner IDs or call counts. Does not trigger a report. |
| `webhooks` — Outbound webhooks | Technical configuration exists; may be a default, not activity. | Successful delivery (HTTP 2xx) of any outbound webhook, whether triggered automatically by an event or by an explicit admin test/replay; no destinations, event types, payloads, timestamps or counts. |
| `restore` — Restore | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `portable_backup` — Portable PicPeak export/import | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `database_backup` — Database backups | Technical configuration exists; may be a default, not activity. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `s3_photo_storage` — S3 media storage | Technical configuration exists; may be a default, not activity. | Successful admin media storage/accepted upload to S3; no buckets, objects or sizes. |
| `s3_backups` — S3 backup destination | Technical configuration exists; may be a default, not activity. | An admin started a backup to the configured S3 destination or a successful S3 test upload; local exports never imply S3 use. |
| `analytics_dashboard` — Existing analytics module | Enabled switch/capability; may be a default. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `feedback_moderation` — Feedback moderation | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `guest_management` — Guest administration tools | Built in; display a label, not a percentage. | A documented successful authenticated admin capability operation was observed since consent to this schema. No actor, operation history, parameters or counts. |
| `gallery_feedback_likes` — Gallery likes enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_feedback_ratings` — Gallery star ratings enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_feedback_comments` — Gallery comments enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_feedback_favorites` — Gallery favorites enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_feedback_reactions` — Gallery reactions enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_feedback_color_labels` — Gallery color labels enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_guest_accounts` — Guest identities enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_guest_uploads` — Guest uploads enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_downloads_restricted` — Gallery downloads restricted | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `download_resolution_picker` — Download resolution picker enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_client_access` — Client access enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_watermarks` — Watermarks enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_image_protection` — Image protection enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_reveal` — Gallery reveal enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `gallery_expiration` — Gallery expiration configured | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `photo_xmp_export` — XMP export | Built in; display a label, not a percentage. | An admin successfully generated an XMP export; no sidecars, filenames, ratings, selections or counts. |
| `photo_replacement` — Photo replacement | Built in; display a label, not a percentage. | An admin upload actually replaced a photo successfully; no filenames, matching values, IDs or counts. |
| `photo_admin_marks` — Photographer marks | Built in; display a label, not a percentage. | An admin successfully saved their own photo mark; no rating, color, photo or admin identity. |
| `gallery_folders` — Gallery folders configured | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `transfer_upload_links` — PicTransfer upload links enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `workflow_automation_enabled` — Workflow automation enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `s3_auto_import` — S3 automatic import enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `crm_invoice_import` — Invoice import | Enabled switch/capability; may be a default. | An admin successfully imported an existing invoice; no PDF, invoice number, amount, currency, customer or payment status. |
| `crm_combined_billing` — Combined billing | Enabled switch/capability; may be a default. | An admin successfully created a combined bill; no hours, expenses, customer, documents or financial values. |
| `crm_monthly_billing_manual` — Manual monthly billing | Enabled switch/capability; may be a default. | An admin successfully released a monthly draft for delivery; actual email delivery is not measured. No scheduler activity, customer, cadence or invoice values. |
| `crm_document_conversion` — Document conversion | Enabled switch/capability; may be a default. | An admin successfully converted a quote or contract into a document or gallery; no content, links, acceptance states or automatic workflows. |
| `gallery_capture_date_sort` — Capture-date sorting configured | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `download_original_filenames` — Original download filenames enabled | Technical configuration exists; may be a default, not activity. | Not collected. No visitor/customer activity inferred. |
| `email_template_delivery` — Emails sent using templates | Built in; display a label, not a percentage. | At least one real template email was accepted by SMTP or the configured mail webhook since consent, including background sends. Previews, test messages and template-free messages are excluded. Acceptance does not prove receipt or reading. No template key, recipient, contents, message identifier, send time or count is stored in usage markers. |
