# Shared product configurator and CRM

Status: shared design agreed with Luca-Timo on 22 October 2026. This implementation joins PR #2222 as distinct commits. It remains a draft for upstream review; no production activation is included.

## Behaviour

- One shared option/image library, structured editable size presets, basic colours and admin-defined product types. Required, optional and multiple-choice attributes use the same picker in galleries and quotes. Each attribute may have one prerequisite choice in v1; cycles and invalid combinations are rejected.
- CRM catalogue items own base prices and per-option surcharges. Packages and published quote-template versions reuse the product definition. Quote authors can pre-fill partial choices or lock a complete agreed specification. Locked choices are read-only to clients and enforced on the server.
- Quotes copy definitions and prices when authored. Verified public and authenticated portal response routes recompute totals and check the amount confirmed by the client. Acceptance freezes labels, dimensions, images and the price breakdown; contracts and invoice lines retain that exact specification.
- Gallery prices are informational, off by default and available only when CRM billing is enabled. The photographer links a CRM price item and, for multi-customer galleries, an assigned billing recipient. Locking freezes the current catalogue price as an audited open customer/project product item. A retry cannot create another item.
- Exactly one compatible unissued, unarmed project invoice receives a distinct product line automatically. Issued invoices are never amended. Ambiguous, armed or incompatible invoices leave the item open for review. The gallery and customer page can create a separate invoice for open product items only; the customer page also handles items whose gallery has been deleted. The API supports an explicit compatible unissued target invoice.
- Currency and the output VAT code/rate must match before combining items. The shared VAT registry supplies gallery billing VAT; the quote's native VAT treatment applies to the whole configured unit price, including surcharges. There is no independent surcharge tax rate.
- Unlocking removes an unbilled item. Once billed, use the native cancellation/Storno workflow before changing the choice; a live replacement invoice also blocks unlocking. Frozen invoice financial lines cannot be silently replaced by the editor. A revision check prevents a stale PDF being sent when a product is appended during rendering.
- Accepted quote, contract, invoice and billed-item images are pinned independently of the catalogue and document lifecycle. The migration backfills existing frozen references. Database deletion guards enforce image retention on PostgreSQL and on SQLite even with FK enforcement off. Storage backup/transfer inventories continue to include the image rows and keys.
- Native gallery deletion and archived-gallery deletion erase choice history/offers, including client names and session digests. Audited financial items survive with their gallery link cleared. Gallery assignment does not grant a teammate access to financial controls: billing requires the owner and native billing permissions; customer product-item queries are creator-scoped.
- Dimensions and surcharges use native DecimalInput controls; price displays use native money helpers. New controls have English and German translations.

## Schema and integration

Migration 317 adds the generic library and quote/invoice configuration fields without rewriting published migration 316, and preserves role grants while renaming the configurator permission to products.configure. Migration 318 adds quote locks, gallery pricing links, audited billable items, retained-image references and an invoice product revision for safe sending. The experimental albumProducts flag remains off by default.

No payment collection, supplier ordering, supplier artwork or studio-specific prices are introduced. Existing prototype model/colour records remain readable. Album layout editing, proof comments/proposals, exact-proof approval and production interior export remain a separate roadmap.

Validation details and limitations are recorded in the PR description. The production frontend bundle builds; full TypeScript checking still reports the existing upstream errors in SelfUpdatePanel, event settings and AttachDocumentDialog. GitHub workflows for this fork require maintainer approval.
