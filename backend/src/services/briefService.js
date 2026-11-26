'use strict';

/**
 * Project briefs (issue 2678, migration 376): the agreed details of a job,
 * filled in by the studio and shown to the customer.
 *
 * A brief hangs on a project or, for a job without one, on a customer. Its
 * fields come from two templates: the global one, then the one of its
 * occasion (the project's event type, or the one picked on a customer
 * brief). Values are stored per brief, so editing a template never rewrites
 * a brief; a value whose field left the template stays readable for the
 * studio ("removed") and is never shown to the customer.
 *
 * The customer sees nothing until the studio sends an update (notify): that
 * stores the customer-visible state as the brief's snapshot, which the portal
 * shows, and mails what changed since the previous one. Every customer-facing
 * read goes through the snapshot, which holds only visible fields and the
 * shared arrangements, never hidden fields or internal notes.
 */

const { db, logActivity } = require('../database/db');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const { isUniqueViolation } = require('../utils/dbErrors');
const { isTrue } = require('../utils/galleryLifecycle');
const { formatBoolean } = require('../utils/dbCompat');
const { escapeHtml } = require('../utils/formatters');
const { formatDate } = require('../utils/dateFormatter');
const { adminActivityActor } = require('../utils/activityActor');
const { toDateOnly } = require('../utils/dateOnly');
const logger = require('../utils/logger');
const { orPaidAwaitingDelivery } = require('./invoice/helpers');
const projectService = require('./projectService');

const FIELD_TYPES = [
  'short_text', 'long_text', 'date', 'time', 'datetime', 'place', 'place_time', 'number', 'yes_no',
  'project_date', 'project_location', 'project_guests',
];
// On a project brief these show the project's own column (edited in the
// project data, never in the brief); on a customer brief they are ordinary
// values of the matching shape.
const PROJECT_COLUMN = { project_date: 'eventDate', project_location: 'location', project_guests: 'guestCount' };

const MAX_FIELDS = 50;
const MAX_LABEL = 120;
const MAX_VALUES_PER_SAVE = 200;
const MAX_SHARED = 10000;
const TEXT_MAX = { short_text: 500, long_text: 5000, project_location: 255 };
const PLACE_MAX = 255;
const ADDRESS_MAX = 500;

// The few words of the update mail that are not a label or a value. Their
// keys are the shipped languages, which label translations are limited to.
const TEXT = {
  en: { yes: 'Yes', no: 'No', added: 'added', removed: 'removed', shared: 'Shared arrangements' },
  de: { yes: 'Ja', no: 'Nein', added: 'neu', removed: 'entfernt', shared: 'Gemeinsame Vereinbarungen' },
  es: { yes: 'Sí', no: 'No', added: 'nuevo', removed: 'eliminado', shared: 'Acuerdos compartidos' },
  fr: { yes: 'Oui', no: 'Non', added: 'nouveau', removed: 'supprimé', shared: 'Accords communs' },
  nl: { yes: 'Ja', no: 'Nee', added: 'nieuw', removed: 'verwijderd', shared: 'Gedeelde afspraken' },
  pt: { yes: 'Sim', no: 'Não', added: 'novo', removed: 'removido', shared: 'Combinados partilhados' },
  ru: { yes: 'Да', no: 'Нет', added: 'новое', removed: 'удалено', shared: 'Общие договорённости' },
  sl: { yes: 'Da', no: 'Ne', added: 'novo', removed: 'odstranjeno', shared: 'Skupni dogovori' },
};
const LANGUAGES = Object.keys(TEXT);

const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
const now = () => new Date().toISOString();

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function text(raw, max) {
  if (typeof raw !== 'string') throw new Error('not text');
  const value = raw.trim();
  if (value.length > max) throw new Error('too long');
  return value;
}

/**
 * The stored shape of a value of `type`, or null for an empty one. Throws a
 * ValidationError naming the field when the input does not fit the type.
 */
