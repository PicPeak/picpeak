# Photo sales — setup, pricing and recovery

Priced galleries show watermarked previews. Buyers choose photos in PicPeak,
review their cart and pay with Stripe-hosted Checkout or Snipcart. If both are
configured, buyers choose at checkout; Stripe is selected first. Verified payment grants
access to the clean originals through the existing purchased-download page and
email. Ordinary galleries keep their existing download behaviour.

Existing Snipcart installations keep working after upgrading. Configure either
provider or both in **Settings → Payments**. The provider checkboxes control new
checkouts; turning one off retains its credentials and continues reconciliation,
refunds and disputes for existing orders. Only super admins can change these
installation-wide settings. Prices and promo credit remain per gallery.

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
credential fields are read-only. Checkout availability can still be changed.
Values from the environment and database are never mixed.
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
The Payments page shows an unreadable-credentials warning and the backend logs
a provider-specific recovery message without including keys or ciphertext.
When `PAYMENTS_ENCRYPTION_KEY` is unset, rotating `JWT_SECRET` also changes the
payment encryption key; adding a new dedicated key later has the same effect.

Stripe processing fees and optional Stripe services still apply. Hosted Checkout
is included with [standard Stripe Payments pricing](https://stripe.com/pricing).
PicPeak adds no separate cart fee to Stripe checkout. Snipcart retains its own
subscription/transaction fees when chosen. Refunds and disputes are managed in Stripe;
PicPeak reflects their effect on download access.

## Set up or retain Snipcart

Existing `SNIPCART_API_KEY` (public) and `SNIPCART_SECRET_API_KEY` (secret)
continue to configure the store without requiring Stripe. Alternatively, remove
both environment variables and enter the pair in Settings → Payments. Both
must belong to the same store and test/live environment. Only the public key
reaches the browser; the secret is encrypted at rest. Saving checks secret-key
read access, not the public/secret pairing or successful payment delivery.

Add the displayed `/api/gallery/snipcart-webhook` URL in Snipcart's dashboard,
allow the public PicPeak domain, and keep prices tax-inclusive in EUR. Existing
per-gallery webhook URLs remain supported. Test a
purchase, buyer email, original download and refund before accepting payments.
Keep secret-key access to the same store for historical orders and refunds.
The development HMAC simulator remains disabled in production.

Buyers select photos and enter a promo in PicPeak, then Snipcart opens only
when chosen at checkout. The server reserves the order and promo first; signed
price-check URLs validate the saved prices. Gallery pages permit Snipcart's
CDN, API and payment frames only while Snipcart checkout is offered. Stripe-only
installations retain the strict gallery policy; admin pages never gain Snipcart
script permissions.

After handoff, Snipcart hides item removal, quantity changes and the discount
box; totals remain visible. Close Snipcart to edit the cart in PicPeak. Editing
does not release a pending payment or its promo reservation.

## Pricing and access rules

- Currency remains EUR. Prices are tax inclusive, with no shipping and no
  automatic Stripe Tax or paid invoice creation. Configure gross photo prices
  accordingly; this feature does not calculate tax or issue tax invoices.
- Each photo uses its override, or the gallery default when the override is null.
  A cart contains 1–100 distinct photos from one gallery, each with quantity one.
- A promo must be explicitly entered in the PicPeak cart. It is one use **per
  gallery**, not per buyer: the credit is `free_photo_count × photo_price`, capped
  at the cart total. Per-photo overrides do not change that credit. A fully
  discounted order still completes the provider checkout to collect the buyer's email.
- Applying a promo also requires a six-digit code emailed by PicPeak; no account
  or feedback registration is created. Configure SMTP or the email webhook
  transport before offering promos. Ordinary paid checkout needs no verification.
  Codes last 15 minutes with five attempts. Sending is limited to once a minute
  and five times an hour per address across galleries, plus a network limit.
  A verified address can hold one outstanding promo checkout across both
  providers and galleries. This prevents fresh tabs from resetting the cap;
  multiple mailboxes/aliases and repeated reservations after expiry remain possible.
  Verification grants last 30 minutes and are gallery- and session-bound.
  PicPeak retains keyed address hashes, hashed codes and hashed browser proofs;
  expired challenges are removed by checkout recovery after the hourly budget.
  Order identity hashes remain with financial history. JWT-secret rotation
  invalidates grants and changes the address hashes used for this cap.
- Starting a discounted checkout reserves the same database promo claim for
  either provider. Promo checkout windows last approximately 31 minutes;
  ordinary checkout windows last up to one hour. Returning from Stripe alone
  does not release it: PicPeak asks Stripe to expire the checkout first, so
  another open tab cannot pay using the same credit. Confirmed failed/expired
  checkouts release unused credit; a completed redemption remains spent after a
  refund. Historical Snipcart redemptions remain spent too. Snipcart cannot
  confirm cancellation of an unpaid cart through its Orders API; an unsubmitted
  reservation expires after its window plus five minutes. A known pending
  provider payment retains its claim while it settles. A late payment against
  an expired reservation or a conflicting redemption is refused/refunded,
  rather than granting a second use of the code. Unpaid pre-upgrade Snipcart
  carts without a PicPeak reservation must restart from the gallery, so they
  cannot bypass promo verification. Already-submitted payments continue to
  settle, acquiring the same unique promo claim when applicable; purchase
  links, refunds and disputes are unaffected.
- PicPeak snapshots prices, discount and the promised download deadline before
  creating Checkout. Later price edits do not invalidate an honest purchase.
  Access never exceeds the gallery's expiry, including a later shortened expiry.
  A gallery closing in less than 31 minutes cannot start a new Stripe checkout because
  Stripe requires at least 30 minutes until Checkout expiry.
- Hidden, moderated, trashed, unprocessed and video items cannot be bought.
  Gallery access is checked before checkout and availability is checked again
  before delivery. Closing/deleting the gallery or withdrawing a photo before
  payment confirmation prevents delivery and triggers an automatic refund.
  A temporary pause (#2296) preserves a valid purchase and email, blocks
  downloads with an explanation/contact address, and compensates the overlap
  when resumed without exceeding the gallery's expiry.
- A success URL does not prove payment. Buyers see a confirmation screen while
  verified callbacks establish payment; delayed methods may take longer. The
  existing purchase token grants only that order's photos until its deadline.
- Any refund, including a partial refund, or a dispute revokes the whole order's
  download access. To compensate a buyer while keeping access, use an agreed
  alternative rather than a partial refund. Dispute closure does not
  automatically restore access, including when the merchant wins the dispute.

## Recovery and security

Stripe callbacks use the raw body and timestamped signature verification.
Snipcart callbacks validate its one-use request token and fetch the order using
the secret API key. The
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
can be reconciled. Recovery saves its pagination cursor, so stores with more
than 1,000 sessions do not repeatedly scan only the first pages. Only a complete
scan after the checkout window plus five minutes proves no session exists;
incomplete/provider-failed scans retain the claim and eventually flag attention.
A periodic task recovers missed callbacks, abandoned checkouts
and failed email queueing; it uses the normal worker shutdown/restore lifecycle.
It uses the existing database lease to prevent concurrent replica sweeps,
isolates malformed quotes per order, and backs off repeated failures up to a
daily check. Unknown outcomes are never declared unpaid or paid. Snipcart
refunds that might already have been submitted are not automatically repeated. After restoring an older
database, reconcile payments against Stripe; callbacks for this installation
whose local order is missing fail for retry rather than claiming delivery. Financial order records
survive gallery deletion, allowing late payments to be refunded. Super admins
can find orphaned orders and recovery/refund attention records in Settings →
Payments. Gallery Orders hides expired, failed and cancelled attempts by default,
with a checkbox to show them. Financial and uncertain records are retained;
there is no automatic deletion policy.

An unavailable-photo or total mismatch records the automatic refund outcome.
**Refund pending** means it has not completed. **Refund failed** needs attention:
check the order and refund in Stripe before issuing a manual refund. A provider
outage does not unlock originals or claim that money has been returned.

## Changing providers

Adding Stripe does not disable Snipcart or change existing purchase links.
Keep access to each merchant account while it has outstanding payments,
refunds or disputes. PicPeak does not cancel a provider's subscription or billing;
turning off its checkout checkbox only stops new PicPeak handoffs. Retain the
provider's financial exports according to the merchant's accounting practices.
