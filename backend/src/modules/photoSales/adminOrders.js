const { pauseAdjustedExpiry } = require('./purchaseAccess');

function summarisePurchaseOrder(order, rows = [], gallery) {
  const photos = Array.isArray(rows) ? rows : [];
  const purchasedAt = order?.purchased_at ? new Date(order.purchased_at) : null;
  const effectiveExpiry = gallery && order?.status === 'completed'
    ? pauseAdjustedExpiry(order, gallery) : order?.expires_at;
  const expiresAt = effectiveExpiry ? new Date(effectiveExpiry) : null;
  const remainingMs = expiresAt && Number.isFinite(expiresAt.getTime())
    ? Math.max(0, expiresAt.getTime() - Date.now())
    : 0;

  return {
    order_id: String(order?.order_id || ''),
    payment_provider: order?.payment_provider || 'snipcart',
    provider_order_id: order?.provider_order_id || order?.checkout_session_id || null,
    needs_attention: !!order?.recovery_needs_attention || ['refund_pending', 'refund_failed'].includes(order?.status),
    recovery_error: order?.recovery_error || null,
    recovery_next_at: order?.recovery_next_at || null,
    buyer_email: String(order?.buyer_email || ''),
    total_cents: Number(order?.total_cents || 0),
    currency: String(order?.currency || 'EUR'),
    purchased_at: order?.purchased_at || null,
    expires_at: effectiveExpiry || null,
    // Granted, or what became of it: refunded, refund_failed, charged_back,
    // cancelled. The access token itself is never listed — the owner fetches
    // the link through POST …/access-link.
    status: String(order?.status || 'completed'),
    photo_count: photos.length,
    remaining_ms: remainingMs,
    remaining_days: remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0,
    purchased_at_date: purchasedAt && Number.isFinite(purchasedAt.getTime()) ? purchasedAt.toISOString() : null,
  };
}

module.exports = {
  summarisePurchaseOrder,
};
