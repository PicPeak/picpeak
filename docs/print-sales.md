# Beta gallery print sales (#48)

Print sales has three connected slices on the shared product
catalogue: manufacturing-profile administration; known-customer photo/crop orders
with native invoices; and background preparation with reviewed manual fulfilment.
`printSales` and every gallery's shop switch default **off**.

This feature is beta. Production capacity on S3 and ARM64 has not been measured;
studios must validate their own storage, hardware and lab output before opening
a shop. The resource limits below are fixed constants, not admin settings.

## Configure and use

1. Enable **Product configurator**, **Billing** and **Print sales** in Settings →
   Features. Use an assigned, active customer-portal account for the buyer.
2. Create products/options in the shared product catalogue. Link each product to
   an active fixed-price CRM item with currency, option surcharges and output VAT.
   There is no second print price list or tax implementation.
3. Open **Settings → Print sales**. Choose the buyer policy and either one
   delivery-price item for all enabled countries or studio-defined delivery
   zones. Give each zone a name, explicit two-letter country codes and an
   optional ordinary CRM delivery-price item. A country can belong to only one
   zone; countries outside the configured list are unavailable. Delivery is its
   own taxable product line; all lines in an order must share currency and
   output VAT code. No delivery item means delivery is included in that zone.
4. Add each supported product/option combination as a manufacturing profile.
   Choose the shared options and matching CRM item; enter actual trim, bleed,
   safe insets and source/output DPI. Choose the output format/encoding, solid
   RGB delivery profile, background colour and allowed crop/whole-photo placement
   choices. Optional
   free-text supplier labels, production codes and multiline instructions carry
   into the frozen pack and the studio's private sheet. There is no lab directory, preferred
   supplier or supplier-specific preset. Verify the profile against the chosen
   supplier's specification, then enable the variant and use the standard
   settings save bar. Display dimensions do not determine artwork size.
5. The gallery owner enables ordering in the gallery's product settings. The
   enabling admin becomes its billing/fulfilment owner and must retain native
   billing/customer permissions. Order acceptance checks that live authority.
6. A verified assigned customer opens the gallery through the customer portal.
   The shop offers supported variants, drag/zoom/reset crops, whole-photo fit,
   per-photo copies and a basket scoped to that buyer's browser session. The same
   photograph can appear more than once with different products/crops. Delivery
   details are collected once; the server reuses the verified account email.
7. Ask PicPeak to prepare the order. A progress bar shows stored originals,
   completed print files and packaging; no invoice exists during preparation.
   Once the package is ready, review the frozen quotation, final tax/delivery
   total and policy. Explicit confirmation creates one product-only **native invoice**.
   The studio opens that invoice from the order and issues/sends it through
   normal CRM billing. The customer pays by bank transfer; native confirmed
   payments are authoritative. No invoice or payment email is sent by the shop
   itself. Preparing a new order must finish before confirmation or invoicing.
8. In Print sales, download the settled order's supplier ZIP and studio PDF,
   check the exact files, record the studio review, submit to the chosen lab
   manually, record its reference, and explicitly record dispatch/tracking.
   None of these buttons calls a supplier API or purchases anything.

The client acknowledges selected photographs, crops, quantities, prices, delivery
and policy (`photo-selection-v1`). This does not claim that the client approved
unfinished production files. The separate studio review binds the finished
artwork's byte identity. Shop configuration must not substitute for actual lab
testing, colour checks or physical sample approval.

The shared catalogue and production editor include 43 generic size helpers,
including separate metric and inch photographic sizes, squares and ISO A6–A2.
Production helpers also copy common added-bleed and safe-inset values into the
editable per-edge controls. Applying a production helper or changing the output
colour profile disables the variant until it is reviewed and enabled again.
Helpers do not create products, prices or supplier associations.

For the manual lab setup checklist, payment/lab-account boundary and a researched
proposal for optional studio-managed API connectors, see
[Print labs: manual setup and optional API connections](print-sales-labs.md).
That proposal does not add an API connection or automatic purchasing to this
implementation.

## Acceptance and billing guarantees

Ready quotations retain order-specific original bytes **before** acceptance, along with
source hashes, original filenames, EXIF-oriented geometry, manufacturing/profile
versions, the selected delivery zone, native configured lines, taxes, totals and
the policy. Queued preparations expire after 30 minutes; successful preparation
starts a fresh 30-minute review window, capped by gallery expiry. Catalogue,
pricing, billing-owner,
source and visibility changes require a new quotation, as do production or
delivery-zone edits. A shared gallery password or entered customer ID cannot
identify the buyer. Guests, PIN-only clients and admin previews cannot order.

