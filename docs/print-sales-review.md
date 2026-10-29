# Print sales exploration for issue #48

Browsable implementation for discussion of [issue #48](https://github.com/PicPeak/picpeak/issues/48).
This is an experimental, default-off branch based on upstream
`c37353976f5d7e5f1e0b7b34f6b14dbeb672cdab` (3.186.0-beta.0), not an approved
scope or a production deployment. No pull request is being opened for this checkpoint.

The direction follows the [maintainer's generic-service guidance](https://github.com/PicPeak/picpeak/issues/48#issuecomment-6402523874)
and the [proposed initial scope](https://github.com/PicPeak/picpeak/issues/48#issuecomment-6403652368):
shared catalogue products, studio-configured manufacturing, frozen order records
and reviewed manual supplier export. There are no named-lab adapters or preferred suppliers.

## Review in pieces

| Piece | Implementation | What to inspect |
|---|---|---|
| Manufacturing contract | [Resolver](../backend/src/services/printSales/manufacturingProfiles.js), [resolver tests](../backend/__tests__/services/manufacturingProfiles.test.js) | Exact catalogue choices; nominal versus production dimensions; supported capabilities; detached, versioned specifications. |
| Complete manual workflow | [Orders](../backend/src/services/printSales/orders.js), [worker](../backend/src/services/printSales/worker.js), [fulfilment](../backend/src/services/printSales/fulfilment.js), [HTTP/integration tests](../backend/__tests__/integration/printSales.test.js) | Known CRM buyers; retained source bytes; per-order native invoice; independent payment/preparation; checked files and manual submission/dispatch. |
| Studio configuration | [Profiles](../backend/src/services/printSales/profiles.js), [delivery](../backend/src/services/printSales/delivery.js), [admin editor](../frontend/src/features/print-sales/AdminPage.tsx), [gallery shop](../frontend/src/features/print-sales/GalleryPrintShop.tsx) | Native CRM prices and VAT; delivery zones; output formats, backgrounds and supplier instructions; existing orders remain frozen. |
| Generic starting options | [Shared sizes](../frontend/src/features/album-products/printSizes.ts), [production helper](../frontend/src/features/print-sales/ProductionStartingPoints.tsx), [colour profiles](../backend/src/services/printSales/colourProfiles.js), [source-linked research](print-sales-market-research.md) | 43 editable size helpers; independent bleed/safe values; fixed RGB delivery profiles and explicit compatibility limits. |

The branch builds on [merged #2222](https://github.com/PicPeak/picpeak/pull/2222),
reusing its catalogue, option library, picker, CRM prices and VAT. It does not
create a second product catalogue or billing calculation.

For the full setup, invariants, resource bounds, storage/privacy/recovery and
retention behaviour, see [the workflow guide](print-sales.md) and
[the manufacturing contract](print-sales-manufacturing-profiles.md).

## What this checkpoint covers

- Verified, assigned CRM customers can order photographs, crops and per-photo quantities.
- Acceptance retains exact sources/specifications/prices and creates one product-only
  native invoice. The studio issues/sends it through existing CRM billing; bank
  transfer and confirmed native payments remain authoritative.
- Bounded background preparation produces numbered artwork, a manifest and a
  private thumbnail/order sheet in a supplier ZIP. Settlement, file identity and
  an explicit studio review gate manual release.
- Studios configure geometry, resolution, JPEG/PNG/8-bit TIFF, RGB delivery profile,
  backgrounds, fit modes, supplier labels/instructions and native-price delivery zones.
- Default-off feature and gallery switches; accepted orders retain their own values
  after catalogue, source or configuration changes.

No card checkout, guest buyers, automatic lab ordering, generic supplier API harness,
canvas wrapping, folded cards or album layout/proofing is included. Separate payment
work remains in [draft #2280](https://github.com/PicPeak/picpeak/pull/2280); album-selection
[PR #2253](https://github.com/PicPeak/picpeak/pull/2253) is closed without merging.

## Validation at this checkpoint — 29 October 2026

These are local results with synthetic data, not upstream CI or live-shop validation.

| Check | Result |
|---|---|
| Print-sales integration, real migrations/auth/native invoicing/local storage | 45 passed on SQLite and the same 45 on PostgreSQL 18.4 |
| Focused unit, image metadata/output, worker lifecycle, privacy inventory and photo trash | 162 passed in seven suites |
| Native process protections | 17 passed on this Linux runner |
| Frontend workflow/shared-library/picker/permission/save-bar checks | 33 passed in six suites |
| TypeScript, touched-file lint, production frontend build | Passed; existing build warnings remain |
| Chromium, 1365×1000 and 390×844 | Synthetic actual-component checks; no page errors or horizontal overflow |

Image tests exercise the actual separate image worker, output density and ICC identity.
RGB tests check conversion rather than only attaching a tag. These fixtures do not
establish physical print quality or full-gamut colour fidelity. Live S3 end-to-end
ordering/restore and ARM64 capacity have not been validated.

Focused backend checks (after installing repository dependencies):

```sh
cd backend
npx jest --selectProjects unit --runInBand --runTestsByPath \
  __tests__/services/manufacturingProfiles.test.js \
  __tests__/services/printSalesOutput.test.js \
  __tests__/services/printSalesDelivery.test.js \
  __tests__/services/isolatedSharp.lifecycle.test.js \
  __tests__/services/imageProcessor.stripMetadata.test.js \
  __tests__/services/usageCoverageInventory.test.js \
  __tests__/utils/photoTrashReaders.test.js
npx jest --selectProjects db --runInBand --runTestsByPath \
  __tests__/integration/printSales.test.js __tests__/nativeProcessRunner.test.js
```

For PostgreSQL, use an empty disposable test database with the supported
`DATABASE_CLIENT=pg` and `DB_*` settings; keep it separate from application data.

## Limits and remaining integration work

Colour delivery is 8-bit. The Adobe RGB (1998) compatible asset is a pinned CC0
profile, not Adobe's proprietary file; exact-profile-name acceptance needs supplier
verification. ProPhoto is offered only for suppliers explicitly accepting 8-bit
ProPhoto delivery. The raster pipeline can reduce source gamut before output;
a wider destination profile cannot restore that gamut. There is no arbitrary
ICC upload, CMYK delivery, 16-bit master or soft-proof accuracy claim. See the
[research and asset provenance](print-sales-market-research.md).

Before upstream integration, this branch needs rebasing and migration-number
reconciliation: its existing `334_print_sales` migration overlaps the 334–336
range in draft #2280. Physical samples and exact supplier-template validation
remain prerequisites for a studio rollout. Publishing this branch does not enable
the feature on any existing installation.

## Synthetic UI examples

These screenshots show synthetic artwork, addresses and prices in actual components.
They are stored on the fork's separate `pr-assets` branch, outside the code branch.

- [Production configuration](https://raw.githubusercontent.com/icelessgo/picpeak/pr-assets/issue-assets/48-print-sales-exploration-2026-10-29/admin-desktop.png)
- [Gallery basket and crop](https://raw.githubusercontent.com/icelessgo/picpeak/pr-assets/issue-assets/48-print-sales-exploration-2026-10-29/gallery-desktop.png)
- [Shared catalogue size helper](https://raw.githubusercontent.com/icelessgo/picpeak/pr-assets/issue-assets/48-print-sales-exploration-2026-10-29/catalogue-desktop.png)
