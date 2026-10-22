# Album product choices (experimental, #1924)

The **Album products** feature flag is off by default. It offers a gallery's primary client a photographed model/colour catalogue, records the choice and notifies the photographer in the native activity bell. It does not alter quotes, calculate prices, accept payment or place supplier orders.

## Photographer workflow

1. Enable Album products in Settings → Features.
2. In Settings → Album products, add a product, models and colours. Upload a PNG you have permission to display for each active option. Restrict colours to particular models if needed. Save the catalogue using the shared save bar.
3. In a gallery's Overview → Album configuration, assign an active product.
4. The client chooses a model and compatible colour within their gallery, enters their name and saves a draft or submits the choice.
5. Review the choice in the gallery's Overview and lock it when confirmed. Unlock explicitly if further changes are agreed. Hiding an offer immediately removes its client image and mutation access.

A primary-client gallery credential or assigned customer-portal session is required. Public visitors, guests and slideshow sessions cannot read or change choices. An admin preview is read-only. The entered client name is an audit label, not a verified signature.

## Permissions and change handling

`products.view` reads the catalogue and gallery choices; `products.manage` edits the global catalogue and uploads images. `albums.edit` assigns offers and locks/unlocks them. Existing event ownership/assignment checks apply to all gallery-specific admin routes. The global catalogue is intentionally shared between catalogue managers; it is not scoped to individual galleries.

Catalogue saves and choice changes require an expected revision. A stale editor receives a conflict and retains their draft to review before reloading. Client mutations have retry identifiers; a lost response can be retried without duplicate history or notifications. A product fingerprint prevents submitting or locking options that changed since they were displayed. Unrelated products can change independently.

Choices store immutable model/colour names and image references. Removing or renaming options never rewrites previous choices. Locked choices remain visible after catalogue retirement. A submitted choice whose catalogue changed must be reviewed/resubmitted before it can be locked. History is available to authorised photographers through `GET /api/admin/album-products/events/:eventId/offers/:id/history`.

## Storage, backup and lifecycle

Images use the normal storage adapter (local filesystem or S3-compatible storage), generated keys under `album-products/`, and authenticated API delivery with `private, no-store`. Uploads accept actual non-animated PNGs up to 6 MB/16 megapixels and re-encode a bounded, metadata-free rendition. No supplier URLs, filesystem paths or storage credentials reach clients.

The native backup-path registry, S3 required-key inventory and `.picpeak` export/import roots include these images. Database tables participate in standard database backups. Feature disabling does not delete history or withdraw backups. Native gallery deletion explicitly removes choice history and offers on both engines (SQLite runs with foreign-key cascades disabled); gallery expiry, archive and session revocation use existing gallery lifecycle enforcement. Historical and unassigned product images are retained deliberately in this first experimental slice; automatic garbage collection is not introduced here.

## Proposed defaults for issue #1924

The issue leaves placement, pricing and locking open. This draft proposes gallery-based configuration, one model and one compatible colour per assigned product, prices agreed independently, and explicit photographer locking. It keeps configuration separate from the quote catalogue because a quote's historical financial contents must not change when product options change. Quote/portal presentation and generic attribute groups remain maintainer decisions.

## Validation

Focused tests cover SQLite and optional Postgres domain contracts, actual local storage/PNG processing, native authentication and event scoping, gallery expiry/revocation, stale revisions/catalogue changes, retry notification deduplication, locked snapshots, asynchronous catalogue uploads and client recovery. All fixtures are synthetic. No supplier design or client photo is bundled.


## Review milestone (22 October 2026)

This branch fixes the four blocking findings before widening the model. Migration **316_product_configurator.js** creates four tables plus the disabled `albumProducts` flag and used permissions (`products.view`, `products.manage`, `albums.edit`, category `albums`). The canonical image backup path is seeded only by migration 109; 316 rollback removes that path. No `albums.view` or `albums.export` grants are seeded.

The client entry is a collapsed details panel inside standard gallery content; full-page layouts place it after their photo content so it does not precede or overlap the gallery navigation. Guests and normal guest-password sessions cannot configure products: primary-client/PIN or assigned portal access is required. Draft → submitted → locked is explicit; a submitted choice cannot silently revert to draft. Description-only edits do not prevent locking, whereas changed/retired chosen options require review.

Shared direction proposed to the maintainer: one generic option/image library, structured size presets, admin-defined attributes and dependent add-ons, a shared picker, CRM-owned prices and surcharges, offered definitions copied into quotes, and immutable selection/price snapshots on acceptance carried into contracts and invoices. Standalone gallery configuration remains available without CRM. See [the design discussion](https://github.com/PicPeak/picpeak/pull/2222#issuecomment-6335000437). Maintainer confirmation is pending; the broader CRM draft is kept separate from this blocker milestone.