Acceptance locks the catalogue/settings/order, verifies the buyer assignment and
request acknowledgement and creates the native invoice within the same database
transaction. It requires the finished stored originals, artwork, sheet and ZIP;
known rendering, encoding and size failures cannot create an invoice. Request
replay returns the existing preparation/order/invoice. Concurrent acceptance
cannot create another
obligation. Monthly/manual accumulation and automatic project-invoice appending
are bypassed. Each photo allocation retains its own invoice line position.

The immutable commercial/source snapshot is protected by SQLite and PostgreSQL
triggers. Contacts are stored separately so eventual privacy cleanup can remove
them. Financial option images use native invoice retention. A catalogue edit
never changes accepted work; a later source replacement never supplies new bytes
to an accepted order.

Partial payment, a cancelled invoice, an invoice whose frozen commercial content
changed, missing delivery details, unready/tampered files or an obsolete review
holds fulfilment. The native invoice must be fully settled without relying on a
success page or a user-supplied payment state. Native correction/refund accounting
stays authoritative. To withdraw an order, correct/cancel its invoice and any
live replacements first, then cancel the order before lab submission. Fulfilment
follows a replacement invoice only when it carries the same lines and totals; agree
revised selections as a new order rather than silently changing accepted artwork
or charges. Orders already submitted to a lab require manual cancellation/refund
resolution.

## Preparation, files and recovery

The normal backend starts a database-backed worker. One order is prepared at a
time across replicas. A claim UUID, heartbeat and compare-and-set publication
prevent an interrupted attempt from publishing over a newer attempt. Claims
older than five minutes can recover. Permanent image refusals stop immediately;
transient failures can retry up to three times. Confirmed orders have a
controlled studio repair action before lab submission. Failed unconfirmed preparations can be
discarded and prepared again without an invoice. Failure never rewrites the
invoice or pretends that received money is
unpaid. Feature withdrawal pauses new rendering and ordering while retaining
read access to retained orders through the admin API; downloads and fulfilment
require re-enabling the feature.

The existing isolated image worker performs metadata inspection and rendering.
Its profile allowlist accepts built-in sRGB and three fixed, CC0 RGB assets:
Adobe RGB (1998) compatible, Display P3 and ProPhoto/ROMM RGB. Arbitrary ICC paths
and uploads remain forbidden. New non-sRGB snapshots freeze the profile SHA-256;
the worker verifies that the prepared file embeds those exact ICC bytes before
publication. The studio sheet includes that identity. Each profile chooses
one encoding:

- JPEG: quality 1–100 and 4:4:4 or 4:2:0 chroma sampling (defaults 95 and 4:4:4).
- PNG: lossless compression level 0–9 (default 6).
- 8-bit TIFF: LZW, Deflate or no compression (default LZW).

All three use the frozen pixel size and embed the selected RGB profile without
copying camera EXIF/XMP/GPS. JPEG uses JFIF density, PNG uses pHYs and TIFF carries resolution
tags. Density metadata can round fractional DPI; derived pixel geometry and the
manifest retain the configured physical dimensions/resolution. New profiles
flatten transparency and whole-photo borders to the configured solid RGB
background (default white). The worker still accepts version-one frozen profiles
with their original JPEG defaults and transparency behaviour; accepted orders
are never upgraded by re-resolving their definitions. The Node child launch uses
`--jitless` (which disables WebAssembly) without the obsolete
`--no-expose-wasm` flag, so current Node versions can run the isolated renderer.
Delivery is 8 bits per channel, including ProPhoto. Select ProPhoto only for a
supplier that explicitly accepts 8-bit ProPhoto; a 16-bit workflow is not provided.
The Adobe-compatible asset is not Adobe's proprietary file and may not satisfy
suppliers that identify a profile by its exact description. The current raster
pipeline can normalise through sRGB/P3 before encoding; a wider destination is
not a guarantee of full source-gamut preservation.
There is no arbitrary ICC upload, CMYK conversion, soft-proof promise, canvas
wrapping, folded-card imposition or
album layout capability. Canvas-front/flat wall-art output must be a supported
single rectangle. Bleed is part of the selected artwork ratio; it is not a
supplier-specific mirror/wrap operation.

