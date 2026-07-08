/**
 * Boot-time seed for built-in workflows.
 *
 * Seeds the reminder/booking ladders as EDITABLE built-in flows, so the canvas
 * has real content and admins can see (and tweak) their processes as blocks.
 *
 * IMPORTANT — every built-in is seeded DISABLED. Live behaviour is UNCHANGED
 * until an admin enables a flow: the hardcoded reminder ladder still runs, and
 * the booking document actions (prepare_quote/contract/event/invoice) are still
 * stubs that record an observable `skipped` step rather than firing. The
 * cutover (drive each process through the engine + stop the hardcoded path) is a
 * deliberate follow-up so we never double-act. Enabling a flow before its
 * cutover is safe — at worst it records skipped steps — but the dunning flow in
 * particular auto-suppresses the hardcoded ladder while enabled so the two never
 * double-send.
 *
 * Idempotent: keyed on builtin_key. Once seeded, admin edits are preserved (we
 * never overwrite an enabled built-in, and re-seed a disabled one only when its
 * SEED_VERSION moves on). Self-heal pattern per [[feedback_self_heal_pattern]].
 */
const { getAppSetting } = require('../utils/appSettings');

const DUNNING_KEY = 'invoice_dunning';

function buildDunningGraph({ firstDays, gapDays, maxReminders }) {
  // Delegation model: the payment-check email IS the admin gate (it drives the
  // existing confirm + reminder_level + Mahngebühr state machine), so the flow
  // just decides WHEN to fire it. After due date + grace, loop up to
  // maxReminders times: if still unpaid, queue a payment-check, wait the gap,
  // repeat; stop early once paid. After the loop exhausts → collections handoff.
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 240, pos_y: 0 },
    { node_key: 'waitDue', type: 'wait', config: { untilVar: 'dueDate' }, pos_x: 240, pos_y: 110 },
    // Anchor the grace period to the invoice's due date (dueDate + firstDays),
    // not "now + firstDays" — so an already-overdue invoice enrolled via backfill
    // duns on its real timeline instead of restarting a fresh grace clock (#750).
    { node_key: 'waitGrace', type: 'wait', config: { untilVar: 'dueDate', delayDays: firstDays }, pos_x: 240, pos_y: 220 },
    { node_key: 'loop', type: 'loop', config: { maxIterations: maxReminders }, pos_x: 240, pos_y: 330 },
    { node_key: 'checkPaid', type: 'condition', config: { condition: 'invoice_paid' }, pos_x: 240, pos_y: 440 },
    { node_key: 'paymentCheck', type: 'action', config: { action: 'queue_payment_check' }, pos_x: 240, pos_y: 550 },
    { node_key: 'waitGap', type: 'wait', config: { delayDays: gapDays }, pos_x: 240, pos_y: 660 },
    { node_key: 'donePaid', type: 'action', config: { action: 'noop' }, pos_x: 520, pos_y: 440 },
    { node_key: 'collections', type: 'action', config: { action: 'escalate_to_collections' }, pos_x: 520, pos_y: 250 },
    { node_key: 'doneEnd', type: 'action', config: { action: 'noop' }, pos_x: 760, pos_y: 250 },
  ];
  const edges = [
    { from_node: 't', to_node: 'waitDue' },
    { from_node: 'waitDue', to_node: 'waitGrace' },
    { from_node: 'waitGrace', to_node: 'loop' },
    { from_node: 'loop', from_handle: 'loop', to_node: 'checkPaid' },
    { from_node: 'loop', from_handle: 'exit', to_node: 'collections' },
    { from_node: 'collections', to_node: 'doneEnd' },
    { from_node: 'checkPaid', from_handle: 'yes', to_node: 'donePaid' },
    { from_node: 'checkPaid', from_handle: 'no', to_node: 'paymentCheck' },
    { from_node: 'paymentCheck', to_node: 'waitGap' },
    { from_node: 'waitGap', to_node: 'loop', loop_back: true },
  ];
  return { nodes, edges };
}

