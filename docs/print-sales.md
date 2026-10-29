# Experimental gallery print sales (#48)

This branch implements three connected slices on the merged shared product
catalogue: manufacturing-profile administration; known-customer photo/crop orders
with native invoices; and background preparation with reviewed manual fulfilment.
`printSales` and every gallery's shop switch default **off**. Nothing is deployed
or enabled by these source changes. The proposed initial boundaries have not
received maintainer agreement on #48.

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
   into the frozen pack and studio sheet. There is no lab directory, preferred
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
7. Review the frozen quotation, final tax/delivery total and policy. Explicit
   confirmation creates one product-only **native invoice** and queues artwork.
   The studio opens that invoice from the order and issues/sends it through
   normal CRM billing. The customer pays by bank transfer; native confirmed
   payments are authoritative. No invoice or payment email is sent by the shop
   itself. Preparation and payment can finish in either order.
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
Helpers do not create products, prices or supplier associations. Their evidence,
exact values and limitations are recorded in the
[market research](print-sales-market-research.md).

For the manual lab setup checklist, payment/lab-account boundary and a researched
proposal for optional studio-managed API connectors, see
[Print labs: manual setup and optional API connections](print-sales-labs.md).
That proposal does not add an API connection or automatic purchasing to this
implementation.

## Acceptance and billing guarantees

Quotations retain order-specific original bytes **before** acceptance, along with
source hashes, original filenames, EXIF-oriented geometry, manufacturing/profile
versions, the selected delivery zone, native configured lines, taxes, totals and
the policy. Quotations expire after 30 minutes. Catalogue, pricing, billing-owner,
source and visibility changes require a new quotation, as do production or
delivery-zone edits. A shared gallery password or entered customer ID cannot
identify the buyer. Guests, PIN-only clients and admin previews cannot order.

Acceptance locks the catalogue/settings/order, verifies the buyer assignment and
request acknowledgement and creates the native invoice within the same database
transaction. Request replay returns the existing order/invoice. Concurrent capture
requests return a retryable conflict; concurrent acceptance cannot create another
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
live replacements first, then cancel the order before lab submission. Automatic
rebinding to a reissued invoice is not implemented; agree revised selections as
a new order rather than silently changing accepted artwork or charges. Orders
already submitted to a lab require manual cancellation/refund resolution.

## Preparation, files and recovery

The normal backend starts a database-backed worker. One order is prepared at a
time across replicas. A claim UUID, heartbeat and compare-and-set publication
prevent an interrupted attempt from publishing over a newer attempt. Claims
older than five minutes can recover; three failures require explicit studio
retry. Failure never rewrites the invoice or pretends that received money is
unpaid. Feature withdrawal pauses new rendering and ordering while retaining
admin access to orders and prepared files.

The existing isolated image worker performs metadata inspection and rendering.
Its profile allowlist accepts built-in sRGB and three fixed, CC0 RGB assets:
Adobe RGB (1998) compatible, Display P3 and ProPhoto/ROMM RGB. Arbitrary ICC paths
and uploads remain forbidden. New non-sRGB snapshots freeze the profile SHA-256;
the worker verifies that the prepared file embeds those exact ICC bytes before
publication. The supplier sheet includes that identity. Each profile chooses
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
not a guarantee of full source-gamut preservation. See the research for details.
There is no arbitrary ICC upload, CMYK conversion, soft-proof promise, canvas
wrapping, folded-card imposition or
album layout capability. Canvas-front/flat wall-art output must be a supported
single rectangle. Bleed is part of the selected artwork ratio; it is not a
supplier-specific mirror/wrap operation.

The supplier ZIP contains numbered `.jpg`, `.png` or `.tif` files as configured,
a version-two manifest mapping each file to its frozen source/profile/crop/quantity
and invoice position, and a private
studio PDF with cropped thumbnails, supplier instructions and delivery/checklist
details. The manifest retains the frozen delivery selection and full production
profile. Manual submission and dispatch still apply to the whole order; supplier
labels do not implement separate shipments or API routing. A receipt is
not the order sheet. Every manual release re-verifies file SHA-256 identities.

Current bounds are 20 photo items, 1–100 copies each, 50 MiB per source, 200 MiB
of captured originals per quotation, two simultaneous captures globally and two
unexpired quotations per buyer (20 globally). At most 20 accepted orders can be
queued/running and at most 100 accepted orders await studio resolution (10 per
buyer). A render profile allows at most 60 megapixels; an order allows 64 MiB of
production image files and an 80 MiB ZIP. Lossless formats can reach these bounds
sooner; unsupported sizes are refused rather than silently reducing quality.
Reads have a 60-second timeout. These are conservative initial limits, not an
ARM64 throughput or memory benchmark; image-resource policy may refuse earlier.

Private objects live under `.print-sales/<order-id>/` using the normal local/S3
storage adapter. Normal backups, required-key recovery inventories and portable
exports/imports include them, **even when gallery photos are excluded**. Database
backups alone do not replace storage backups. Capture, acceptance, rendering,
retention and downloads participate in the native application-work drain; the
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
The final print-sales suite has 45 cases on each engine; the focused unit/image
and inventory suites have 162 cases, and the frontend workflow/regression set has
33. Native catalogue/CRM regressions (62 cases) and native-process protections
(17 cases) also pass. The output test asserts that a separate image worker is in
use before testing the encoders. Integration fixtures use local storage;
live S3-bucket ordering/restore and ARM64 capacity measurements
are not claimed.

Desktop (1365×1000) and phone (390×844) screenshots/browser checks use synthetic
fixtures and the real UI components. They are visual/interaction checks, not a
claim that a live shop, real payment or physical supplier product was tested.
Production build, TypeScript and lint are checked. The broader portable restore
containment suite needed `PICPEAK_IMPORT_WORKER_MEMORY_MIB=2048` on this Node 24
runner; its default budget intermittently refused restore workers. This changes
the test process only, not application defaults or print worker limits.

Stripe/card collection, guest accounts, paid digital downloads, albums, supplier
API connectors, automatic invoice delivery and post-submission lab cancellation
are outside this release. No existing private deployment or production data is
migrated by this branch. Lab profile approval, physical samples and a controlled
deployment review remain necessary before opening an actual shop.
