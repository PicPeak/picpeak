# Shared product configurator and CRM — isolated draft

Status: implementation draft, separate from PR 2222's blocker milestone. The maintainer's confirmation of the shared design is pending. CRM integration is authorised; production activation is not part of this work.

Implemented in this draft:

- Shared editable option/image libraries, numeric size presets (width/height/unit), basic colours and admin-defined product types with required/optional/multiple-choice attributes.
- Optional extras with validated dependencies; cycles, foreign choices and unavailable options are rejected. Images are uploaded once and reused.
- Shared gallery and quote picker, existing gallery client/portal authority, draft/submission/lock history, stale chosen-option feedback and read-only catalogue access.
- CRM catalogue products own base prices and non-negative option surcharges. Direct catalogue lines, package lines and published quote-template versions carry the shared product definition.
- Verified public quote and authenticated portal totals/images/respond routes retain their existing authentication and ownership boundaries. Only booked lines need complete choices. Totals are recomputed server-side using quantity, discounts and surcharges; acceptance checks the amount displayed to the customer.
- Offered definitions/prices are copied into quote lines. Accepted selections freeze IDs, labels, sizes, images and price breakdown and are included in contract and invoice lines. Conversion/response-window locks remain in force.
- Additive migration 317 upgrades the published 316 schema rather than rewriting it; it preserves existing permission grants when renaming the configurator permission to products.configure.

Validation records: real core-migration SQLite gallery/domain/access suite; real PostgreSQL CRM workflow (including contracts, invoices, protected images, required/multiple choices, dependencies, packages/templates and the same gallery snapshot); focused picker/catalogue/public-quote frontend tests. The full upstream suites and mobile/dark screenshots of the broader UI have not been completed. TypeScript still reports unrelated upstream errors in SelfUpdatePanel, event settings and AttachDocumentDialog. This branch is not marked merge-ready.

Before folding into the upstream draft:

1. Confirm the proposed shared ownership/snapshot design with the maintainer.
2. Review the migration/permission naming and compatibility with any newer upstream migration number.
3. Complete the broader UI/mobile/dark, portal HTTP ownership, template-version immutability and full regression coverage; inspect actual quote-to-invoice conversion and all invoice clone/credit paths in addition to the tested direct invoice snapshot.
4. Update the telemetry route inventory for the new verified quote/portal endpoints and the public PR description/screenshots.
5. Decide the admin-on-behalf configuration UI. Incomplete configured products are refused before an admin acceptance changes the quote status.
6. Keep the separate album layout/proofing/export work independent. Its draft migration must move beyond the shared foundation, and its isolated Sharp renderer still needs repair/acceptance checks.

No payment collection, supplier ordering, private supplier artwork or studio prices are introduced. Existing prototype model/colour records remain readable during the transition.
