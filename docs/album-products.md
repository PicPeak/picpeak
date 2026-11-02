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

A primary-client/PIN gallery credential or assigned customer-portal session is required; where several customers share a gallery, an offer needs to name one of them to reach the portal (see Guided album order). Guests and slideshow sessions cannot read or change choices; admin previews are read-only. The entered name is an audit label. Financial controls require gallery ownership and native billing permissions; assigning a teammate to a gallery does not grant financial access.

Appending gallery products to an unissued invoice recalculates its percentage promotion lines with the native total helper, so those promotions also discount the appended products. Initial quote-to-invoice conversion retains the recorded promotion amounts; the recalculation happens when products are appended. Review the resulting invoice total before issuing it.

## Guided album order

A guided album walks a client through album, material, colour, format and size, then the cover and poster photos, and ends in one review with a separate confirmation. It is an ordinary product of the catalogue: no second catalogue, no second order state.

### Set it up

1. In the product catalogue, **Add album starter set** puts an editable example into the unsaved catalogue: cotton, silk and leather with their colours, Landscape with 25 × 70 cm and 30 × 80 cm, Square with 25 × 50 cm and 30 × 60 cm. Nothing depends on these values; change or delete them.
2. To build a type by hand, give it one required single-choice attribute for each role in **Role in a guided album**. Colours take a value in the colour library; an option without one shows its image. Under **Which options to offer depends on**, tie the colour attribute to the material and the size attribute to the format, then tick what each option goes with. Nothing ticked offers an option with all of them. Saving refuses a parent choice that would leave nothing to pick.
3. Sizes are entered as width and height and drawn to that ratio, all at one scale. For the example values the width is the long side of the open album: 25 × 70 cm is 70 wide and 25 high, two pages of 35 × 25 cm. **Sizes measure the open album** draws the fold.
4. On each product set a product image, switch on **Guided album order**, and set the photo counts. The cover is at most one; posters run from a minimum to a maximum of up to ten. **The client’s confirmation is final** decides whether confirming binds the client. Other attributes of the type become one extra step.

An album is a product, so offering five albums means five offers in the gallery. The client compares them in the first step and confirms one: once one is confirmed, the server refuses a second confirmation for the same client in that gallery.

### Release and access

Adding a guided album to a gallery does not show it to anyone. **Release to client** does, and **Withdraw release** takes it back at once: the client can no longer see or change it, and its choice and history stay. Both are in the activity log.

An offer with no customer belongs to the gallery's client: the PIN session, or the portal session of the only assigned customer. Where several customers share a gallery, one offer holds one selection, so none of them sees such an offer, and the card says so. Choose a customer in **Who gets this offer**, or add one offer per customer for the same album; each holds its own selection. A customer's offer is visible to that customer alone, not to the PIN and not to another customer, on read, on write, on a repeated request and for its images. This applies to every product offer, not only to guided ones. Once an offer holds a choice it stays with its customer.

The customer portal shows a released album on the gallery's page and under Needs your attention, and links into the gallery flow with `?album=<offer id>`, or `?album=choose` when there are several albums.

### Photos

A client picks from the photos of this gallery. The server stores the photo id and, for the studio, the filenames; a client gets only the id. No path, URL or original goes through the product API: thumbnails come through the gallery's own media routes and their checks.

Every save, draft or confirmation, checks each photo again: it must belong to the gallery, be visible, not be in the trash, not be held for moderation, be processed and on hand, and not be a video. A hidden photo is refused for a PIN client too, although that client can see it in the gallery. A photo hidden after a draft blocks the confirmation until it is replaced. After a confirmation the reference stays frozen, and the studio's summary marks a photo that has since gone. One photo may hold both roles.

### Confirmation and reopening

Confirmation is the existing `draft → submitted` step. With a final confirmation the client has to enter a name, confirm the warning in a second step, and cannot change the selection afterwards, in that tab or another; a repeated request returns the same result without a second notification. Locking stays the studio's step. Without a final confirmation the album resubmits until it is locked, as other products do.

**Reopen for the client** moves a confirmed selection back to `draft`, with the choices kept as a starting point. It takes the same rights as unlocking, follows the same billing rules, and is written to the activity log and the history. The client has to confirm again.

