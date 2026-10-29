# Print-sales manufacturing profiles

Related: [print sales #48](https://github.com/PicPeak/picpeak/issues/48),
[shared product configuration](album-products.md).

The resolver now underpins the default-off experimental [print-sales workflow](print-sales.md):
profile configuration, known-customer gallery orders, native product-only invoices,
bounded preparation and reviewed manual fulfilment. The contract below describes
the pure resolver; persistence, access checks and file lifecycle belong to its
calling services. These are implementation choices for review, not maintainer
agreement or a production rollout.

## Contract

`backend/src/services/printSales/manufacturingProfiles.js` exports:

- `defineProfile(catalogue, definition)`: validate a studio definition against
  the current shared catalogue and return a detached, content-versioned snapshot.
- `resolveProfile(catalogue, definitions, selection)`: validate complete buyer
  choices and require exactly one enabled profile for that exact combination.

`catalogue` is the trusted result of the existing catalogue service: `products`,
`library` and `types`. `selection` contains `productId`, `productVersion` and
`values` (attribute UUID → array of option UUIDs), the same choices used by the
shared picker. The existing library resolves required, multiple and dependent
attributes. Legacy model/colour products are outside this helper's boundary.

Definitions are **trusted studio configuration**, never a buyer request:

```js
const definition = {
  id: profileUuid,
  revision: 1,
  enabled: false, // explicit opt-in; no default enabled profile
  selection: { productId, productVersion, values },
  labReference: 'Optional operator reference',
  supplierName: 'Optional studio-defined supplier label',
  instructions: 'Optional preparation instructions.\nOptional packing instructions.',
  manufacturing: {
    capability: 'single-photo-rectangle',
    trimMm: { width: 101.6, height: 152.4 },
    bleedMm: { top: 2, right: 2, bottom: 2, left: 2 },
    safeInsetMm: { top: 3, right: 3, bottom: 3, left: 3 },
    resolution: { targetDpi: 300, minimumDpi: 150 },
    output: { format: 'jpeg', colourSpace: 'srgb', quality: 95, chromaSubsampling: '4:4:4' },
    background: '#ffffff',
    fitModes: ['cover', 'contain'],
  },
};
```

Measurements above are synthetic examples, not supplier specifications. Catalogue
display dimensions are retained with their original units; they never determine
artwork dimensions. Trim width/height establish the production orientation.
Bleed expands each named trim edge. Safe insets are measured inward from trim
and must leave a positive safe rectangle. Derived pixel dimensions use
`round(artworkMm × targetDpi / 25.4)` independently on each axis.

The initial capability is a single rectangular photo face, with optional bleed.
It accepts embedded sRGB JPEG, PNG or 8-bit TIFF requirements. JPEG has configurable
quality (1–100, default 95) and chroma sampling (4:4:4 or 4:2:0, default 4:4:4).
PNG supports lossless compression levels 0–9 (default 6); TIFF supports `lzw`,
`deflate` or `none` compression (default `lzw`). Only the fields appropriate to
the selected format are accepted. A solid RGB hex background controls transparent
pixels and whole-photo borders; it defaults to white for newly compiled profiles.
Allowed `fitModes` can offer either or both `cover` and `contain`.
Canvas wrapping/mirroring, folded cards,
books, masks, custom templates, CMYK and uploaded ICC profiles are rejected.
Unknown manufacturing/output fields are refused, rather than silently ignored.
The calling order service checks effective source resolution against the crop,
and the isolated renderer embeds built-in sRGB. Those operations remain outside
the pure resolver. Geometry and output tests do not establish physical lab quality.

There is a maximum of 100 candidate profiles per resolution request, 2,000 mm
per trim axis, 100 mm per bleed/safe edge, 72–600 DPI, and 60 megapixels per
derived output. These are initial resource bounds, not product recommendations
or benchmarks. Resolution never silently lowers a requested output size.

## Matching and versions

A profile binds one **complete** selection, including all selected extras. No
wildcards, precedence or fallback permit an unconfigured variant to be sold.
Empty optional selections and option-array order do not create new combinations.
Two enabled profiles for the same combination are an error.

Definitions for another product, an older product version or a disabled profile
are not candidates. A malformed enabled definition for the current product
version causes resolution to fail, even if it would describe another variant;
studio configuration must be corrected rather than partly trusted.

The returned snapshot contains the validated native selection (including labels
and display measurements), profile ID/revision, cleaned manufacturing requirements,
derived artwork geometry, optional lab reference, supplier label and multiline
instructions. Labels and instructions are studio-owned free text, with no
supplier registry, preferred lab or lab-specific defaults. The snapshot has
`schemaVersion: 2`; its SHA-256 `version` covers
all of that content, including a changed specification whose revision was not
bumped. Inputs and returned snapshots do not share mutable nested objects.

Catalogue changes deliberately invalidate profile bindings for **new** work.
Rebind/review the profile against the new product version before selling it again.
Even a label or image edit currently requires this conservative review. Existing
order snapshots must be retained verbatim and must not be re-resolved against
the current catalogue. This helper neither persists nor protects those records;
durable immutability, revision enforcement and permissions belong to the
profile/order service. A content hash is an identity, not an authenticity proof.

Profiles contain no prices, VAT, currency or delivery charges. Those stay in the
native CRM catalogue/billing machinery. The resolver is also not an authorization
check: callers must load trusted studio definitions and enforce gallery,
buyer and media access before accepting an order.

The worker also consumes already accepted schema-version-one snapshots verbatim,
using their original JPEG defaults and transparency behaviour. New settings do
not alter an accepted order's encoding, geometry, supplier instructions or price.

Delivery configuration is separate from manufacturing: studios can use one flat
native CRM delivery item or named zones with disjoint country sets and their own
native delivery items. The selected zone and commercial invoice line are frozen
in the order. Missing country coverage never falls back to included delivery.

## Connected workflow

1. Profile persistence and admin setup behind a default-off feature gate, with
   native permissions, optimistic revisions and SQLite/PostgreSQL tests. Review
   exact-match configuration ergonomics before adding broader matching rules.
2. Photo/crop/quantity bindings, a small gallery basket, server-calculated native
   prices and an acceptance transaction freezing source identities and the above
   snapshots. Buyers use verified customer-portal assignments, and each order
   creates a product-only native invoice. Reusing the existing gallery lock as
   checkout would inherit automatic project-invoice append behaviour and is not
   a substitute for that transaction.
3. Bounded preparation with retained original versions, verifiable output files,
   neutral supplier pack/order sheet and an explicit settled-payment/studio-review
   release gate, integrated with backup, deletion, privacy and recovery inventories.

The implemented workflow uses
`albumProducts/service.js` and `library.js` for catalogue ownership,
`albumProducts/crm.js` and `billing.js` plus `invoice/create.js` and
`invoice/payments.js` for commercial records, `galleryClientSessionService.js`
for verified gallery sessions, the storage adapters and `photoReplacementService.js`
for source lifecycle, and the existing background-job/shutdown patterns. Product
option-image retention is not already retention of ordered gallery originals.

Invoice/bank transfer is the proposed first complete payment route. Card payments,
guest buyers, paid digital downloads, albums and external supplier connectors
remain separately scoped work. No provider-specific integration belongs here.

## Focused validation

```sh
cd backend
npx jest --selectProjects unit --runInBand --runTestsByPath \
  __tests__/services/manufacturingProfiles.test.js
npx eslint src/services/printSales/manufacturingProfiles.js \
  __tests__/services/manufacturingProfiles.test.js
```

Synthetic fixtures use the real shared-library validator/resolver. They cover two
independent studio specifications with different encodings, background colours
and free supplier instructions, nominal versus production geometry, exact
variants, dependent/multiple choices, stale/disabled catalogue data, ambiguity,
detached snapshots, unsupported requirements and resource limits. This is not
database, application, payment, rendering or physical-product validation; the
connected workflow's separate validation is described in [print sales](print-sales.md).
