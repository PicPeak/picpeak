function summarisePurchaseOrder(order, rows = []) {
  const photos = Array.isArray(rows) ? rows : [];
  const purchasedAt = order?.purchased_at ? new Date(order.purchased_at) : null;
  const expiresAt = order?.expires_at ? new Date(order.expires_at) : null;
  const remainingMs = expiresAt && Number.isFinite(expiresAt.getTime())
    ? Math.max(0, expiresAt.getTime() - Date.now())
    : 0;

  return {
    order_id: String(order?.order_id || ''),
    buyer_email: String(order?.buyer_email || ''),
    total_cents: Number(order?.total_cents || 0),
    currency: String(order?.currency || 'EUR'),
    purchased_at: order?.purchased_at || null,
    expires_at: order?.expires_at || null,
    access_token: order?.access_token || null,
    photo_count: photos.length,
    remaining_ms: remainingMs,
    remaining_days: remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0,
    purchased_at_date: purchasedAt && Number.isFinite(purchasedAt.getTime()) ? purchasedAt.toISOString() : null,
  };
}

module.exports = {
  summarisePurchaseOrder,
};