function normalizeValue(type, raw, label) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    switch (type) {
    case 'short_text':
    case 'long_text':
    case 'project_location':
      return text(raw, TEXT_MAX[type]) || null;
    case 'date':
    case 'project_date':
      if (!isDate(raw)) throw new Error('not a date');
      return raw;
    case 'time':
      if (typeof raw !== 'string' || !TIME_RE.test(raw)) throw new Error('not a time');
      return raw;
    case 'datetime': {
      const [day, time, extra] = typeof raw === 'string' ? raw.split('T') : [];
      if (extra !== undefined || !isDate(day) || !TIME_RE.test(time || '')) throw new Error('not a date and time');
      return raw;
    }
    case 'place':
    case 'place_time': {
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a place');
      const place = text(raw.place ?? '', PLACE_MAX);
      const address = text(raw.address ?? '', ADDRESS_MAX);
      const out = { place, address };
      if (type === 'place_time') {
        const time = raw.time ?? '';
        if (time !== '' && (typeof time !== 'string' || !TIME_RE.test(time))) throw new Error('not a time');
        out.time = time;
      }
      return Object.values(out).some(Boolean) ? out : null;
    }
    case 'number':
    case 'project_guests': {
      const n = typeof raw === 'number' ? raw : Number.NaN;
      const ok = type === 'project_guests'
        ? Number.isInteger(n) && n >= 0 && n <= 100000
        : Number.isFinite(n) && Math.abs(n) <= 1e12;
      if (!ok) throw new Error('not a number');
      return n;
    }
    case 'yes_no':
      if (typeof raw !== 'boolean') throw new Error('not yes or no');
      return raw;
    default:
      throw new Error('unknown type');
    }
  } catch (_) {
    throw new ValidationError(`Invalid value for "${label}"`);
  }
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function shapeField(row) {
  return {
    id: Number(row.id),
    label: row.label,
    labels: parseJson(row.label_translations, {}),
    type: row.field_type,
    visibleDefault: isTrue(row.visible_default),
  };
}

async function occasionExists(occasion) {
  return !!(await db('event_types').where({ slug_prefix: occasion }).first('id'));
}

/** Every template: the global list and one per occasion, in their order. */
async function listTemplates() {
  const rows = await db('project_brief_fields').orderBy('position').orderBy('id');
  const out = { global: [], occasions: {} };
  for (const row of rows) {
    if (row.occasion == null) out.global.push(shapeField(row));
    else (out.occasions[row.occasion] = out.occasions[row.occasion] || []).push(shapeField(row));
  }
  return out;
}

function cleanTranslations(raw, index) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`Field ${index + 1}: invalid translations`);
  const out = {};
  for (const [language, label] of Object.entries(raw)) {
    if (!LANGUAGES.includes(language)) throw new ValidationError(`Field ${index + 1}: unknown language ${language}`);
    if (typeof label !== 'string' || label.trim().length > MAX_LABEL) throw new ValidationError(`Field ${index + 1}: invalid ${language} label`);
    if (label.trim()) out[language] = label.trim();
  }
  return out;
}

/**
 * Replace the field list of one template (`occasion` null = global) with
 * `fields`, in that order. An entry with the id of one of this template's
 * fields updates it (its type stays: stored values have its shape); one
 * without an id is new; a field missing from the list is removed (values
 * already stored keep it readable on their briefs).
 */
async function saveTemplate(occasion, fields) {
  if (occasion != null && !(await occasionExists(occasion))) throw new NotFoundError('Occasion', occasion);
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS) {
    throw new ValidationError(`A template holds at most ${MAX_FIELDS} fields`);
  }
  const scope = (q) => (occasion == null ? q.whereNull('occasion') : q.where({ occasion }));
  const existing = new Map((await scope(db('project_brief_fields'))).map((row) => [Number(row.id), row]));
  const seen = new Set();
  const rows = fields.map((field, index) => {
    if (!field || typeof field !== 'object') throw new ValidationError(`Field ${index + 1} is invalid`);
    const label = typeof field.label === 'string' ? field.label.trim() : '';
    if (!label || label.length > MAX_LABEL) throw new ValidationError(`Field ${index + 1} needs a label of at most ${MAX_LABEL} characters`);
    const id = field.id == null ? null : Number(field.id);
    if (id != null) {
      const stored = existing.get(id);
      if (!stored || seen.has(id)) throw new ValidationError(`Field ${index + 1} is not part of this template`);
      if (field.type !== undefined && field.type !== stored.field_type) {
        throw new ValidationError(`The type of "${stored.label}" cannot change; remove the field and add a new one`);
      }
      seen.add(id);
    } else if (!FIELD_TYPES.includes(field.type)) {
      throw new ValidationError(`Field ${index + 1} has an unknown type`);
    }
    return {
      id,
      label,
      label_translations: JSON.stringify(cleanTranslations(field.labels, index)),
      field_type: id != null ? existing.get(id).field_type : field.type,
      visible_default: formatBoolean(field.visibleDefault !== false),
      position: index,
    };
  });

  await db.transaction(async (trx) => {
    const removed = [...existing.keys()].filter((id) => !seen.has(id));
    if (removed.length) await trx('project_brief_fields').whereIn('id', removed).del();
    for (const { id, ...row } of rows) {
      if (id != null) {
        await trx('project_brief_fields').where({ id }).update({ ...row, updated_at: now() });
      } else {
        await trx('project_brief_fields').insert({ ...row, occasion, created_at: now(), updated_at: now() });
      }
    }
  });
  const templates = await listTemplates();
  return occasion == null ? templates.global : (templates.occasions[occasion] || []);
}

