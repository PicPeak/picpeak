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

The native backup-path registry, S3 required-key inventory and `.picpeak` export/import roots include these images. Database tables participate in standard database backups. Feature disabling does not delete history or withdraw backups. Gallery deletion cascades choices/history; gallery expiry, archive and session revocation use existing gallery lifecycle enforcement. Historical and unassigned product images are retained deliberately in this first experimental slice; automatic garbage collection is not introduced here.

## Proposed defaults for issue #1924

The issue leaves placement, pricing and locking open. This draft proposes gallery-based configuration, one model and one compatible colour per assigned product, prices agreed independently, and explicit photographer locking. It keeps configuration separate from the quote catalogue because a quote's historical financial contents must not change when product options change. Quote/portal presentation and generic attribute groups remain maintainer decisions.

## Validation

Focused tests cover SQLite and optional Postgres domain contracts, actual local storage/PNG processing, native authentication and event scoping, gallery expiry/revocation, stale revisions/catalogue changes, retry notification deduplication, locked snapshots, asynchronous catalogue uploads and client recovery. All fixtures are synthetic. No supplier design or client photo is bundled.
