# Photo sales — setup, pricing and migration

Priced galleries show watermarked previews. Buyers choose photos in PicPeak,
review their cart and pay on Stripe-hosted Checkout. Verified payment grants
access to the clean originals through the existing purchased-download page and
email. Ordinary galleries keep their existing download behaviour.

## Set up Stripe

1. Configure the public **Site URL** in Settings → General, or set `FRONTEND_URL`.
   Production checkout requires HTTPS. Payment redirects never use a request's
   Host header as their destination.
2. As a **super admin**, open **Settings → Payments**. One Stripe account receives
   photo payments from every gallery on the installation. Prices and promos
   remain per gallery; payment credentials are installation-wide. Follow the
   five-step guide: check the public address, add a restricted key, configure
   payment notifications, save/check access, then test a purchase. Moving
   between steps does not save or discard credential entries; use the page's
   Save changes / Discard bar. Saved secrets stay blank.
3. Start in a dedicated [Stripe sandbox](https://docs.stripe.com/sandboxes).
   Create a [restricted API key](https://docs.stripe.com/keys/restricted-api-keys)
   with Account read, Checkout Sessions read/write, Payment Intents and Charges
   read, and Refunds write. Allow Products/Prices write if required for inline
   checkout prices. The setup page checks Account and Checkout Sessions read
   access; it does not claim to verify write/refund permissions.
4. In Stripe, create an event destination using the webhook URL and required
   events shown on the Payments page. The path is
   `/api/photo-sales/stripe/webhook`. The guide uses a separate public API
   address when `API_URL` is configured and offers copy controls for the URL
   and event names. HTTPS address checks validate the format, not Stripe's
   ability to reach it. Choose API version `2026-09-30.endive` and subscribe to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`,
   `charge.dispute.closed`, `refund.updated` and `refund.failed`.
5. Enter the API key and the destination's `whsec_` signing secret, then save.
   Both must belong to the same account and test/live mode. The fields stay
   blank after saving; blank inputs keep existing secrets. Secrets are encrypted
   at rest, excluded from generic settings reads/writes, and never returned to
   browsers. Changes take effect without restarting the backend.
6. Enable payment methods in Stripe. PicPeak uses dynamic payment methods and
   waits for delayed methods to confirm before releasing originals. In each
   gallery's **Photo sales** settings, enable pricing and set its price, optional
   promo credit and download-access duration.
7. Verify a sandbox purchase, cancellation, refund and buyer email. **Check saved
   API access** is a read-only probe that creates no payments. **Signed webhook
   received** records a valid signature for the current credentials; it does not
   prove order fulfilment. Resolve outstanding test checkouts before switching
   to live keys and the matching live signing secret. Once live orders exist,
   retain live access for refunds/disputes. Keys can be rotated for the same
   account; moving financial history to another account requires a migration.

### Server-managed credentials and encryption

Existing `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` environment variables
remain supported. If either is set, the pair takes precedence and the Payments
page is read-only. Values from the environment and database are never mixed.
Remove both variables and restart before managing credentials through Settings.
Moving an existing setup into Settings verifies access to its existing sessions.
Hosted Checkout needs no publishable key or browser payment SDK.

Saved credentials use AES-256-GCM with a key derived from
`PAYMENTS_ENCRYPTION_KEY`, or `JWT_SECRET` when the optional variable is unset,
following the existing SSO/MFA secret-storage approach. Preserve that encryption
material independently of database backups. Set a stable `PAYMENTS_ENCRYPTION_KEY`
before the first save if JWT secrets will be rotated independently. Changing or
losing the encryption key requires restoring it or re-entering both credentials
for the same account; unreadable credentials leave checkout unavailable.

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
