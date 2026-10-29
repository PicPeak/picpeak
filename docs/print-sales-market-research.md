# Generic print starting options — 29 October 2026

This is a qualitative review of public specifications from US, UK and European
photographic labs, print providers and colour-management documentation. It is
not a market-share survey or a ranking by sales volume. “Common” means recurring
formats and conventions in the sampled catalogues. Sources are references, not
preferred suppliers or supported ordering integrations.

## Colour findings and implemented options

| Delivery encoding | Evidence | Generic option |
|---|---|---|
| sRGB | Recurs throughout photographic submission guidance; useful when the supplier requests it. | Existing default, retained unchanged. |
| Adobe RGB (1998) | Accepted by Bay Photo, Saal, Loxley and WHCC. | Adobe RGB (1998) **compatible** RGB profile, converted and embedded. |
| Display P3 | Explicitly accepted by WHCC and Image Science, but not universally listed elsewhere. | Display P3, selectable only by studio configuration. |
| ProPhoto / ROMM RGB | Accepted by Bay Photo, Saal and Loxley; precision requirements vary. | ProPhoto RGB, with explicit **8-bit delivery** guidance. |
| Printer/paper ICC | Frequently supplied for soft proofing only. | Not offered as a generic output profile. |
| CMYK press profiles | Depend on the printing condition, paper and supplier. | Not offered as an interchangeable photographic default. |

