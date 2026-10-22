# Shared gallery and CRM product direction

Status: proposed to the maintainer on 22 October 2026; confirmation pending. CRM integration is in scope. First review milestone: fix the blockers and agree the shared design. No production activation is part of this contribution.

- One editable option/image library, including structured width × height + mm/cm/in size presets and basic colours.
- Admin-defined product types declare required, optional and multiple-choice attributes. Products reuse those definitions. Optional extras can depend on other choices; cycles and invalid combinations are rejected.
- CRM catalogue items own the base price and per-option surcharges, and reference the shared product. Package lines and quote templates reuse that reference.
- A quote copies the offered definition and prices so a catalogue edit cannot alter an offer already sent. Published quote-template versions retain their offered definition too.
- The verified quote page and authenticated portal use the shared picker for included and optional products. Only booked lines need complete choices. The server recomputes quantity, surcharges, discounts and totals and checks the amount confirmed by the client.
- Acceptance atomically freezes option IDs, labels, dimensions, images and price breakdown. Contract and invoice lines retain that exact specification. Existing response-window and conversion locks continue to govern amendments.
- Gallery configuration works independently of CRM and records a choice without taking payment. It requires primary-client/PIN or assigned portal access; guests cannot change the specification. A gallery submission/lock cannot amend an accepted commercial document.

Discussion: https://github.com/PicPeak/picpeak/pull/2222#issuecomment-6335000437

The broader implementation is isolated on `codex/shared-product-configurator-crm`, outside the blocker PR revision while these boundaries are discussed. Album layout editing, proof comments/proposals, exact-proof approval and production interior export remain a separate roadmap.
