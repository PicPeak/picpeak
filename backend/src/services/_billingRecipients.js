/**
 * Recipient resolution for billing-class outbound emails (invoice,
 * Storno, payment reminders).
 *
 * Customer accounts carry two email fields:
 *   - `email`          — primary contact, used for account auth,
 *                        gallery sharing, quote / contract sends, and
 *                        event reminders. The decision-maker address.
 *   - `billing_email`  — optional bookkeeper / accounts-payable
 *                        address. When set, billing documents go To:
 *                        here and the primary `email` is CC'd so the
 *                        decision-maker stays in the loop.
 *
 * Non-billing flows (quote, contract, gallery, event reminder, gallery
 * share) must NOT use this helper — they always route to the primary
 * `email` regardless of whether a billing_email is configured.
 *
 * The per-document `cc_pdf_email` field on invoices / Storno / quotes
 * is an additional CC the admin can set per save; this helper folds it
 * in alongside the billing/primary split and dedupes against the To:
 * address so the same address never appears twice on one envelope.
 */

/**
 * @param {object} customer        a `customer_accounts` row; only
 *                                 `email` + `billing_email` are read.
 * @param {string|null|undefined} perDocCcEmail   the `cc_pdf_email`
 *                                 column from the document being sent;
 *                                 may be null/empty (no per-doc CC).
 * @returns {{ to: string, cc: string[] | undefined }}
 *   `to`  — single address (billing_email when set, else email).
 *   `cc`  — array of additional addresses, or undefined when there
 *           are none. Always deduplicated against `to` and against
 *           itself (case-insensitive).
 */
function resolveBillingRecipients(customer, perDocCcEmail) {
  const billing = String(customer?.billing_email || '').trim();
  const main = String(customer?.email || '').trim();
  const perDoc = String(perDocCcEmail || '').trim();

  const to = billing || main;
  if (!to) {
    // No usable address at all. Caller will hit emailProcessor's own
    // validation; we just return a safe shape so callers don't crash.
    return { to: '', cc: undefined };
  }

  const toKey = to.toLowerCase();
  const ccKeys = new Set();
  const ccList = [];
  const pushCc = (addr) => {
    if (!addr) return;
    const key = addr.toLowerCase();
    if (key === toKey || ccKeys.has(key)) return;
    ccKeys.add(key);
    ccList.push(addr);
  };

  // Only CC the main email when billing_email actually took the To
  // slot — when billing is empty, `to` already IS the main email and
  // we don't want to CC self.
  if (billing && main) pushCc(main);
  if (perDoc) pushCc(perDoc);

  return { to, cc: ccList.length > 0 ? ccList : undefined };
}

module.exports = { resolveBillingRecipients };
