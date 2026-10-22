# Shared gallery and CRM product direction

Status: agreed with Luca-Timo on 22 October 2026. CRM integration is in scope. No production activation is part of this contribution.

- One editable option/image library, including structured width × height + mm/cm/in size presets and basic colours.
- Admin-defined product types declare required, optional and multiple-choice attributes. Products reuse those definitions. Optional extras can depend on other choices; cycles and invalid combinations are rejected.
- CRM catalogue items own the base price and per-option surcharges, and reference the shared product. Package lines and quote templates reuse that reference.
- A quote copies the offered definition and prices so a catalogue edit cannot alter an offer already sent. Published quote-template versions retain their offered definition too.
- The verified quote page and authenticated portal use the shared picker for included and optional products. Only booked lines need complete choices. The server recomputes quantity, surcharges, discounts and totals and checks the amount confirmed by the client.
- Acceptance atomically freezes option IDs, labels, dimensions, images and price breakdown. Contract and invoice lines retain that exact specification. Existing response-window and conversion locks continue to govern amendments.
- Gallery configuration works independently of CRM and records a choice without taking payment. It requires primary-client/PIN or assigned portal access; guests cannot change the specification. A gallery submission/lock cannot amend an accepted commercial document.
- With CRM enabled, locking creates an open customer/project billable item using the CRM catalogue price at lock time. Billing may append to an unissued project invoice or create a separate product-only invoice. Issued invoices are immutable. Unlocking removes an unbilled item; billed choices require the normal invoice correction workflow.
- Gallery prices are informational, controlled by an admin toggle that defaults off, and available only with CRM enabled.
- Quote authors can pre-fill choices and lock a complete specification. Locked choices are read-only to clients; partial or unlocked choices remain configurable.
- Surcharges inherit the line VAT code from the shared registry. Dimensions and money use the native locale-aware inputs and money helpers.
- Images referenced by accepted quotes, contracts, invoices or billed items remain retained, including during future cleanup. Dependencies stay limited to a simple prerequisite choice in v1.

Discussion: https://github.com/PicPeak/picpeak/pull/2222#issuecomment-6335000437

The broader implementation is developed on `codex/shared-product-configurator-crm` and will join the same PR as distinct commits once ready. Album layout editing, proof comments/proposals, exact-proof approval and production interior export remain a separate roadmap.

Agreement and adjustments: https://github.com/PicPeak/picpeak/pull/2222#issuecomment-6336218725