/** The fields a brief of `occasion` shows: global first, then the occasion's.
 *  A project field type appears once, where it comes first. */
async function fieldsFor(occasion) {
  const rows = await db('project_brief_fields')
    .where((q) => {
      q.whereNull('occasion');
      if (occasion) q.orWhere({ occasion });
    })
    .orderBy('position').orderBy('id');
  const ordered = [
    ...rows.filter((r) => r.occasion == null).map((r) => ({ ...shapeField(r), source: 'global' })),
    ...rows.filter((r) => r.occasion != null).map((r) => ({ ...shapeField(r), source: 'occasion' })),
  ];
  const projectTypes = new Set();
  return ordered.filter((field) => {
    if (!PROJECT_COLUMN[field.type]) return true;
    if (projectTypes.has(field.type)) return false;
    projectTypes.add(field.type);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

const ownerColumn = (owner) => (owner.kind === 'project' ? 'project_id' : 'customer_account_id');

/** The owner's record and the brief row (null before the first save). */
async function loadOwner(owner) {
  const brief = await db('project_briefs').where({ [ownerColumn(owner)]: owner.id }).first();
  if (owner.kind === 'project') {
    const project = await projectService.getProjectById(owner.id);
    if (!project) throw new NotFoundError('Project', owner.id);
    return { project, brief, occasion: project.eventType || null, customerId: project.customerAccountId };
  }
  const customer = await db('customer_accounts').where({ id: owner.id }).first('id');
  if (!customer) throw new NotFoundError('Customer', owner.id);
  return { project: null, brief, occasion: brief?.occasion || null, customerId: Number(customer.id) };
}

async function valueRows(brief) {
  if (!brief) return [];
  return Array.from(await db('project_brief_values').where({ brief_id: brief.id }).orderBy('id'));
}

/** The brief's fields with their values: the template's, then the removed ones. */
function assemble(fields, rows, project) {
  const byField = new Map(rows.map((row) => [Number(row.field_id), row]));
  const out = fields.map((field) => {
    const row = byField.get(field.id);
    const fromProject = !!(project && PROJECT_COLUMN[field.type]);
    return {
      ...field,
      value: fromProject ? (project[PROJECT_COLUMN[field.type]] ?? null) : parseJson(row?.value, null),
      visible: row?.visible == null ? null : isTrue(row.visible),
      fromProject,
    };
  });
  const inTemplate = new Set(fields.map((f) => f.id));
  for (const row of rows) {
    if (inTemplate.has(Number(row.field_id))) continue;
    out.push({
      id: Number(row.field_id), label: row.label, labels: {}, type: row.field_type, visibleDefault: false,
      source: 'removed', value: parseJson(row.value, null), visible: null, fromProject: false,
    });
  }
  return out;
}

/** What the customer may see of the brief right now. */
function visibleState(fields, sharedArrangements) {
  return {
    fields: fields
      .filter((f) => f.source !== 'removed' && (f.visible ?? f.visibleDefault) && f.value != null)
      .map((f) => ({ id: f.id, label: f.label, labels: f.labels, type: f.type, value: f.value })),
    sharedArrangements: sharedArrangements || '',
  };
}

/** What changed for the customer between two visible states. */
function diffStates(before, after) {
  const prev = new Map((before?.fields || []).map((f) => [f.id, f]));
  const next = new Map(after.fields.map((f) => [f.id, f]));
  const changes = [];
  for (const field of after.fields) {
    const old = prev.get(field.id);
    if (!old) changes.push({ field, change: 'added', before: null, after: field.value });
    else if (!sameValue(old.value, field.value)) changes.push({ field, change: 'changed', before: old.value, after: field.value });
  }
  for (const old of before?.fields || []) {
    if (!next.has(old.id)) changes.push({ field: old, change: 'removed', before: old.value, after: null });
  }
  const oldShared = before?.sharedArrangements || '';
  if (oldShared !== after.sharedArrangements) {
    const change = !oldShared ? 'added' : (!after.sharedArrangements ? 'removed' : 'changed');
    changes.push({ field: null, change, before: oldShared || null, after: after.sharedArrangements || null });
  }
  return changes;
}

async function current(owner) {
  const ctx = await loadOwner(owner);
  const fields = assemble(await fieldsFor(ctx.occasion), await valueRows(ctx.brief), ctx.project);
  const sharedArrangements = ctx.brief?.shared_arrangements || '';
  // What was sent counts only for the customer it was sent to: a project that
  // changed customer starts unsent for the new one.
  const sentTo = ctx.brief?.notified_customer_account_id;
  const snapshot = sentTo != null && Number(sentTo) === ctx.customerId ? parseJson(ctx.brief.notified_snapshot, null) : null;
  return { ...ctx, fields, sharedArrangements, snapshot, state: visibleState(fields, sharedArrangements) };
}

/** The brief as the studio edits it. */
async function getBrief(owner) {
  const { fields, sharedArrangements, snapshot, state, brief, occasion, customerId } = await current(owner);
  return {
    occasion,
    fields,
    sharedArrangements,
    notifiedAt: brief?.notified_at || null,
    // Labels only: the cockpit says how many changes wait and which fields.
    pendingChanges: diffStates(snapshot, state).map(({ field, change }) => ({
      fieldId: field ? field.id : null, label: field ? field.label : null, labels: field ? field.labels : {}, change,
    })),
    hasCustomer: customerId != null,
  };
}

async function ensureBrief(trx, owner) {
  const column = ownerColumn(owner);
  const found = await trx('project_briefs').where({ [column]: owner.id }).first();
  if (found) return found;
  try {
    const id = idOf(await trx('project_briefs').insert({ [column]: owner.id, created_at: now(), updated_at: now() }).returning('id'));
    return trx('project_briefs').where({ id }).first();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return trx('project_briefs').where({ [column]: owner.id }).first();
  }
}

/**
 * Save what the studio changed. `values` maps a field id to `{ value }`
 * and/or `{ visible }` (true, false, or null for the template's default);
 * a value of null clears it, the only change a removed field takes.
 * `occasion` is a customer brief's own choice (null for none).
 */
async function saveBrief(owner, { values = {}, sharedArrangements, occasion } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ValidationError('Invalid values');
  const entries = Object.entries(values);
  if (entries.length > MAX_VALUES_PER_SAVE) throw new ValidationError('Too many values in one save');
  if (sharedArrangements != null && (typeof sharedArrangements !== 'string' || sharedArrangements.length > MAX_SHARED)) {
    throw new ValidationError(`Shared arrangements take at most ${MAX_SHARED} characters`);
  }
  if (occasion !== undefined) {
    if (owner.kind !== 'customer') throw new ValidationError('A project brief takes its occasion from the project');
    if (occasion !== null && (typeof occasion !== 'string' || !(await occasionExists(occasion)))) {
      throw new NotFoundError('Occasion', occasion);
    }
  }

  const ctx = await loadOwner(owner);
  const nextOccasion = occasion !== undefined ? occasion : ctx.occasion;
  const fields = await fieldsFor(nextOccasion);
  const rows = await valueRows(ctx.brief);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const rowsById = new Map(rows.map((r) => [Number(r.field_id), r]));

  const writes = entries.map(([key, change]) => {
    const id = Number(key);
    const field = fieldsById.get(id);
    const row = rowsById.get(id);
    if (!change || typeof change !== 'object' || (!field && !row)) throw new ValidationError(`Unknown field ${key}`);
    if (!field) {
      // A removed field: its value can only be cleared.
      if (change.value !== null || 'visible' in change) throw new ValidationError(`"${row.label}" is no longer in the template; it can only be cleared`);
      return { id, remove: true };
    }
    const out = { id, field };
    if ('value' in change) {
      if (ctx.project && PROJECT_COLUMN[field.type]) {
        throw new ValidationError(`"${field.label}" is edited in the project data`);
      }
      out.value = normalizeValue(field.type, change.value, field.label);
    }
    if ('visible' in change) {
      if (change.visible !== null && typeof change.visible !== 'boolean') throw new ValidationError(`Invalid visibility for "${field.label}"`);
      out.visible = change.visible;
    }
    return out;
  });

  await db.transaction(async (trx) => {
    const brief = await ensureBrief(trx, owner);
    const briefPatch = { updated_at: now() };
    if (sharedArrangements !== undefined) briefPatch.shared_arrangements = (sharedArrangements || '').trim() || null;
    if (occasion !== undefined) briefPatch.occasion = occasion;
    await trx('project_briefs').where({ id: brief.id }).update(briefPatch);
    for (const write of writes) {
      const where = { brief_id: brief.id, field_id: write.id };
      if (write.remove) {
        await trx('project_brief_values').where(where).del();
        continue;
      }
      const stored = await trx('project_brief_values').where(where).first();
      const patch = { label: write.field.label, field_type: write.field.type, updated_at: now() };
      if ('value' in write) patch.value = write.value == null ? null : JSON.stringify(write.value);
      if ('visible' in write) patch.visible = write.visible == null ? null : formatBoolean(write.visible);
      if (stored) await trx('project_brief_values').where({ id: stored.id }).update(patch);
      else await trx('project_brief_values').insert({ ...where, value: null, visible: null, ...patch });
    }
    // A row that holds neither a value nor an override says nothing.
    await trx('project_brief_values').where({ brief_id: brief.id }).whereNull('value').whereNull('visible').del();
  });
  return getBrief(owner);
}

// ---------------------------------------------------------------------------
// The update mail
// ---------------------------------------------------------------------------

const labelIn = (field, language) => (field.labels && field.labels[language]) || field.label;

async function displayValue(type, value, language) {
  if (value == null) return '';
  const words = TEXT[language] || TEXT.en;
  switch (type) {
  case 'date':
  case 'project_date':
    return formatDate(value, language);
  case 'datetime': {
    const [day, time] = value.split('T');
    return `${await formatDate(day, language)} ${time}`;
  }
  case 'place':
    return [value.place, value.address].filter(Boolean).join(', ');
  case 'place_time':
    return [value.time, value.place, value.address].filter(Boolean).join(', ');
  case 'yes_no':
    return value ? words.yes : words.no;
  default:
    return String(value);
  }
}

/** The change list in `language`, as HTML (every piece escaped) and text. */
async function renderChanges(changes, language) {
  const words = TEXT[language] || TEXT.en;
  const html = [];
  const lines = [];
  for (const { field, change, before, after } of changes) {
    const label = field ? labelIn(field, language) : words.shared;
    const type = field ? field.type : 'long_text';
    const from = await displayValue(type, before, language);
    const to = await displayValue(type, after, language);
    const esc = (s) => escapeHtml(s).replace(/\n/g, '<br>');
    if (change === 'added') {
      html.push(`<li><strong>${esc(label)}</strong>: ${esc(to)} <em>(${esc(words.added)})</em></li>`);
      lines.push(`- ${label}: ${to} (${words.added})`);
    } else if (change === 'removed') {
      html.push(`<li><strong>${esc(label)}</strong>: <s>${esc(from)}</s> <em>(${esc(words.removed)})</em></li>`);
      lines.push(`- ${label}: ${from} (${words.removed})`);
    } else {
      html.push(`<li><strong>${esc(label)}</strong>: <s>${esc(from)}</s> &rarr; ${esc(to)}</li>`);
      lines.push(`- ${label}: ${from} -> ${to}`);
    }
  }
  return { html: `<ul>\n${html.join('\n')}\n</ul>`, text: lines.join('\n') };
}

async function occasionName(occasion) {
  if (!occasion) return null;
  const row = await db('event_types').where({ slug_prefix: occasion }).first('name');
  return row ? row.name : null;
}

/**
 * Send the customer one update: every visible change since the last one.
 * The snapshot moves forward first, guarded on the one the changes were
 * computed from, so two clicks cannot send the same changes twice; a mail
 * that cannot be queued puts it back. A customer who takes no administrative
 * email gets no mail but the portal still shows the update, as with every
 * other notice held back for them (_adminEmailOptOut); `mail` says which.
 */
async function notify(owner, adminId) {
  const { brief: seen, project, customerId, occasion, snapshot, state } = await current(owner);
  if (customerId == null) throw new AppError('This project has no customer to notify', 422, 'BRIEF_NO_CUSTOMER');
  const changes = diffStates(snapshot, state);
  if (changes.length === 0) throw new AppError('There are no changes to send', 409, 'BRIEF_NOTHING_TO_SEND');
  // A project brief can have something to send (the project data) before
  // its first save.
  const brief = seen || await ensureBrief(db, owner);
  const sent = {
    notified_at: seen?.notified_at ?? null,
    notified_snapshot: seen?.notified_snapshot ?? null,
    notified_customer_account_id: seen?.notified_customer_account_id ?? null,
  };

  const customer = await db('customer_accounts').where({ id: customerId })
    .first('id', 'email', 'display_name', 'first_name', 'last_name', 'preferred_language', 'password_hash');
  if (!customer || !customer.email) throw new AppError('The customer has no email address', 422, 'BRIEF_NO_CUSTOMER');

  const notifiedAt = now();
  const claimed = await db('project_briefs')
    .where({ id: brief.id })
    .where((q) => {
      for (const column of ['notified_snapshot', 'notified_customer_account_id']) {
        if (sent[column] == null) q.whereNull(column); else q.where(column, sent[column]);
      }
    })
    .update({ notified_at: notifiedAt, notified_snapshot: JSON.stringify(state), notified_customer_account_id: customerId });
  if (claimed !== 1) throw new AppError('The brief changed meanwhile; reload and send again', 409, 'BRIEF_CHANGED');

  const emailProcessor = require('./emailProcessor');
  const { customerDisplayName, businessName, frontendBase } = require('./customerDocumentNotifications');
  const language = String(customer.preferred_language || await emailProcessor.getRecipientLanguage(customer.email)).slice(0, 2);
  const rendered = await renderChanges(changes, LANGUAGES.includes(language) ? language : 'en');
  let result;
  try {
    result = await emailProcessor.queueEmail(null, customer.email, 'project_brief_updated', {
      customer_name: customerDisplayName(customer),
      business_name: await businessName(),
      brief_title: project ? project.name : (await occasionName(occasion)) || '',
      brief_changes_html: rendered.html,
      brief_changes_text: rendered.text,
      // A passive customer (no password) cannot sign in to the portal.
      portal_link: customer.password_hash ? `${await frontendBase()}/customer/agreements` : '',
      __language: customer.preferred_language || undefined,
    }, { customerAccountId: customer.id });
  } catch (err) {
    logger.warn('Could not queue the brief update mail', { briefId: brief.id, error: err.message });
    result = false;
  }
  if (!result) {
    await db('project_briefs').where({ id: brief.id, notified_snapshot: JSON.stringify(state) })
      .update(sent);
    throw new AppError('The update mail could not be queued', 502, 'BRIEF_MAIL_FAILED');
  }
  const mail = result === 'suppressed' ? 'suppressed' : 'queued';
  await logActivity('project_brief_notified', {
    [owner.kind === 'project' ? 'projectId' : 'customerId']: owner.id, changes: changes.length, mail,
  }, null, adminActivityActor(adminId));
  return { notifiedAt, changes: changes.length, mail };
}

// ---------------------------------------------------------------------------
// The portal
// ---------------------------------------------------------------------------

/** The newest accepted quote of the project, as its price. */
async function projectPrice(projectId, customerId) {
  const quote = await db('quotes')
    .where({ project_id: projectId, customer_account_id: customerId })
    .whereIn('status', ['accepted', 'converted'])
    .orderBy('accepted_at', 'desc').orderBy('id', 'desc')
    .first('quote_number', 'total_amount_minor', 'currency');
  return quote ? { quoteNumber: quote.quote_number, totalMinor: Number(quote.total_amount_minor), currency: quote.currency } : null;
}

/** The first instalment of the project's split invoice, as its deposit, once
 *  the customer has it (the portal's own invoice rule). */
async function projectDeposit(projectId, customerId) {
  const invoice = await db('invoices')
    .where({ 'invoices.project_id': projectId, 'invoices.customer_account_id': customerId, 'invoices.installment_index': 1 })
    .where('invoices.installment_total', '>', 1)
    .where((q) => orPaidAwaitingDelivery(q.whereNotIn('invoices.status', ['scheduled', 'pending_delivery', 'skipped', 'cancelled'])))
    .orderBy('invoices.id', 'desc')
    .first('invoice_number', 'total_amount_minor', 'currency', 'due_date', 'status', 'paid_at');
  if (!invoice) return null;
  return {
    invoiceNumber: invoice.invoice_number,
    totalMinor: Number(invoice.total_amount_minor),
    currency: invoice.currency,
    dueDate: toDateOnly(invoice.due_date),
    paid: invoice.status === 'paid',
  };
}

/** The briefs sent to this customer that are still theirs: a project that
 *  moved to another customer takes its brief along, unsent for the new one. */
function briefsOfCustomer(customerId) {
  return db('project_briefs as b')
    .leftJoin('projects as p', 'p.id', 'b.project_id')
    .where('b.notified_customer_account_id', customerId)
    .where((q) => q.where('b.customer_account_id', customerId)
      .orWhere((viaProject) => viaProject.whereNotNull('b.project_id').where('p.customer_account_id', customerId)));
}

/** Whether the customer has a brief to look at (the portal's nav entry). */
async function customerHasAgreements(customerId) {
  return !!(await briefsOfCustomer(customerId).first('b.id'));
}

/**
 * The briefs the customer was sent, as sent: the snapshot's visible fields
 * and shared arrangements, never the live brief. Price and deposit come
 * from the project's documents, each only with the session's feature.
 */
async function listForCustomer(customerId, { quotes = false, bills = false } = {}) {
  const rows = Array.from(await briefsOfCustomer(customerId)
    .orderBy('b.notified_at', 'desc')
    .select('b.id', 'b.project_id', 'b.occasion', 'b.notified_at', 'b.notified_snapshot', 'p.name as project_name'));
  const out = [];
  for (const row of rows) {
    const snapshot = parseJson(row.notified_snapshot, { fields: [], sharedArrangements: '' });
    out.push({
      id: Number(row.id),
      title: row.project_id ? row.project_name : await occasionName(row.occasion),
      updatedAt: row.notified_at,
      fields: (snapshot.fields || []).map((f) => ({ id: f.id, label: f.label, labels: f.labels || {}, type: f.type, value: f.value })),
      sharedArrangements: snapshot.sharedArrangements || '',
      price: row.project_id && quotes ? await projectPrice(row.project_id, customerId) : null,
      deposit: row.project_id && bills ? await projectDeposit(row.project_id, customerId) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

async function deleteBriefs(trx, briefIds) {
  if (!briefIds.length) return;
  await trx('project_brief_values').whereIn('brief_id', briefIds).del();
  await trx('project_briefs').whereIn('id', briefIds).del();
}

/** With its project (SQLite runs without foreign keys, so nothing cascades). */
async function deleteForProject(trx, projectId) {
  await deleteBriefs(trx, await trx('project_briefs').where({ project_id: projectId }).pluck('id'));
}

/** Customer erasure: the customer's own brief and those of its projects. */
async function eraseForCustomer(trx, customerId) {
  const projectIds = trx('projects').where({ customer_account_id: customerId }).select('id');
  const ids = await trx('project_briefs')
    .where({ customer_account_id: customerId })
    .orWhereIn('project_id', projectIds)
    .pluck('id');
  await deleteBriefs(trx, ids);
}

module.exports = {
  listTemplates,
  saveTemplate,
  getBrief,
  saveBrief,
  notify,
  customerHasAgreements,
  listForCustomer,
  deleteForProject,
  eraseForCustomer,
};
