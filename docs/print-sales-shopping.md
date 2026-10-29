# Gallery print shopping exploration

This local UX iteration builds on the configurable print-order workflow. It does not change payment, manufacturing or fulfilment responsibilities. Products, approved size/finish combinations, prices, destinations and production requirements still come from studio configuration.

## Buyer journey

- **Quick Print:** an authorised buyer can start from the photograph currently open in the gallery lightbox. Closing the lightbox before opening the print dialog prevents overlapping overlays and competing keyboard controls.
- **Visual choices:** product groups and size/finish cards replace long photograph and variant dropdowns. The interface offers only complete configurations returned by the server. It does not invent combinations or select a lab.
- **Several photographs:** the searchable picker retains selections outside the current results and beyond the first page. Gallery selections can seed it. Orders remain limited to 20 photo items; oversized selections require deselection rather than silent truncation.
- **Individual crops:** each photograph has its own size, placement, crop and copy count. Selecting more inherits the active product, placement and copies while centring new crops independently. An explicit action applies the active options to all selected photographs, requiring their crops to be checked again.
- **Reliable editing:** returning to photo selection or reopening a draft retains valid settings. Editing a basket line replaces that line; another crop of the same photo can still be added as a separate item.
- **Copies:** buttons and direct entry support whole numbers from 1 to 100. Transient invalid input blocks adding or requesting a quotation and is never stored as an order quantity. Blur restores the last valid value.
- **Review:** the basket shows crop thumbnails and quantities. Estimates are labelled before tax and delivery. The final review uses the server's frozen quotation and requires acknowledgement before requesting a native studio invoice.

The modal uses the shared focus trap, Escape handling, body scroll lock and mobile sheet. Its action footer remains visible while the content scrolls. Crop positioning supports mouse, touch, keyboard arrows and Home, plus zoom and fine-position controls. Loading or failed previews cannot be added unchecked.

## Spatial reference and trimming

The optional scenes have fixed physical dimensions:

| Scene | Physical extent | Example size |
| --- | --- | --- |
| Desk | 1200 × 850 mm | A 100 × 150 mm print occupies 8.33% of scene width |
| Wall | 3000 × 2250 mm | A 400 × 600 mm print occupies 13.33% of scene width |

A print's width and height are divided by the corresponding scene dimensions. Furniture and scene dimensions stay fixed when changing print size. Prints too large for a scene are withheld with an explanation instead of silently shrinking them. Large formats move to the wall scene automatically when they no longer fit the desk.

The offers response now includes **finished trim dimensions and individual bleed edges**, alongside the existing artwork dimensions. This is additive metadata; there is no migration or order-payload change. The crop editor depicts the complete production artwork, with a dashed finished edge when bleed is present. The spatial view clips the artwork to that trim rectangle, including asymmetric bleed, without rewriting the selected source crop. An older response without trim dimensions simply omits spatial previews.

The scenes are original generic illustrations. They communicate approximate physical size, not colour accuracy, material, framing, canvas wrap/depth, installation or an AR measurement of a buyer's own room. The supported production capability remains a single rectangular photo face. Accessories are labelled as illustrative and not included.

## Existing workflow guarantees

Buyer scope isolates session baskets. Storage is validated and includes only minimal line data; internal line IDs and profile versions are stripped from quotation requests. Product changes hold checkout until the affected line is reviewed or removed. Gallery filters do not remove metadata needed for an existing basket.

Quotation retries retain the same request ID for an unchanged payload. Acceptance retries use the quoted order ID and snapshot hash. Prices, tax, delivery eligibility, source access and effective resolution remain server-authoritative. Confirmation requests an invoice; payment confirmation and artwork preparation remain independent prerequisites for the existing manual lab workflow.

Regression coverage lives in `frontend/src/features/print-sales/__tests__/workflow.test.tsx`, the lightbox current-photo suite, and the backend print-sales integration suite. It covers crop retention, independent new crops, selection/search continuity, quantities, unavailable previews, fixed scene proportions, trim clipping, basket editing, authorisation, request identity and invoice acknowledgement.
