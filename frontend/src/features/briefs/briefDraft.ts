/**
 * A brief as an editable draft (UX.md › Saving): input-shaped values per
 * field, the visibility choices, the shared arrangements and, on a customer
 * brief, the occasion. `briefPayload` sends only what differs from the saved
 * brief; `rebaseBriefDraft` keeps the admin's edits across a refetch.
 */
import type { Brief, BriefField, BriefFieldType, BriefPlace, BriefSavePayload, BriefValue } from '../../services/briefs.service';

/** Text inputs hold strings (numbers too, so "1," can be typed); places an
 *  object; yes/no a boolean or null for "not set". */
export type BriefDraftValue = string | boolean | null | BriefPlace;

export interface BriefDraft {
  values: Record<number, BriefDraftValue>;
  visible: Record<number, boolean | null>;
  /** Removed fields whose value is to be cleared. */
  cleared: number[];
  sharedArrangements: string;
  occasion: string | null;
}

const isPlace = (type: BriefFieldType) => type === 'place' || type === 'place_time';
const isNumber = (type: BriefFieldType) => type === 'number' || type === 'project_guests';

/** The fields the brief's own inputs edit: not the project's, not removed ones. */
const editableFields = (brief: Brief): BriefField[] =>
  brief.fields.filter((f) => f.source !== 'removed' && !f.fromProject);

function draftValue(type: BriefFieldType, value: BriefValue): BriefDraftValue {
  if (isPlace(type)) {
    const place = (value as BriefPlace | null) || { place: '', address: '' };
    return { place: place.place || '', address: place.address || '', ...(type === 'place_time' ? { time: place.time || '' } : {}) };
  }
  if (type === 'yes_no') return typeof value === 'boolean' ? value : null;
  return value == null ? '' : String(value);
}

/** The value the API takes for a draft value (null = empty). A number that
 *  does not parse is sent as typed, so the server names the field. */
function apiValue(type: BriefFieldType, value: BriefDraftValue): BriefValue {
  if (isPlace(type)) {
    const p = (value as BriefPlace | null) || { place: '', address: '' };
    const out: BriefPlace = { place: (p.place || '').trim(), address: (p.address || '').trim() };
    if (type === 'place_time') out.time = p.time || '';
    return Object.values(out).some(Boolean) ? out : null;
  }
  if (type === 'yes_no') return typeof value === 'boolean' ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (isNumber(type)) {
    const n = Number(text.replace(',', '.'));
    return Number.isFinite(n) ? n : text;
  }
  return text;
}

export function draftFromBrief(brief: Brief | undefined): BriefDraft {
  const draft: BriefDraft = { values: {}, visible: {}, cleared: [], sharedArrangements: '', occasion: null };
  if (!brief) return draft;
  for (const field of editableFields(brief)) draft.values[field.id] = draftValue(field.type, field.value);
  for (const field of brief.fields) if (field.source !== 'removed') draft.visible[field.id] = field.visible;
  draft.sharedArrangements = brief.sharedArrangements || '';
  draft.occasion = brief.occasion;
  return draft;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Only what changed, so saving an untouched brief writes nothing. */
export function briefPayload(draft: BriefDraft, base: BriefDraft, brief: Brief | undefined, withOccasion: boolean): BriefSavePayload {
  const out: BriefSavePayload = {};
  if (!brief) return out;
  const values: NonNullable<BriefSavePayload['values']> = {};
  for (const field of editableFields(brief)) {
    const next = apiValue(field.type, draft.values[field.id] ?? null);
    if (!same(next, apiValue(field.type, base.values[field.id] ?? null))) values[field.id] = { value: next };
  }
  for (const field of brief.fields) {
    if (field.source === 'removed' || (draft.visible[field.id] ?? null) === (base.visible[field.id] ?? null)) continue;
    values[field.id] = { ...values[field.id], visible: draft.visible[field.id] ?? null };
  }
  for (const id of draft.cleared) {
    if (brief.fields.some((f) => f.id === id && f.source === 'removed')) values[id] = { value: null };
  }
  if (Object.keys(values).length) out.values = values;
  if (draft.sharedArrangements.trim() !== base.sharedArrangements.trim()) out.sharedArrangements = draft.sharedArrangements;
  if (withOccasion && draft.occasion !== base.occasion) out.occasion = draft.occasion;
  return out;
}

/** A refetch changed the saved brief: keep every entry the admin touched,
 *  take the new saved state for the rest (UX.md › rebaseDraft). */
export function rebaseBriefDraft(draft: BriefDraft, oldBase: BriefDraft, newBase: BriefDraft): BriefDraft {
  const pick = <T,>(mine: T, old: T, next: T): T => (same(mine, old) ? next : mine);
  const merge = <T,>(mine: Record<number, T>, old: Record<number, T>, next: Record<number, T>) => {
    const out = { ...next };
    for (const key of Object.keys(mine).map(Number)) if (!same(mine[key], old[key])) out[key] = mine[key];
    return out;
  };
  return {
    values: merge(draft.values, oldBase.values, newBase.values),
    visible: merge(draft.visible, oldBase.visible, newBase.visible),
    cleared: draft.cleared,
    sharedArrangements: pick(draft.sharedArrangements, oldBase.sharedArrangements, newBase.sharedArrangements),
    occasion: pick(draft.occasion, oldBase.occasion, newBase.occasion),
  };
}
