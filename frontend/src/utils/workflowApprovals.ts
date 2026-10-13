/**
 * Shared bits of the two pending-approval lists (dashboard card + the
 * Approvals page), so they can't drift apart again.
 */

// Admin detail route per run entity. The CRM documents live under the
// /admin/clients layout; the old top-level /admin/quotes/:id paths 404.
const ENTITY_ROUTES: Record<string, string> = {
  quote: '/admin/clients/quotes',
  invoice: '/admin/clients/bills',
  contract: '/admin/clients/contracts',
  customer: '/admin/clients/accounts',
  event: '/admin/events',
};

export function approvalEntityHref(a: { entity_type?: string | null; entity_id?: number | null }): string | null {
  if (!a.entity_type || a.entity_id == null) return null;
  const base = ENTITY_ROUTES[a.entity_type];
  return base ? `${base}/${a.entity_id}` : null;
}

/** The gate's own wording (its prompt, else its label) — never the internal type key. */
export function approvalPrompt(a: { payload?: Record<string, unknown> | null }): string | null {
  const p = a.payload || {};
  const text = (typeof p.prompt === 'string' && p.prompt) || (typeof p.label === 'string' && p.label);
  return text || null;
}
