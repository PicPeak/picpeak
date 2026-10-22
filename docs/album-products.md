# Product configuration

An experimental shared product configurator for gallery clients and CRM quotes. The `albumProducts` feature flag defaults off. The agreed scope is documented in [the direction](product-configurator-direction.md) and [CRM implementation notes](product-configurator-crm-draft.md).

## Set up the catalogue

1. Enable product configuration in Settings → Features.
2. Maintain reusable option groups in the product catalogue: sizes, colours, covers, frames, papers or other choices. Size options store width, height and mm/cm/in. Upload a PNG you have permission to display for active options; the same image can be reused.
3. Define a product type with required, optional or multiple-choice attributes. An attribute can have one prerequisite choice, such as a mat available only with a frame. Cycles and invalid references are refused.
4. Add an active product using that type and save with the shared settings save bar. Existing model/colour products remain readable during the transition.
5. When using CRM, attach the shared product to a fixed-price catalogue item. Set its currency, base price, option surcharges and an active output VAT code. These are commercial catalogue prices, independent of the shared option library.

## Gallery workflow

1. In the gallery Overview → Product configuration, assign an active product.
2. With CRM billing enabled, link the CRM price item. Assign the gallery to a customer first; choose the billing recipient explicitly if multiple customers are assigned. The gallery price-display toggle defaults off. Displayed prices are indicative; the binding price is copied at lock time.
3. The client opens the compact product entry inside their gallery, chooses options, enters their name and saves a partial draft or submits a complete choice. Dependencies hide unavailable extras. A submitted choice must be resubmitted rather than silently returned to draft.
4. Review and lock the choice. Without CRM this confirms the specification only. With CRM billing enabled it creates an audited open customer/project product item at the current catalogue price. Exactly one compatible unissued, unarmed project invoice receives its own frozen product line automatically. Otherwise the item stays open.
5. Bill open product items from the gallery or the customer's Product items panel. This creates a separate product-only invoice; it does not amend an issued invoice or resend an accepted quote. The customer panel retains open items after gallery deletion. Items with different currencies or VAT codes are billed separately.
6. Unlocking removes an unbilled item. A billed choice requires the normal invoice cancellation/Storno correction first; a live replacement invoice also prevents silent changes. Hiding an offer immediately withdraws client image and mutation access.

A primary-client/PIN gallery credential or assigned customer-portal session is required. Guests and slideshow sessions cannot read or change choices; admin previews are read-only. The entered name is an audit label. Financial controls require gallery ownership and native billing permissions; assigning a teammate to a gallery does not grant financial access.

## Quote workflow

Add the configurable catalogue item directly, through a package, or through a published quote template. The quote copies the offered definition and prices when authored. The photographer may pre-fill choices or lock a complete agreed specification. Clients can finish or change unlocked choices, including an optional product they book on the quote page; locked specifications are read-only.

Verified public quote pages and the authenticated customer portal use the same picker. The server recomputes quantities, surcharges, discounts and totals and checks the total confirmed by the customer. Acceptance freezes option IDs, labels, dimensions, images and the price breakdown. Contract and invoice lines carry the frozen specification. Existing response-window and conversion locks continue to apply. Surcharges follow the native VAT treatment of the configured line's full unit price, without a separate surcharge tax rate.

## Storage and recovery

Images use the normal local/S3-compatible storage adapter, generated `album-products/` keys and authenticated delivery with `private, no-store`. Actual non-animated PNG uploads are limited to 6 MB and 16 megapixels, then re-encoded to remove metadata. No supplier URLs, filesystem paths or storage credentials reach clients.

Database backups, the native backup-path registry, required-key recovery inventory and portable `.picpeak` transfers include these image rows and objects. Images referenced by accepted quotes, contracts, invoices and billed items are pinned independently of the catalogue. PostgreSQL and SQLite deletion guards protect them even when SQLite foreign keys are disabled. Automatic image garbage collection is not introduced.

Both native and archived gallery deletion remove client choice history and offers explicitly, including names and session digests. Audited product billing records survive with their event link cleared; financial evidence and image pins remain retained. Expiry, archive and session revocation use the existing gallery lifecycle checks.

Revision checks prevent stale saves; request retry IDs prevent duplicate submissions, notifications and billable items. The invoice product revision also prevents an outdated PDF being sent if a product was appended during rendering. Failures preserve the client's unsaved form and offer a reload/retry action.

## Migration and validation

Migration 316 introduces the original catalogue/choice storage and disabled feature flag. Migration 317 adds generic library and CRM snapshots and renames `albums.edit` to `products.configure` while preserving grants. Migration 318 adds quote locks, gallery price settings, audited billable items, retained image references and the invoice revision guard. `products.view`, `products.manage` and `products.configure` remain separate permissions; billing retains native customer/invoice permissions.

Regression tests use real core migrations on SQLite and PostgreSQL 15, synthetic PNGs, native HTTP authentication, quote arithmetic, document snapshots and invoice correction workflows. The PR description records current counts and remaining upstream validation limitations. No real client photos, supplier designs, studio prices, payment collection or supplier ordering are included.
