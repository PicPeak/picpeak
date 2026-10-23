# Photo Sales (Snipcart) — Setup, Pricing and Security

PicPeak can sell individual photo downloads through a gallery-level pricing
toggle. This document covers the whole feature: how pricing works, how the
free quota is redeemed, how the system stays secure, and how to operate it.

## Feature overview

- **Priced gallery** toggle per event, default off. Galleries that are not
  priced behave exactly as before.
- Per-gallery settings:
  - `free_photo_count` — free photos for the first order that uses the
    gallery's promo code
  - `photo_price` — price per photo (EUR)
  - `purchase_access_days` — how long a buyer can download after purchase
- Per-photo price override in the admin photo viewer (null = gallery default).
- **Watermark**: every photo of a priced gallery is watermarked (tiled,
  strong) until checkout. The original without watermark is delivered only
  after purchase.
- **Cart**: photos go through the Snipcart cart at their base price. The cart
  does NOT open automatically on add (header badge increments instead).
- **Free quota**: one-time promo code, generated automatically per gallery and
  shown at the top of the gallery. The buyer enters it at checkout; it is a
  real Snipcart discount (fixed amount = `free_photo_count × photo_price`,
  `maxNumberOfUsages: 1`).
- **After purchase**: `order.completed` webhook records the order and sends
  the buyer an access link (`/purchased-downloads/:accessToken`), valid for
  `purchase_access_days` days, unlimited downloads, no one-time consumption.
- **Admin**: per-event "Orders" tab (buyer, photos, amount, remaining access,
  resend-link).

## Setup

### Environment

```env
SNIPCART_API_KEY=<public key from Snipcart dashboard>
SNIPCART_SECRET_API_KEY=<secret key from Snipcart dashboard>
# SNIPCART_WEBHOOK_SECRET is NOT needed (legacy HMAC fallback only).
```

`SNIPCART_API_KEY` is public by design (shipped to the gallery UI).
`SNIPCART_SECRET_API_KEY` never leaves the backend. It is used for:

1. **Webhook verification** — Snipcart v3's official request-token handshake.
2. **Promo-code discounts** — creating/updating the one-time discount when a
   gallery is saved, plus a sync sweep at server start.
3. **Automatic refunds** — when the DB audit rejects a tampered order.

### Snipcart dashboard

1. **One webhook for the whole site** (Store Configurations → Webhooks):

   ```
   https://your-domain.example.com/api/gallery/snipcart-webhook
   ```

   The gallery is derived from the order's items — no per-gallery entry is
   ever needed. (Snipcart offers no API to manage webhooks, which is why the
   endpoint is deliberately static.)
2. **Shipping**: nothing to configure — every photo item is flagged
   `shippable: false` (digital goods delivered through the purchased-
   downloads page), so Snipcart removes all shipping options from the cart
   automatically. There is no "digital delivery" menu in the dashboard.
3. **Domains & URLs**: set the store's default website domain to the public
   origin visitors use (e.g. `https://your-domain.example.com`). Order
   validation resolves item URLs against it and only crawls hosts matching
   the default domain or the allowed domains — without it the checkout fails
   with "Failed to get response from host". Test purchases must run on that
   domain too (not a random tunnel hostname).

## Pricing & the free quota

- Every cart line carries the photo's base price (`photo_price`, or the
  per-photo override). Prices are re-derived from the database at checkout —
  never trusted from the client.
- The free quota is **one-time per gallery**: the first order that applies
  the promo code redeems it. A buyer who forgets the code does not use it up.
  Snipcart enforces `maxNumberOfUsages: 1`; the webhook additionally checks
  that no earlier order of the gallery already redeemed it (`promo_used`).
- The promo code is generated when the gallery is created/edited as priced
  (`events.promo_code`) and synced to Snipcart as a discount
  (`events.snipcart_discount_id`). The gallery UI only advertises the code
  once the discount exists in the store.
- Per-photo overrides are charged in full; the discount amount is always
  `free_photo_count × photo_price` (gallery default).

## Security model