// Booking — quote accepted → prepare contract → ADMIN REVIEW GATE → send
// contract → admin gate "signed?" → create the event/gallery → wait to the
// event date → prepare invoice → ADMIN REVIEW GATE → send invoice.
//
// A document is never sent without an explicit admin OK: prepare_* creates a
// DRAFT, the admin adjusts line items / terms in the CRM, then confirms the
// review gate, and only then does send_document fire. The "signed?" gate models
// the external signing step (no e-sign webhook yet). The document actions are
// stubs until the booking cutover, so an enabled run records observable skipped
// steps rather than acting.
function buildBookingFullGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 320, pos_y: 0 },
    { node_key: 'prepContract', type: 'action', config: { action: 'prepare_contract' }, pos_x: 320, pos_y: 110 },
    { node_key: 'reviewContract', type: 'gate', config: { label: 'Review contract before sending' }, pos_x: 320, pos_y: 220 },
    { node_key: 'sendContract', type: 'action', config: { action: 'send_document', document: 'contract', recipient: 'customer' }, pos_x: 320, pos_y: 330 },
    { node_key: 'gateSigned', type: 'gate', config: { label: 'Contract signed?' }, pos_x: 320, pos_y: 440 },
    { node_key: 'prepEvent', type: 'action', config: { action: 'prepare_event' }, pos_x: 320, pos_y: 550 },
    { node_key: 'prepInvoice', type: 'action', config: { action: 'prepare_invoice' }, pos_x: 320, pos_y: 660 },
    { node_key: 'reviewInvoice', type: 'gate', config: { label: 'Review invoice (early — dispatch waits for the event)' }, pos_x: 320, pos_y: 770 },
    { node_key: 'waitEvent', type: 'wait', config: { untilVar: 'eventDate' }, pos_x: 320, pos_y: 880 },
    { node_key: 'sendInvoice', type: 'action', config: { action: 'send_document', document: 'invoice', recipient: 'customer' }, pos_x: 320, pos_y: 990 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 320, pos_y: 1100 },
    { node_key: 'cancelContract', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 220 },
    { node_key: 'declined', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 440 },
    { node_key: 'cancelInvoice', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 770 },
  ];
  const edges = [
    { from_node: 't', to_node: 'prepContract' },
    { from_node: 'prepContract', to_node: 'reviewContract' },
    { from_node: 'reviewContract', from_handle: 'confirm', to_node: 'sendContract' },
    { from_node: 'reviewContract', from_handle: 'deny', to_node: 'cancelContract' },
    { from_node: 'sendContract', to_node: 'gateSigned' },
    { from_node: 'gateSigned', from_handle: 'confirm', to_node: 'prepEvent' },
    { from_node: 'gateSigned', from_handle: 'deny', to_node: 'declined' },
    // Prepare + approve the invoice EARLY (admin can adjust line items now);
    // then the wait holds dispatch until the event date, and it sends itself.
    { from_node: 'prepEvent', to_node: 'prepInvoice' },
    { from_node: 'prepInvoice', to_node: 'reviewInvoice' },
    { from_node: 'reviewInvoice', from_handle: 'confirm', to_node: 'waitEvent' },
    { from_node: 'reviewInvoice', from_handle: 'deny', to_node: 'cancelInvoice' },
    { from_node: 'waitEvent', to_node: 'sendInvoice' },
    { from_node: 'sendInvoice', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Booking — quote accepted → create the event/gallery → wait to the event date
// → prepare invoice → ADMIN REVIEW GATE → send invoice. The no-contract path
// (e.g. small shoots). Same review-before-send rule and stub caveat as the full
// booking flow.
function buildBookingSimpleGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 320, pos_y: 0 },
    { node_key: 'prepEvent', type: 'action', config: { action: 'prepare_event' }, pos_x: 320, pos_y: 110 },
    { node_key: 'prepInvoice', type: 'action', config: { action: 'prepare_invoice' }, pos_x: 320, pos_y: 220 },
    { node_key: 'reviewInvoice', type: 'gate', config: { label: 'Review invoice (early — dispatch waits for the event)' }, pos_x: 320, pos_y: 330 },
    { node_key: 'waitEvent', type: 'wait', config: { untilVar: 'eventDate' }, pos_x: 320, pos_y: 440 },
    { node_key: 'sendInvoice', type: 'action', config: { action: 'send_document', document: 'invoice', recipient: 'customer' }, pos_x: 320, pos_y: 550 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 320, pos_y: 660 },
    { node_key: 'cancelInvoice', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 330 },
  ];
  const edges = [
    { from_node: 't', to_node: 'prepEvent' },
    // Prepare + approve the invoice early; the wait holds dispatch to the event date.
    { from_node: 'prepEvent', to_node: 'prepInvoice' },
    { from_node: 'prepInvoice', to_node: 'reviewInvoice' },
    { from_node: 'reviewInvoice', from_handle: 'confirm', to_node: 'waitEvent' },
    { from_node: 'reviewInvoice', from_handle: 'deny', to_node: 'cancelInvoice' },
    { from_node: 'waitEvent', to_node: 'sendInvoice' },
    { from_node: 'sendInvoice', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Booking — quote accepted → prepare invoice → admin review gate → send. No
// event/gallery and no wait: the invoice goes out as soon as the admin approves
// it. For shoots billed without a delivered online gallery. Same stub caveat as
// the other booking flows (prepare_invoice/send_document not yet wired).
function buildBookingInvoiceOnlyGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 320, pos_y: 0 },
    { node_key: 'prepInvoice', type: 'action', config: { action: 'prepare_invoice' }, pos_x: 320, pos_y: 110 },
    { node_key: 'reviewInvoice', type: 'gate', config: { label: 'Review invoice before sending' }, pos_x: 320, pos_y: 220 },
    { node_key: 'sendInvoice', type: 'action', config: { action: 'send_document', document: 'invoice', recipient: 'customer' }, pos_x: 320, pos_y: 330 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 320, pos_y: 440 },
    { node_key: 'cancelInvoice', type: 'action', config: { action: 'noop' }, pos_x: 620, pos_y: 220 },
  ];
  const edges = [
    { from_node: 't', to_node: 'prepInvoice' },
    { from_node: 'prepInvoice', to_node: 'reviewInvoice' },
    { from_node: 'reviewInvoice', from_handle: 'confirm', to_node: 'sendInvoice' },
    { from_node: 'reviewInvoice', from_handle: 'deny', to_node: 'cancelInvoice' },
    { from_node: 'sendInvoice', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Pre-event reminder — fired by the scheduler at event_date − daysBefore (see
// emitDueEventReminders). The notify_pre_event action DELEGATES to
// eventReminderService.sendReminderForEvent, so the email is byte-identical to
// the legacy pass (per-type template, per-event override, sent_at idempotency).
// This is the live replacement for that pass (mutual-exclusion guard there).
function buildPreEventEmailGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 240, pos_y: 0 },
    { node_key: 'notify', type: 'action', config: { action: 'notify_pre_event', templateGroup: 'event_reminder' }, pos_x: 240, pos_y: 110 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 240, pos_y: 220 },
  ];
  const edges = [
    { from_node: 't', to_node: 'notify' },
    { from_node: 'notify', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Gallery expiring — fired by the expiration checker `daysBefore` expiry. The
// notify_gallery_expiring action delegates to the checker's queueExpirationWarning
// so the warning email is identical. Live replacement for the legacy warning
// email (mutual-exclusion guard in the checker).
function buildGalleryExpiringGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 240, pos_y: 0 },
    { node_key: 'notify', type: 'action', config: { action: 'notify_gallery_expiring' }, pos_x: 240, pos_y: 110 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 240, pos_y: 220 },
  ];
  const edges = [
    { from_node: 't', to_node: 'notify' },
    { from_node: 'notify', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Gallery expired — fired when a gallery passes its expiry. The
// notify_gallery_expired action delegates to the checker's sendGalleryExpiredEmails.
// Live replacement for the legacy expired email (mutual-exclusion guard in the checker).
function buildGalleryExpiredGraph() {
  const nodes = [
    { node_key: 't', type: 'trigger', config: {}, pos_x: 240, pos_y: 0 },
    { node_key: 'notify', type: 'action', config: { action: 'notify_gallery_expired' }, pos_x: 240, pos_y: 110 },
    { node_key: 'done', type: 'action', config: { action: 'noop' }, pos_x: 240, pos_y: 220 },
  ];
  const edges = [
    { from_node: 't', to_node: 'notify' },
    { from_node: 'notify', to_node: 'done' },
  ];
  return { nodes, edges };
}

// Built-in registry. `version` is the SEED_VERSION — bump when a graph changes
// (or to re-assert the default `enabled` state) so a never-admin-touched copy is
// re-seeded on boot. `enabled` is the seed default.
//
// FIRST-BETA POSTURE (review feedback): all built-ins ship DISABLED. The legacy
// hardcoded paths keep running by default (the mutual-exclusion guards are
// enabled-based, so they only stand down once the admin ENABLES the matching
// built-in — a deliberate, per-install cutover). Enabling reverts to legacy.
// Once the prefetch-safe approval interstitial has soaked in beta, flip the
// three notification built-ins back to enabled-by-default in a follow-up.
//   invoice_dunning v6 = ship disabled (was v5 enabled-by-default).
const BUILTINS = [
  {
    key: DUNNING_KEY,
    version: 7,
    enabled: false,
    name: 'Invoice dunning (built-in)',
    trigger_type: 'invoice.sent',
    trigger_config: {},
    description:
      'Drives overdue dunning through the engine: wait to the due date, then up to '
      + 'three payment-check cycles. Each cycle fires the existing admin confirm-payment '
      + 'email (the gate), which applies reminders + Mahngebühr via the proven payment-check '
      + 'flow; after the cycles exhaust it hands the case to collections. DISABLED by default — '
      + 'the hardcoded reminder ladder keeps running until you enable this; enabling cuts over to '
      + 'the engine (the ladder then stands down so the two never double-send), disabling reverts.',
    build: async () => {
      const firstDays = Number(await getAppSetting('crm_invoices_reminder_first_days')) || 14;
      const secondDays = Number(await getAppSetting('crm_invoices_reminder_second_days')) || 30;
      const gapDays = Math.max(1, secondDays - firstDays);
      return buildDunningGraph({ firstDays, gapDays, maxReminders: 3 });
    },
  },
  {
    key: 'gallery_expiring',
    version: 2,
    enabled: false,
    name: 'Gallery expiring (built-in)',
    trigger_type: 'gallery.expiring',
    trigger_config: {},
    description:
      'When a gallery is approaching its expiry date, email the customer the expiration warning. '
      + 'DISABLED by default; the hourly expiration checker keeps sending the warning until you '
      + 'enable this, which delegates to the identical email and stands the legacy send down. '
      + 'Edit or extend it here (e.g. add a final-download nudge).',
    build: async () => buildGalleryExpiringGraph(),
  },
  {
    key: 'gallery_expired',
    version: 2,
    enabled: false,
    name: 'Gallery expired (built-in)',
    trigger_type: 'gallery.expired',
    trigger_config: {},
    description:
      'When a gallery passes its expiry, email the customer (and admin) that it has expired. '
      + 'DISABLED by default; the expiration checker keeps sending it until you enable this, which '
      + 'delegates to the identical email and stands the legacy send down. The gallery is still '
      + 'archived automatically regardless of this flow.',
    build: async () => buildGalleryExpiredGraph(),
  },
  {
    key: 'pre_event_email',
    version: 4,
    enabled: false,
    name: 'Pre-event reminder (built-in)',
    trigger_type: 'event.date_approaching',
    // daysBefore seeds the scheduler emitter from the current global setting so
    // enabling preserves timing; per-event offset overrides still win.
    trigger_config: async () => {
      const d = Number(await getAppSetting('crm_event_reminders_days_before'));
      return { daysBefore: Number.isFinite(d) && d >= 0 ? d : 2 };
    },
    description:
      'A few days before the event date, send the customer the pre-event reminder. DISABLED by '
      + 'default; the legacy reminder pass keeps running until you enable this, which delegates to '
      + 'the proven reminder logic (per-type template, per-event override, send-once) and stands '
      + 'the legacy pass down. Lead time = daysBefore in the trigger config (seeded from your old '
      + 'global setting); per-event overrides on the event page still apply.',
    build: async () => buildPreEventEmailGraph(),
  },
  {
    key: 'booking_full',
    version: 3,
    enabled: false,
    name: 'Booking — quote → contract → event → invoice (built-in)',
    trigger_type: 'quote.accepted',
    trigger_config: {},
    description:
      'On quote acceptance: prepare the contract, let the admin review it (adjust line items / '
      + 'terms) and confirm before it is sent, wait for the admin to confirm it is signed, then '
      + 'create the event/gallery and prepare the invoice EARLY so the admin can adjust it. The '
      + 'admin approves the invoice at the review gate whenever they like; dispatch then waits '
      + 'until the event date and sends itself. No document is sent without an explicit admin OK. '
      + 'Disabled by default — the document actions are stubs until the booking cutover, so an '
      + 'enabled run just records observable skipped steps. A starting point to edit.',
    build: async () => buildBookingFullGraph(),
  },
  {
    key: 'booking_simple',
    version: 3,
    enabled: false,
    name: 'Booking — quote → event → invoice (built-in)',
    trigger_type: 'quote.accepted',
    trigger_config: {},
    description:
      'The no-contract booking path: on quote acceptance create the event/gallery and prepare the '
      + 'invoice early. The admin approves it at the review gate ahead of time; dispatch then waits '
      + 'until the event date and sends itself. Same review-before-send rule and stub caveat as the '
      + 'full booking flow; disabled by default.',
    build: async () => buildBookingSimpleGraph(),
  },
  {
    key: 'booking_invoice_only',
    version: 1,
    enabled: false,
    name: 'Booking — quote → invoice, no gallery (built-in)',
    trigger_type: 'quote.accepted',
    trigger_config: {},
    description:
      'For shoots billed without an online gallery: on quote acceptance prepare the invoice, the '
      + 'admin reviews + approves it, and it is sent right away (no event/gallery, no wait). Pick '
      + 'this flow per quote via the booking-workflow selector. Same review-before-send rule and '
      + 'stub caveat as the other booking flows; disabled by default.',
    build: async () => buildBookingInvoiceOnlyGraph(),
  },
];

let booted = false;

function parseSeedConfig(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

async function writeGraph(trx, workflowId, version, nodes, edges) {
  for (const n of nodes) {
    await trx('workflow_nodes').insert({
      workflow_id: workflowId, version, node_key: n.node_key, type: n.type,
      config: JSON.stringify(n.config || {}), pos_x: n.pos_x || 0, pos_y: n.pos_y || 0,
    });
  }
  for (const e of edges) {
    await trx('workflow_edges').insert({
      workflow_id: workflowId, version, from_node: e.from_node, from_handle: e.from_handle || null,
      to_node: e.to_node, label: e.label || null, loop_back: !!e.loop_back,
    });
  }
}

async function seedOneBuiltin(db, logger, def) {
  const { nodes, edges } = await def.build();
  const baseCfg = typeof def.trigger_config === 'function'
    ? (await def.trigger_config()) || {}
    : (def.trigger_config || {});
  const triggerConfig = { ...baseCfg, seedVersion: def.version };
  const defEnabled = def.enabled === true;

  const existing = await db('workflows').where({ builtin_key: def.key }).first();

  if (existing) {
    // Never touch a built-in the admin has taken ownership of (enabled/disabled
    // or edited it) — admin_toggled_at is the sentinel (migration 148). For a
    // never-touched copy, re-seed on a SEED_VERSION bump and (re-)apply the seed
    // default `enabled`, so a shipped default flip (e.g. enabled→disabled for
    // first beta) propagates to installs the admin hasn't customised.
    const storedVersion = Number(parseSeedConfig(existing.trigger_config).seedVersion) || 0;
    const adminOwned = !!existing.admin_toggled_at;
    if (adminOwned || storedVersion >= def.version) return;

    const newVersion = (existing.version || 1) + 1;
    await db.transaction(async (trx) => {
      await trx('workflows').where({ id: existing.id }).update({
        name: def.name,
        description: def.description,
        trigger_type: def.trigger_type,
        trigger_config: JSON.stringify(triggerConfig),
        enabled: defEnabled,
        version: newVersion,
        updated_at: trx.fn.now(),
      });
      await writeGraph(trx, existing.id, newVersion, nodes, edges);
    });
    logger?.info?.(`Re-seeded built-in workflow: ${def.key} (v${def.version}, enabled=${defEnabled})`);
    return;
  }

  await db.transaction(async (trx) => {
    const ins = await trx('workflows').insert({
      name: def.name,
      description: def.description,
      enabled: defEnabled,
      version: 1,
      trigger_type: def.trigger_type,
      trigger_config: JSON.stringify(triggerConfig),
      is_builtin: true,
      builtin_key: def.key,
    }).returning('id');
    // Postgres returns [] without `.returning`, so ins[0] would be undefined and
    // the child node inserts would roll back on NOT NULL. Normalise the {id}
    // (pg) vs bare-id (sqlite) shapes.
    const workflowId = ins[0]?.id ?? ins[0];
    await writeGraph(trx, workflowId, 1, nodes, edges);
  });
  logger?.info?.(`Seeded built-in workflow: ${def.key} (enabled=${defEnabled})`);
}

async function seedBuiltinWorkflowsAtBoot(db, logger) {
  try {
    if (!(await db.schema.hasTable('workflows'))) return;
    for (const def of BUILTINS) {
      try {
        await seedOneBuiltin(db, logger, def);
      } catch (err) {
        logger?.warn?.(`Built-in workflow seed failed for ${def.key}:`, err.message);
      }
    }
    booted = true;
  } catch (err) {
    logger?.warn?.('Built-in workflow seed failed at boot:', err.message);
  }
}

module.exports = { seedBuiltinWorkflowsAtBoot, buildDunningGraph, DUNNING_KEY, BUILTINS };
