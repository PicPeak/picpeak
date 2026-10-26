# Photo sales — setup, pricing and migration

Priced galleries show watermarked previews. Buyers choose photos in PicPeak,
review their cart and pay on Stripe-hosted Checkout. Verified payment grants
access to the clean originals through the existing purchased-download page and
email. Ordinary galleries keep their existing download behaviour.

## Set up Stripe

1. Configure the public **Site URL** in Settings → General, or set `FRONTEND_URL`.
   Production checkout requires HTTPS. Payment redirects never use a request's
   Host header as their destination.
2. Create credentials for the merchant's Stripe account. Start in a dedicated
   [Stripe sandbox](https://docs.stripe.com/sandboxes), with test credentials.
   Prefer a [restricted API key](https://docs.stripe.com/keys/restricted-api-keys)
   with Checkout Sessions read/write, Payment Intents and Charges read, and
   Refunds write. Allow Products/Prices write if required for inline checkout
   prices. Confirm these permissions with a sandbox purchase and refund.
3. Configure the backend environment (the standard and production Compose files
   forward both values):

   ```dotenv
   STRIPE_SECRET_KEY=
   STRIPE_WEBHOOK_SECRET=
   ```

   Neither value is served to browsers. Hosted Checkout needs no publishable key,
   Stripe.js, embedded payment frame or extra gallery CSP sources.
4. In Stripe, create a webhook endpoint at:
   `https://your-public-api-host/api/photo-sales/stripe/webhook`.
   Subscribe to `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`,
   `charge.dispute.closed`, `refund.updated` and `refund.failed`.
   Use the endpoint's signing secret for `STRIPE_WEBHOOK_SECRET` and match the
   account and test/live mode of the API key. The SDK pins API version
   `2026-09-30.endive`; use that version for the endpoint too.
5. Enable payment methods in the Stripe Dashboard. PicPeak uses dynamic payment
   methods and waits for delayed methods to confirm before releasing originals.
6. Restart the backend. In a gallery's **Photo sales** settings, enable pricing,
   set its default price, optional promo credit and access days. The Orders tab
   shows missing configuration and test mode. These are configuration-presence
   checks, not proof that Stripe credentials or webhook delivery work.
7. Verify a sandbox purchase, cancellation, refund and buyer email before using
   live credentials and the corresponding live webhook endpoint.

Stripe processing fees and optional Stripe services still apply. Hosted Checkout
is included with [standard Stripe Payments pricing](https://stripe.com/pricing).
PicPeak adds no separate cart fee. Refunds and disputes are managed in Stripe;
PicPeak reflects their effect on download access.

## Pricing and access rules

- Currency remains EUR. Prices are tax inclusive, with no shipping and no
  automatic Stripe Tax or paid invoice creation. Configure gross photo prices
  accordingly; this feature does not calculate tax or issue tax invoices.
- Each photo uses its override, or the gallery default when the override is null.
  A cart contains 1–100 distinct photos from one gallery, each with quantity one.
- A promo must be explicitly entered in the PicPeak cart. It is one use **per
  gallery**, not per buyer: the credit is `free_photo_count × photo_price`, capped
  at the cart total. Per-photo overrides do not change that credit. A fully
  discounted order still completes Checkout to collect the buyer's email.
- Starting a discounted checkout reserves the promo. Returning from Stripe alone
  does not release it: PicPeak asks Stripe to expire the checkout first, so
  another open tab cannot pay using the same credit. Confirmed failed/expired
  checkouts release unused credit; a completed redemption remains spent after a
  refund. Historical Snipcart redemptions remain spent too.
- PicPeak snapshots prices, discount and the promised download deadline before
  creating Checkout. Later price edits do not invalidate an honest purchase.
  Access never exceeds the gallery's expiry, including a later shortened expiry.
  A gallery closing in less than 31 minutes cannot start a new checkout because
  Stripe requires at least 30 minutes until Checkout expiry.
- Hidden, moderated, trashed, unprocessed and video items cannot be bought.
  Gallery access is checked before checkout and availability is checked again
  before delivery. Closing/deleting the gallery or withdrawing a photo before
  payment confirmation prevents delivery and triggers an automatic refund.
- A success URL does not prove payment. Buyers see a confirmation screen while
  verified callbacks establish payment; delayed methods may take longer. The
  existing purchase token grants only that order's photos until its deadline.
- Any refund, including a partial refund, or a dispute revokes the whole order's
  download access. To compensate a buyer while keeping access, use an agreed
  alternative rather than a partial refund. Dispute closure does not
  automatically restore access.

## Recovery and security

Callbacks use the raw body and Stripe's timestamped signature verification. The
server reads the authoritative Checkout Session and payment, checks mode,
currency and total, and commits entitlements atomically. Duplicate or out-of-order
callbacks cannot grant twice or revive a revoked order. Webhook responses and
admin order lists never include purchase access tokens. A return URL alone
grants nothing: confirmation and cancellation also require a random browser
proof, stored separately in session storage and never sent to Stripe. A buyer
returning in another browser can use the emailed purchase link. Only the gallery owner
can fetch a buyer's link or resend it.

Creation retries reuse the same immutable request and Stripe idempotency key.
An ambiguous timeout keeps its promo reservation until the provider's session
can be reconciled. A periodic task recovers missed callbacks, abandoned checkouts
and failed email queueing; it uses the normal worker shutdown/restore lifecycle.
Unknown creation outcomes are never treated as paid. After restoring an older
database, reconcile payments against Stripe; callbacks for this installation
whose local order is missing fail for retry rather than claiming delivery. Financial order records
survive gallery deletion, allowing late payments to be refunded.

An unavailable-photo or total mismatch records the automatic refund outcome.
**Refund pending** means it has not completed. **Refund failed** needs attention:
check the order and refund in Stripe before issuing a manual refund. A provider
outage does not unlock originals or claim that money has been returned.

## Migrate from Snipcart

The upgrade keeps existing galleries, prices, promo codes, orders and purchase
links. Historical orders are marked `snipcart`; new checkouts use `stripe`.
Configure Stripe before reopening priced galleries for sales: the old browser
key does not activate the new checkout, and missing Stripe configuration leaves
purchases unavailable while previews remain protected.

Keep `SNIPCART_SECRET_API_KEY` and the existing `/api/gallery/snipcart-webhook`
endpoint configured while settling in-flight Snipcart orders and monitoring their
refunds/disputes. Existing per-gallery webhook URLs and signed price-check URLs
remain supported for those checkouts. The development-only simulator secret
remains ignored in production. New gallery views load no Snipcart scripts or CSS,
expose no Snipcart public key and create no Snipcart discount coupons.

Existing download links do not contact Snipcart. PicPeak does not cancel the
merchant's Snipcart account or billing: reconcile its outstanding payments and
refund responsibilities before changing or closing that service. Retain its
financial exports according to the merchant's normal accounting practices.
