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
  - `purchase_access_days` — how long a buyer can download after purchase,
    never past the gallery's own expiry
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
- **After purchase**: once Snipcart reports the order paid, the webhook
  records it and sends the buyer an access link
  (`/purchased-downloads/:accessToken`), valid for `purchase_access_days`
  days, unlimited downloads, no one-time consumption. Access never outlasts
  the gallery: a purchase made close to the gallery's expiry ends when the
  gallery expires (expiry deactivates and archives it, and archiving can
  remove the originals). Each cart line tells the buyer the date. A refund
  (even a partial one), chargeback or cancellation reported later revokes
  the link.
- **Admin**: per-event "Orders" tab (buyer, status, photos, amount, remaining
  access, copy/resend link). The tab and the gallery's Photo sales settings
  warn when the server is missing a Snipcart key.

## Setup

### Environment

```env
SNIPCART_API_KEY=<public key from Snipcart dashboard>
SNIPCART_SECRET_API_KEY=<secret key from Snipcart dashboard>
# SNIPCART_WEBHOOK_SECRET: development only (scripts/simulate-snipcart-webhook.js).
# Ignored when NODE_ENV=production.
```

`SNIPCART_API_KEY` is public by design (shipped to the gallery UI).
`SNIPCART_SECRET_API_KEY` never leaves the backend. It is used for:

1. **Webhook verification** — Snipcart v3's official request-token handshake.
2. **Reading the order** — every webhook re-reads its order from
   `GET https://app.snipcart.com/api/orders/{token}`; that order, not the
   webhook body, decides the total, currency, payment status and lines.
3. **Promo-code discounts** — creating/updating the one-time discount when a
   gallery is saved, plus a sync sweep at server start.
4. **Automatic refunds** — `POST https://app.snipcart.com/api/orders/{token}/refunds`
   when the audit refuses an order.

### Snipcart dashboard

1. **One webhook for the whole site** (Store Configurations → Webhooks):

   ```
   https://your-domain.example.com/api/gallery/snipcart-webhook
   ```

   The gallery is derived from the order's items — no per-gallery entry is
   ever needed. (Snipcart offers no API to manage webhooks, which is why the
   endpoint is deliberately static.) The endpoint acts on
   `order.completed`, `order.paymentStatus.changed`, `order.status.changed`
   and `order.refund.created`; Snipcart sends all of them to this one URL.
2. **Currency**: EUR only. An order in any other currency is refunded, so do
   not enable a second currency in the store.
3. **Taxes**: photo prices are gross prices. Configure the store with taxes
   included in prices (or no taxes). A tax added on top changes the total,
   and the audit refunds every such order.
4. **Shipping**: nothing to configure — every photo item is flagged
   `shippable: false` (digital goods delivered through the purchased-
   downloads page), so Snipcart removes all shipping options from the cart
   automatically. There is no "digital delivery" menu in the dashboard.
5. **Domains & URLs**: set the store's default website domain to the public
   origin visitors use (e.g. `https://your-domain.example.com`). Order
   validation resolves item URLs against it and only crawls hosts matching
   the default domain or the allowed domains — without it the checkout fails
   with "Failed to get response from host". Test purchases must run on that
   domain too (not a random tunnel hostname).

## Pricing & the free quota