| Surface | Protection |
| --- | --- |
| Webhook authenticity | `X-Snipcart-RequestToken` verified against `https://app.snipcart.com/api/requestvalidation/{token}` with the secret key (valid 1 min, single use). Optional legacy HMAC fallback via `SNIPCART_WEBHOOK_SECRET`. |
| Webhook idempotency | Keyed on the Snipcart order id — redeliveries answer `200 { duplicate: true }` and create nothing. |
| Price integrity | The `order.completed` handler recomputes the expected total entirely from the DB (photo prices, promo code, prior orders). On mismatch it refunds the order automatically and grants **no** downloads. |
| Snipcart item validation | `GET /api/gallery/:slug/price-check?photoId=…` answers `{ valid: true }` only for photos that exist in a priced gallery. It cannot see the cart (Snipcart crawls per item), which is why the authoritative check lives in the webhook audit. |
| Originals | Served only with a valid purchase access token (`photo_purchases` + `expires_at`). Tokens are random, non-guessable and never consumed; access simply expires. |
| Pre-purchase views/downloads | All photos of a priced gallery are served watermarked (tiled) and low-resolution only. Guest download paths are locked to the watermarked rendition; a priced gallery never serves a prebuilt archive, and download jobs built before pricing are not reused. |
| Promo code | Crypto-random, single-use (Snipcart side), hidden until the discount is synced, and re-verified server-side at order time. |
| Admin routes | Orders list requires `events.view`; resending requires `events.edit` + event ownership; per-photo price edits require `photos.edit` + ownership. |
| Secrets | The secret key is never logged, never exposed in payloads, and only used for server-to-server calls. |

**Known limitation (by design):** because Snipcart's validation crawl is
per-item and cart-blind, a determined attacker could tamper with cart prices
in their own browser and pay the wrong amount. The webhook audit catches this:
the order is automatically refunded and no download access is granted. The
attacker cannot obtain unpaid originals this way.

## Architecture

- `backend/src/modules/photoSales/` — pricing rules, purchase access, admin
  summaries, watermark preview pre-generation, promo-code/discount sync.
- `backend/src/routes/gallery/snipcart.js` — item validation crawl endpoint.
- `backend/src/routes/gallery/snipcartWebhook.js` — raw-body webhook mounted
  ahead of the JSON parsers in `server.js` (token verification, audit,
  refund, email).
- `backend/src/routes/gallery/purchasedDownloads.js` — public access-token
  download route used by `/purchased-downloads/:accessToken`.
- `backend/src/routes/adminEvents/photoOrders.js` — admin orders list/resend.
- `frontend/src/features/photo-sales/` — Snipcart bootstrap (snippet only in
  priced galleries, portaled root, no auto-open on add), price chips, promo
  banner, cart item properties.
- `frontend/src/features/settings/tabs/WatermarkTab.tsx` — watermark settings
  incl. logo upload.

### Watermark pre-generation

Watermarked lightbox previews are rendered in the background (not on first
view): after each upload finishes processing in a priced gallery, and when a
gallery is switched to priced. Files live in `storage/watermarks_sales/`
(`photos.photo_sales_preview_key/path`, migration 317) and are re-rendered
automatically when the mark settings change.

### Migrations

`317` pricing schema (gallery and per-photo prices, promo code, preview
cache, orders and purchases) · `318` buyer email template.

## Operations

- **Regenerate watermark previews / promo discount**: re-save the event in the
  admin editor, or restart the backend (startup sync covers missing discounts).
- **Resend a buyer's link**: Event → Orders → "Resend link".
- **Test purchase**: Snipcart test card `4242 4242 4242 4242`.
- **Troubleshooting**:
  - Checkout refuses items → the price-check URL must be reachable from
    Snipcart and the dashboard default domain must match the origin the
    shopper used ("Failed to get response from host" in Test mode).
  - "Failed to get response from host" with ZERO server hits → the nginx CSP
    is blocking Snipcart client-side: `connect-src` must include
    `https://api.snipcart.com` (address validation) and `frame-src` must
    include `https://payment.snipcart.com` (payment iframe).
  - "No shipping method available" → an item was added without the
    `shippable: false` flag (all photo items must carry it — see above).
  - Orders never arrive → verify the webhook URL is the static one above and
    `SNIPCART_SECRET_API_KEY` is set (backend logs the auth failures).