### Personal data

The name and the session digest of a client are in the choice history. A customer erasure clears them for that customer's entries and withdraws their offers. The selection itself stays: it holds no personal data, and a locked one is the studio's order record. As with other activity, the log keeps its entries.

## Quote workflow

Add the configurable catalogue item directly, through a package, or through a published quote template. The quote copies the offered definition and prices when authored. The photographer may pre-fill choices or lock a complete agreed specification. Clients can finish or change unlocked choices, including an optional product they book on the quote page; locked specifications are read-only.

Published template versions freeze the product definition, base price and option surcharges at publication. New quotes created from that version keep those prices even after the live catalogue changes; publish a new template version to offer updated prices.

An authored ordinary line stays ordinary, with its saved price, if its catalogue item is later linked to a configurable product, archived or disabled. Published templates likewise freeze the absence of configuration, including package children. Publish a new template version or add a new catalogue line to offer the newly linked product; saving an existing quote never upgrades it silently.

Before conversion to a contract, event or invoice, an admin can book a previously unbooked configurable product in the accepted quote's add-on amendment screen. The shared picker collects the new specification, including configured package children. Saving recomputes prices from the offered definition, records the change, retains another accepted PDF and emails the updated quote to the customer. Existing accepted specifications stay read-only here, and studio-locked prefilled offers keep their agreed specification even while unbooked. Changing an already accepted specification requires reissuing the quote.

Editing an existing catalogue item's ordinary details does not revalidate an unchanged product association. Existing quote definitions remain editable if the feature or live product is disabled. Attaching a different product, changing its option surcharges or authoring a new configurable definition still requires the configurator and an active product; linked catalogue items continue to require fixed pricing.

Verified public quote pages and the authenticated customer portal use the same picker. The server recomputes quantities, surcharges, discounts and totals and checks the total confirmed by the customer. Acceptance freezes option IDs, labels, dimensions, images and the price breakdown. Contract and invoice lines carry the frozen specification. Existing response-window and conversion locks continue to apply. Surcharges follow the native VAT treatment of the configured line's full unit price, without a separate surcharge tax rate.

## Storage and recovery

Images use the normal local/S3-compatible storage adapter, generated `album-products/` keys and authenticated delivery with `private, no-store`. Actual non-animated PNG uploads are limited to 6 MB and 16 megapixels, then re-encoded to remove metadata. No supplier URLs, filesystem paths or storage credentials reach clients.

Database backups, the native backup-path registry, required-key recovery inventory and portable `.picpeak` transfers include these image rows and objects. Images referenced by accepted quotes, contracts, invoices and billed items are pinned independently of the catalogue. PostgreSQL and SQLite deletion guards protect them even when SQLite foreign keys are disabled. Automatic image garbage collection is not introduced. Images offered in existing public or portal quotes remain available when the configurator flag is switched off; the normal document verification and customer ownership checks still apply.

Both native and archived gallery deletion remove client choice history and offers explicitly, including names and session digests. Audited product billing records survive with their event link cleared; financial evidence and image pins remain retained. Expiry, archive and session revocation use the existing gallery lifecycle checks.

Revision checks prevent stale saves; request retry IDs prevent duplicate submissions, notifications and billable items. The invoice product revision also prevents an outdated PDF being sent if a product was appended during rendering. Failures preserve the client's unsaved form and offer a reload/retry action.

## Migration and validation

Migration 320 introduces the catalogue/choice storage, disabled feature flag and final product permissions. Migration 321 adds the generic library and CRM snapshots. Migration 322 adds quote locks, gallery price settings, audited billable items, retained image references and the invoice revision guard. Migration 345 adds the customer an offer belongs to and the customer behind a history entry, and moves offer uniqueness to gallery, product and customer. `products.view`, `products.manage` and `products.configure` remain separate permissions; billing retains native customer/invoice permissions.

Regression tests use real core migrations on SQLite and PostgreSQL 15, synthetic PNGs, native HTTP authentication, quote arithmetic, document snapshots and invoice correction workflows. The PR description records current counts and remaining upstream validation limitations. No real client photos, supplier designs, studio prices, payment collection or supplier ordering are included.