- Every cart line carries the photo's base price (`photo_price`, or the
  per-photo override). Snipcart's price check reads that price from the
  database before payment, and the webhook recomputes the order total from
  the database after it — the client's price is never trusted.
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
| Webhook authenticity | `X-Snipcart-RequestToken` verified against `https://app.snipcart.com/api/requestvalidation/{token}` with the secret key (valid 1 min, single use). The development HMAC (`SNIPCART_WEBHOOK_SECRET`) is refused when `NODE_ENV=production`. Its own rate limit (300/min per IP; Snipcart delivers from a few IPs), since it sits ahead of the global API limiter. |
| Source of truth | The order is re-read from Snipcart's API with the secret key; the webhook body is only a trigger. A failed read answers 502 so Snipcart retries. |
| Payment status | Granted only when Snipcart reports `Paid` / `PaidDeferred`; a `Deferred` order waits for `order.paymentStatus.changed`. `Refunded`, `ChargedBack`, `Cancelled`, `Failed`, `Expired`, a cancelled order or any refunded amount (a partial refund leaves the status at `Paid`) revoke a granted one (order status and every purchase row). To compensate a buyer without taking the photos away, use a discount on a later order instead of a partial refund. |
| Webhook idempotency | Keyed on the Snipcart order id (UNIQUE) — redeliveries create nothing. The response is `{ ok: true }` only: no token lands in Snipcart's webhook logs. |
| What can be sold | Only a gallery that is priced, active, not archived, not a draft and not expired; only photos an ordinary guest sees (visible, not under review, processed), no videos. Same rule in the price check, the webhook and the purchase link (`modules/photoSales/sellable.js`). |
| Gallery password | Each cart line's URL carries a sale signature (HMAC of the photo id with `JWT_SECRET`) that the gallery hands out only with its photo list, i.e. after the gallery's access check. Knowing a slug and guessing photo ids is not enough to buy. The signature is permanent per photo: changing the gallery password does not invalidate signatures already handed out (they only let a viewer buy, never view). |
| Price integrity | The price check answers Snipcart's crawler with the database price (`{ id, price }`), so a re-priced cart line fails before payment. The webhook recomputes the total from the DB (photo prices, promo code, prior orders) and compares currency and amount. A refused order is stored first (so two concurrent deliveries refund it once), then refunded; it reads `refund_failed` until Snipcart accepts the refund, so an order that could not be refunded (no total, nothing charged) is never shown as refunded. It grants **no** downloads. |
| Originals | Served only with a valid purchase access token for a `completed` order (`photo_purchases` + `expires_at`), from a gallery that is still active. Tokens are random, non-guessable and never consumed; access expires or is revoked. Admins copy a buyer's link through an owner-only route; the order list never carries it. |
| Snipcart script | Loaded with Subresource Integrity (pinned `v3.4.0` hashes in `PhotoSalesContext.tsx`). |
| CSP | Snipcart's needs (`'unsafe-eval'`, its CDN, API and payment frame) are granted on gallery pages only: `location @gallery_spa` in `frontend/nginx.conf`, and the same policy on the backend's `/gallery/*` SPA routes for the all-in-one image and native installs (`modules/photoSales/galleryCsp.js`, kept in step by a test). The admin app and every other page keep the strict policy. |
| Pre-purchase views/downloads | All photos of a priced gallery are served watermarked (tiled) and low-resolution only. Guest download paths are locked to the watermarked rendition; a priced gallery never serves a prebuilt archive, and download jobs built before pricing are not reused. |
| Promo code | Crypto-random, single-use (Snipcart side), hidden until the discount is synced, and re-verified server-side at order time. |
| Admin routes | Orders list requires `events.view`; copying or resending a buyer's link requires `events.edit` + being the gallery's owner (an assigned team member reads the orders but gets no link); per-photo price edits require `photos.edit` + ownership. |
| Secrets | The secret key is never logged, never exposed in payloads, and only used for server-to-server calls. |

**Defence in depth:** a cart re-priced in the browser fails Snipcart's own
validation against the price check. If an order still arrives with the wrong
amount (a promo misuse, a tax added on top), the webhook audit refunds it and
grants nothing. A refund Snipcart refuses shows as "Refund failed" in the
Orders tab — refund that order by hand in the Snipcart dashboard.

## Architecture

- `backend/src/modules/photoSales/` — pricing rules, what is sellable and
  the sale signature (`sellable.js`), purchase access, admin summaries,
  watermark preview pre-generation, promo-code/discount sync (creation is
  claimed in the database, so concurrent replicas create one discount).
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

The forced mark is a spaced diagonal pattern (`watermarkService.salesTile`,
about three marks across the image). Watermarked lightbox previews are
rendered in the background (not on first
view): after each upload finishes processing in a priced gallery, and when a
gallery is switched to priced. Files live in `storage/watermarks_sales/`
(`photos.photo_sales_preview_key/path`, migration 317) and are re-rendered
automatically when the mark settings change. A preview whose mark fails is
never stored, and a photo without a sales preview is left out of a priced
gallery's archives instead of falling back to the original.

### Migrations

`317` pricing schema (gallery and per-photo prices, promo code, preview
cache, orders and purchases) · `318` buyer email template.

## Operations

- **Regenerate watermark previews / promo discount**: re-save the event in the
  admin editor, or restart the backend (startup sync covers missing discounts).
- **Resend a buyer's link**: Event → Orders → "Resend link" (paid orders
  with access left).
- **Local testing**: `node scripts/simulate-snipcart-webhook.js <slug> <photoId>… --total=<amount>`
  against a backend NOT running with `NODE_ENV=production`.
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
