/**
 * Feature flags admin endpoints (#feature-flags-settings-reorg).
 *
 * GET  /api/admin/feature-flags  → { [key]: boolean }
 * PUT  /api/admin/feature-flags  → body { [key]: boolean }, replaces in tx
 *
 * Server-side dependency rules mirror the frontend:
 *   - quotes=false  forces bills=false
 *   - calendar=false forces calendarBooking=false
 *   - galleries is hard-coded true regardless of input
 *
 * Audit log: every successful PUT writes one activity_logs row with the
 * before/after diff so changes are traceable.
 */

const express = require('express');
const router = express.Router();
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { invalidateFeatureFlagCache } = require('../middleware/requireFeatureFlag');
const logger = require('../utils/logger');

// Canonical flag list. Keep in sync with frontend
// `FeatureKey` union in frontend/src/contexts/FeatureFlagsContext.tsx.
const KNOWN_FLAGS = [
  'galleries',
  'reminderEmails',
  // Incoming mail (migration 128) — IMAP polling of a dedicated mailbox into
  // the incoming-invoices inbox. Standalone toggle.
  'incomingMail',
  'calendar',
  'calendarBooking',
  'quotes',
  'bills',
  'messaging',
  'analytics',
  'userManagement',
  // Top-level "Clients" section (#354 follow-up). Parent flag that
  // gates the /admin/clients/* sidebar entry. customerPortal,
  // calendar, quotes, bills and messaging are conceptually its
  // children — when `clients` is off none of them surface in the
  // admin UI even if their individual flags are on.
  'clients',
  // Customer-side portal surface (#354). Gates /customer/* routes
  // and the Accounts sub-page under Clients. See migration 095.
  'customerPortal',
  // CRM developer tools sub-tab — internal helpers (test the
  // payment-check email flow without waiting 30 days, etc.).
  // Strictly opt-in.
  'crmDevelopment',
  // Tax / Steuer report — an Accounting sub-feature (moved out of CRM).
  // Independent of `bills`; forced off when the `accounting` master is off
  // (see applyDependencyRules below).
  'taxReport',
  // Hours logging (migration 129). Master switch for the per-customer
  // Hours card + the auto-append into monthly draft / "Bill these
  // hours" flow. Independent of `bills` because hours are an INPUT to
  // bills — admin who's still in the dogfood phase may want to log
  // hours without enabling the full billing surface yet.
  'hoursLogging',
  // Contracts (migration 130). Independent of quotes/bills — contracts
  // are a standalone legal document type with their own composition
  // (blocks) and signing flow (in-browser canvas + wet-signed PDF
  // upload). Seeded block bodies are EXAMPLES ONLY; admins must have a
  // lawyer review before sending. See docs/crm-disclaimers.md.
  'contracts',
  // Accounting (migration 122). Top-level Accounting area — inbound
  // supplier invoices, expenses + re-bill, and the tax report (which
  // relocates here from CRM when this is on). Strictly opt-in.
  'accounting',
  // Incoming invoices (migration 124) — external supplier-invoice capture +
  // re-bill. Accounting sub-feature; forced off when the `accounting` master
  // is off.
  'incomingInvoices',
  // Expenses (migration 127) — internal expenses (mileage / per-diem / cash).
  // Separate Accounting sub-feature; forced off when `accounting` is off.
  'expenses',
  // Projects (migration 120). Admin-only grouping layer above events +
  // the Project Overview cockpit ("book to project" hours control, 360°
  // rollup feed). Lights up the Clients section. Customers never see it.
  'projects',
  // WhatsApp Business API delivery channel (migration 136, #640D). Strictly
  // opt-in — operators must register a Meta-approved template before turning
  // it on. Independent of email; both can fire on the same event.
  'whatsapp',
  // Live Slideshow ("Diashow") — the per-event fullscreen kiosk link + its
  // per-event-type presets and global watermark defaults tab. Strictly opt-in;
  // gates all slideshow admin UI (per-event card, type preset, settings tab).
  'slideshow',
  // Workflow / automation engine — admin-configurable visual flows (triggers,
  // conditions, branches, loops, approval gates). Strictly opt-in; master
  // kill-switch for the Workflows admin area AND the engine's runtime side
  // effects (no run is created/resumed while off).
  'workflows',
];

// Spec defaults for any flag missing from the DB (e.g. a row added by a
// new release that hasn't run its migration yet on this instance).
const DEFAULT_FLAGS = {
  galleries: true,
  incomingMail: false,
  // F.3 — reminderEmails is a placeholder card in the Features tab
  // (lockedReason: NOT_YET_AVAILABLE). Default FALSE so it matches
  // the locked-but-off visual state of messaging / calendarBooking
  // instead of being a confusing "on but locked".
  reminderEmails: false,
  calendar: false,
  calendarBooking: false,
  quotes: false,
  bills: false,
  messaging: false,
  analytics: true,
  userManagement: true,
  clients: false,
  taxReport: false,
  hoursLogging: false,
  contracts: false,
  accounting: false,
  incomingInvoices: false,
  expenses: false,
  projects: false,
  whatsapp: false,
  slideshow: false,
  workflows: false,
};