The supplier ZIP contains numbered `.jpg`, `.png` or `.tif` files as configured,
a version-two manifest mapping each file to its frozen source/profile/crop/quantity
and invoice position. A separate private studio PDF provides cropped
thumbnails, supplier instructions and delivery/checklist details. The manifest retains the frozen delivery selection and full production
profile. Manual submission and dispatch still apply to the whole order; supplier
labels do not implement separate shipments or API routing. A receipt is
not the order sheet. The sheet names the buyer and the retail total, so it is a
separate download and is not in the supplier pack. Review and lab submission re-verify file SHA-256 identities. Recording dispatch uses the recorded file identity without needing the stored bytes: files lost after lab submission must not prevent recording shipment. The sheet uses the invoice theme's
uploaded font when configured, otherwise the bundled Latin/Greek/Cyrillic font.
Configure a document font covering any other scripts used in delivery details.

Artwork is stored as each image finishes. The ZIP streams from those verified
objects instead of keeping the complete order and archive in memory. Admin file
downloads use the browser's download handling. Before release, the server checks
the file into a private temporary copy and rechecks the current order/payment;
correction or cancellation during preparation stops release. Allow temporary
space for a complete supplier pack; at most two downloads run per backend process.
HEAD checks authorisation and recorded file metadata without reading file bytes.
The actual download verifies only the requested file, once. Expensive download
and review verification share a two-operation limit per backend process.
The admin page observes the actual streamed download through a short-lived,
administrator-bound status record. Verification/capacity errors appear on the
page without a second full-file check or buffering the ZIP in the browser.
Status polling stops when the page closes; the browser can finish its download.
Completed transfers still need to be checked in the browser's downloads.
Temporary copies are removed after success, refusal or client disconnection;
leased temporary directories are swept after five minutes without a heartbeat.

Current bounds are 20 photo items, 1–100 copies each, 50 MiB per source and
200 MiB of captured originals per quotation. At most 20 unconfirmed preparations
wait globally, and two per buyer across galleries. A changed basket supersedes
its previous unconfirmed preparation. Only one order renders at a time. Existing
accepted work takes priority; at most 20 accepted orders can be queued/running
and at most 100 accepted orders await resolution per studio (10 per buyer).

A render profile allows at most 60 megapixels. Actual output is bounded to
256 MiB per image, 1 GiB of artwork per order, a ZIP of that artwork plus 8 MiB
of overhead, and an 8 MiB private PDF sheet. Space is reserved from pixel counts
(up to 4.5 bytes/pixel plus 1 MiB per image), rather than guessing compression
ratios. The actual encoded output must fit this allocation before confirmation.
Unconfirmed work reserves originals, artwork, ZIP and sheet together: at most
8 GiB installation-wide and 3 GiB per customer, including incomplete uploads and
failed objects awaiting deletion. Once preparation is ready, actual stored bytes replace the reservation.
These are admission limits, not preallocated disk space; accepted orders have separate count/retention limits and require
sufficient studio storage. Storage exhaustion fails preparation without invoicing.

The progress bar counts completed files, not elapsed time or an estimated finish
time. It polls only for the active review, resumes after reopening/refreshing,
and requires a fresh status check after a connection error. Only the opaque
preparation ID is retained alongside the existing session basket; address details
are not written to browser storage. Returning to the basket discards unconfirmed
work first. Expiry, discard and erasure stop late publication and promptly reclaim
files; a healthy in-flight upload keeps its staging reservation until it stops.
The review displays its deadline and disables confirmation when it expires.
Active preparation has a 30-minute work deadline, including repairs; cancelling,
expiry or loss of the worker claim aborts its image work and storage requests.

Source reads have a 60-second idle timeout which excludes downstream waiting. These limits are not an ARM64 throughput or
memory benchmark; image-resource policy may refuse earlier. Each image is held
only while processing that image; the ZIP streams from storage. Existing accepted
orders can have damaged files rebuilt from verified retained originals before
lab submission. The invoice and selections stay unchanged; the studio must
review the new artwork version. A missing retained original requires manual
resolution or restoration of that exact original. Healthy-file checks are a
no-op, and an order already submitted to a lab cannot be rebuilt through this action.
Prepared packages use the order ID and snapshot hash; before confirmation they
have no invoice number. The studio finds the attached invoice through the order.