Primary references: [Bay Photo file preparation](https://support.bayphoto.com/hc/en-us/articles/40266583579795-How-Should-I-Prepare-My-Files-File-Size-File-Preparation-Guidelines),
[Saal colour spaces and formats](https://www.saal-digital.com/service/professional-zone/resolution-colour-space-and-file-formats/),
[WHCC photographic prints](https://www.whcc.com/products/photographic-prints/),
[Loxley colour-management guide](https://loxleycolourweb.blob.core.windows.net/downloads/Toolkit/Support%20Documents/Loxley-Colour-Colour-Management.pdf),
[Image Science file preparation](https://imagescience.com.au/services/fine-art-printing/how-to-prepare-files).

The renderer delivers 8 bits per channel. Bay Photo and Loxley explicitly describe
8-bit delivery, including ProPhoto; this does not make 8-bit ProPhoto appropriate
for every workflow. [Adobe's print-profile guidance](https://helpx.adobe.com/photoshop/desktop/print/color-profiles-for-print-output.html)
recommends 16-bit precision for ProPhoto editing. A studio needing a 16-bit master
or 16-bit supplier delivery must use a separately validated export workflow.
The current Sharp/libvips raster pipeline can normalise input through sRGB/P3
before the destination conversion. Choosing a wider delivery encoding does not
promise to preserve every original wide-gamut value or recover previously lost
colour. The new tests establish conversion and tagging for synthetic sRGB
fixtures, not colourimetric fidelity across all source profiles.

[WHCC's FAQ](https://www.whcc.com/help/faqs/) and
[Bay Photo's soft-proof instructions](https://support.bayphoto.com/hc/en-us/articles/40340776767763-Bay-Photo-Lab-s-ICC-Profiles-and-Soft-Proofing)
explicitly distinguish their printer profiles from delivery working spaces.
[WhiteWall](https://service.whitewall.com/hc/en-us/articles/213271389-What-color-space-should-I-use)
accepts some CMYK inputs but converts them to RGB. This reinforces that “a printer
uses CMYK inks” is not sufficient reason to send a CMYK file.

Non-sRGB options use fixed, CC0 profiles from
[Compact ICC Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles), pinned
to revision `bdd84663061bc4ae95ca70decff54f581e27f702`. See the bundled
[asset notice](../backend/src/services/printSales/icc/NOTICE) and license.
The Adobe-compatible profile has the description `A98C`; it is not Adobe's
proprietary profile file. Saal's guidance specifically requires recognising the
Adobe profile by name, so this compatible asset must not be assumed to satisfy
that requirement. Verify with the chosen supplier. There are no arbitrary ICC
paths, uploads or runtime downloads. The profile SHA-256 is frozen in new order
snapshots, checked against the bundled file and verified in the prepared image
before publication. Earlier sRGB snapshots retain their original defaults.

## Sizes

The shared catalogue and the manufacturing editor offer the same 43 size helpers.
They copy measurements into ordinary editable fields, without creating products,
prices, supplier associations or enabled variants.

| Family | Included starting values |
|---|---|
| Metric, cm | 9×13, 10×15, 13×18, 15×20, 20×25, 20×30, 30×40, 30×45, 40×50, 40×60, 50×70 |
| Inches | 3.5×5, 4×6, 5×7, 6×8, 6×9, 8×10, 8×12, 10×15, 11×14, 12×16, 12×18, 16×20, 16×24, 18×24, 20×24, 20×30 |
| Square | 10, 15, 20, 30 cm; 4, 5, 6, 8, 10, 12, 20 in |
| ISO A, mm | A6 105×148; A5 148×210; A4 210×297; A3 297×420; A2 420×594 |

Representative catalogues: [Mpix photo prints](https://www.mpix.com/photo-prints),
[WHCC photo prints](https://www.whcc.com/products/photographic-prints/),
[Snapfish UK sizes](https://www.snapfish.co.uk/photo-printing),
[CEWE UK sizes](https://www.cewe.co.uk/photo-printing/photo-prints.html),
[CEWE Ireland formats](https://www.cewe.ie/photo-printing.html).
ISO dimensions are cross-checked against
[Lexmark's paper-size table](https://publications.lexmark.com/publications/lexmark_hardware/Paper_and_Specialty_Media_Guide/html/en/GUID-3fcca8c6-5c8b-4d33-bb3a-c30908594b07-en.html)
and [Solopress's size/bleed reference](https://www.solopress.com/support-guides/bleed/).
The longer list provides convenient sizes across these families, not a claim
that each one is offered by every sampled supplier.

Metric and inch labels remain distinct: 4×6 in is exactly 101.6×152.4 mm;
10×15 cm is 100×150 mm. Actual photographic paper sizes can differ again: use
[Saal's exact product dimensions/templates](https://www.saal-digital.com/prints/professional-area/)
or the chosen supplier's equivalent. Display size never determines production
geometry automatically. Orientation can be swapped; custom sizes remain editable.

## Trim, bleed and safe-area findings

- **Trim** is the finished physical size.
- **Added bleed** extends each artwork edge beyond trim. A 3 mm bleed adds 6 mm
  to the total width and height. [Solopress](https://www.solopress.com/support-guides/bleed/)
  and [Printed.com](https://printed.zendesk.com/hc/en-gb/articles/360057589351-Our-handy-Artwork-checklist)
  describe 3 mm bleed and 3 mm safe areas for common press work.
- **⅛-inch bleed** is exactly 3.175 mm per edge, a separate choice from 3 mm.
  [Mpix's press FAQ](https://www.mpix.com/help/topics?id=19) uses this amount and
  explicitly says that bleed depends on process and equipment.
- **Photographic edge loss** is different. WHCC describes approximately 2%
  enlargement and recommends keeping important material ¼ inch (6.35 mm) inside.
  [Saal's ordering guide](https://www.saal-digital.com/help-center/online-designer/prints/)
  describes 2 mm edge trimming. Neither is permission to add generic press bleed
  to every photographic file or to apply an automatic overscan percentage.
- **Safe inset** is an operator guide inside trim, not a printed white border or
  automatic subject detection. Keep faces/text inside the supplier's safe area.
- **Crop marks** are supplier-specific: Printed.com asks for them on some PDFs,
  while [MOO](https://support.moo.com/hc/en-gb/articles/360035605571-Removing-crop-marks)
  asks for their removal. The existing raster exporter adds none.

The UI therefore provides independent copy controls: added bleed 0, 2, 3, 3.175
or 5 mm, and safe inset 0, 3, 5 or 6.35 mm. The 2/5 mm values are convenient
editable allowances for verified templates, not universal product prescriptions.
Per-edge custom values remain available. Choosing a starting value disables the
variant until the studio reviews and enables it; there is no automatic approval.

300 DPI recurs in the sampled guidance; Bay Photo also documents 200–300 PPI.
Existing output/source-resolution controls remain editable. Size helpers never
lower DPI or bypass the 60-megapixel, source-resolution or file-size limits.

## Relationship to current implementation

[Merged PR #2222](https://github.com/PicPeak/picpeak/pull/2222) supplies the shared
catalogue, picker and native CRM pricing. This continuation adds setup helpers
there and production choices to the default-off print-sales branch. It keeps
source retention, order immutability, native invoices/bank transfers, settled
payment, studio review and manual supplier submission as implemented.
[PR #2253](https://github.com/PicPeak/picpeak/pull/2253), the separate preparatory
album-selection helper, is closed without merging. The open draft
[payment PR #2280](https://github.com/PicPeak/picpeak/pull/2280) adds digital-photo
checkout work; it is not a merged payment dependency of this print branch.
Its migrations 334–336 overlap this branch's existing 334 print-sales migration;
renumbering and integration checks are required when preparing an upstream merge.
These options do not implement album layout, physical supplier approval,
automatic lab ordering or a production rollout.