async function readAllFlags() {
  const rows = await db('feature_flags').select('key', 'value');
  const result = { ...DEFAULT_FLAGS };
  for (const row of rows) {
    if (KNOWN_FLAGS.includes(row.key)) {
      result[row.key] = Boolean(row.value);
    }
  }
  return result;
}

function applyDependencyRules(flags) {
  const out = { ...flags };
  // Galleries is the foundation — never off.
  out.galleries = true;
  // Sub-features can't outlive their parents.
  if (out.quotes === false) out.bills = false;
  if (out.calendar === false) out.calendarBooking = false;
  // Invoices (Bills) force-enable the Accounting master: invoice VAT config
  // (codes + label) and the hourly rate live under Settings → Accounting, so
  // an install with invoices must have Accounting available. Runs BEFORE the
  // accounting→children rule so the sub-features keep their own stored state.
  if (out.bills === true) out.accounting = true;
  // Accounting is a top-level MASTER; its sub-features can't outlive it.
  // Tax export is now independent of Bills — it relocated permanently
  // into the Accounting section (its own master gate).
  if (out.accounting === false) {
    out.taxReport = false;
    out.incomingInvoices = false;
    out.expenses = false;
  }
  // Clients parent flag is DERIVED from its children. Admins don't
  // toggle it directly in the Features tab — they enable a specific
  // sub-feature (Accounts today; Calendar/Quotes/Bills/Messaging
  // later) and the Clients sidebar section lights up automatically.
  // Computing the value here (rather than only on writes) means GET
  // /admin/feature-flags also returns a consistent state if the DB
  // ever drifts (e.g. partial migration run).
  out.clients = Boolean(
    out.customerPortal
    || out.crmDevelopment
    || out.quotes
    || out.bills
    || out.hoursLogging
    || out.contracts
    // NOTE: taxReport intentionally removed — Tax export moved to the
    // Accounting section (its own master), no longer a CRM sub-feature.
    // Migration 120 — admin-only Project Overview cockpit lives under Clients.
    || out.projects
    // Migration 137 — admin calendar lights up the Clients section.
    // (calendarBooking is gated behind `calendar` so adding the parent
    // is sufficient.)
    || out.calendar
    // future siblings (out.messaging) go here
  );
  return out;
}

router.get('/', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const flags = await readAllFlags();
    // Always run the rules so derived flags (e.g. `clients`) and
    // hard invariants (galleries always on) are consistent even if
    // the DB row is stale or missing.
    res.json(applyDependencyRules(flags));
  } catch (error) {
    logger.error('Failed to read feature flags', { error: error.message });
    res.status(500).json({ error: 'Failed to read feature flags' });
  }
});

router.put('/', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be an object of { key: boolean } pairs' });
    }

    // Validate keys + types up front.
    const cleaned = {};
    for (const [key, value] of Object.entries(body)) {
      if (!KNOWN_FLAGS.includes(key)) {
        return res.status(400).json({ error: `Unknown feature flag: ${key}` });
      }
      if (typeof value !== 'boolean') {
        return res.status(400).json({ error: `Flag ${key} must be boolean, got ${typeof value}` });
      }
      cleaned[key] = value;
    }

    const before = await readAllFlags();
    const merged = applyDependencyRules({ ...before, ...cleaned });

    // Compute diff for audit log.
    const changed = {};
    for (const key of KNOWN_FLAGS) {
      if (merged[key] !== before[key]) {
        changed[key] = { from: before[key], to: merged[key] };
      }
    }

    if (Object.keys(changed).length === 0) {
      // No-op write — return current state, skip audit log.
      return res.json(merged);
    }

    const adminId = req.admin?.id || null;
    const adminUsername = req.admin?.username || 'unknown';

    await db.transaction(async (trx) => {
      for (const key of KNOWN_FLAGS) {
        const value = merged[key];
        const existing = await trx('feature_flags').where({ key }).first();
        if (existing) {
          await trx('feature_flags')
            .where({ key })
            .update({ value, updated_at: trx.fn.now(), updated_by: adminId });
        } else {
          await trx('feature_flags').insert({ key, value, updated_by: adminId });
        }
      }
    });

    // Drop the requireFeatureFlag middleware's short-TTL cache so a toggle takes
    // effect immediately instead of after ≤10s.
    invalidateFeatureFlagCache();

    await logActivity(
      'feature_flags_updated',
      { changed, actor: adminUsername },
      null,
      { type: 'admin' }
    );

    res.json(merged);
  } catch (error) {
    logger.error('Failed to update feature flags', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to update feature flags' });
  }
});

module.exports = router;