Private objects live under `.print-sales/<order-id>/` using the normal local/S3
storage adapter. Normal backups, required-key recovery inventories and portable
exports/imports include them, **even when gallery photos are excluded**. Database
backups alone do not replace storage backups. Unfinished staging uploads are
not required backup objects. Recovery inventories account for committed print
files published after the initial listing and unconfirmed work removed during
capture; a missing file still retained by an order remains an error.
Retained print assets exceeding the configured backup file-size limit also fail
the restore point instead of silently producing an incomplete order backup.
Local atomic `.tmp.` files are excluded too. Portable exports privately capture
the retained print files before archiving, so a concurrent discard cannot remove
a catalogued ZIP source; allow staging disk space for those copies.
Capture, acceptance, rendering, retention and downloads participate in the native application-work drain; the
worker also stops/resumes with coordinated restore. Gallery deletion clears its
live order link on both normal and archived paths and retains order-specific
sources. It does not cancel paid work or its invoice.

Unaccepted quotations expire; abandoned sources become eligible for cleanup
after another day. Accepted unpaid/paid orders are retained until explicitly
resolved, independently of invoice due dates. Dispatched/cancelled artwork and
contacts are purged after 90 days from closure. Cleanup runs in batches. Native
customer erasure requires active accepted orders to be resolved first; terminal
order contacts are cleared and files scheduled for purge. Commercial/audit
snapshots and native financial records remain under their accounting retention
rules. This includes source filenames and specifications; document that in the
studio's retention policy. Failed/superseded render attempts are private and are
removed with terminal order assets, not exposed as current artwork.

## Validation and limits

Synthetic tests cover real core migrations, native HTTP authentication and CRM
invoice/payment services, optimistic settings, quote replay/concurrent acceptance,
multiple crops, delivery VAT, monthly-billing isolation, gallery deletion, both
payment/render completion orders, partial settlement, tampering, worker claim
recovery, bounded retry, retention, privacy and portable storage inclusion.
Additional cases run the actual isolated renderer for JPEG, PNG and TIFF and
inspect ICC/density, metadata stripping and transparent-source backgrounds.
They also cover frozen version-one profiles, exact delivery-zone pricing,
uncovered countries, zone edits and native delivery invoice lines.
The same integration suite is run on SQLite and local
PostgreSQL 18.4. Frontend tests cover confirmation, retry IDs, crop editing,
buyer-scoped baskets, conflicts and disabled-feature history.
Integration fixtures use local storage;
live S3-bucket ordering/restore and ARM64 capacity measurements
are not claimed.

Desktop (1365×1000) and phone (390×844) screenshots/browser checks use synthetic
fixtures and the real UI components. They are visual/interaction checks, not a
claim that a live shop, real payment or physical supplier product was tested.

Stripe/card collection, guest accounts, paid digital downloads, albums, supplier
API connectors, automatic invoice delivery and post-submission lab cancellation
are outside this release. Lab profile approval, physical samples and a controlled
deployment review remain necessary before opening an actual shop.

## Limits and manual recovery

- **Order size.** Actual files must fit the bounds above and finish preparation before an invoice can be requested. A failed preparation leaves the basket available for editing and retry; it does not silently lower quality or create a financial obligation.
- **Deleting an admin.** An admin with open print orders cannot be deleted until those orders are closed.
- **Corrected invoices.** After a Storno and reissue, fulfilment follows the replacement invoice, which must carry the same lines and totals and be fully paid.
- **Close order manually.** Once the original invoice is cancelled, an open order that can neither be cancelled nor dispatched (already at the lab, or reissued with different lines) is closed with a recorded reason. A replacement invoice must be fully paid or cancelled first; a paid one is noted on the activity log and refunded in native billing. This also releases customer erasure.
- **Feature switched off.** The Print sales tab hides, and preparation/release actions and file downloads stop, while retention keeps running. Authorised admins can still use the order actions API to `cancel` or `resolve` existing orders, subject to the same ownership, invoice-correction and state checks. Customer erasure can then proceed without re-enabling print sales. Review, repair, lab submission and dispatch require the feature to be on. Buyers see their order history only while the gallery's shop is open.

## Installation and recovery

Core migration `341_print_sales` adds three order/configuration tables, the gallery switches, the default-off feature flag and the `.print-sales` backup path. It reuses existing permissions and requires no payment-provider setup. The migration guards each gallery column independently so an interrupted SQLite upgrade can be rerun.
Migration `342_print_download_status` adds temporary download-attempt status.
It contains no paths or credentials and expires within an hour; cleanup runs
independently of production-file retention. Portable exports omit these rows.

Retention retries failed storage deletions without dropping their asset records or marking the order purged. Other orders continue through cleanup, and each failure is logged at error level with order/asset identifiers. Fix the storage access problem to let a later sweep complete. Native accounting records remain retained separately.

See [gallery print shopping](print-sales-shopping.md) for the buyer journey, crop controls and spatial scale; detailed PR validation and screenshots belong in the pull-request description.
