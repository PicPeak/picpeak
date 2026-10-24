/**
 * The project's own data as an editable draft: the inquiry fields of
 * migration 315 in form shape (strings for inputs, the budget in major units
 * for DecimalInput). Shared by "Neue Anfrage" and the project Overview, so
 * both build the request the same way, and the Overview sends only what
 * changed (UX.md › Saving).
 *
 * `budgetMinor` follows the app's `*_minor` convention (the major amount
 * times 100, as for invoices and hourly rates), whatever the currency, so
 * the `/ 100` and `* 100` below round-trip for every currency.
 */
import type { ProjectFlow, ProjectInquiryFields, ProjectSummary, ProjectWritePayload, InquirySource } from '../../../services/projects.service';

export interface ProjectDraft {
  flow: ProjectFlow;
  eventType: string;
  eventDate: string;
  eventEndDate: string;
  location: string;
  guestCount: string;
  /** Major units (CHF 4 500.00 → 4500). */
  budget: number;
  currency: string;
  source: string;
  notes: string;
}

export type ProjectDraftKey = keyof ProjectDraft;

export const EMPTY_DRAFT: ProjectDraft = {
  flow: 'full',
  eventType: '',
  eventDate: '',
  eventEndDate: '',
  location: '',
  guestCount: '',
  budget: 0,
  currency: '',
  source: '',
  notes: '',
};

export function draftFromProject(p: Partial<ProjectSummary>): ProjectDraft {
  return {
    flow: p.flow || 'full',
    eventType: p.eventType || '',
    eventDate: p.eventDate || '',
    eventEndDate: p.eventEndDate || '',
    location: p.location || '',
    guestCount: p.guestCount != null ? String(p.guestCount) : '',
    budget: p.budgetMinor != null ? p.budgetMinor / 100 : 0,
    currency: p.currency || '',
    source: p.source || '',
    notes: p.notes || '',
  };
}

/** The draft as API fields. Empty inputs become null, which clears them. */
export function fieldsFromDraft(d: ProjectDraft): Partial<ProjectInquiryFields> {
  const guests = d.guestCount.trim() === '' ? null : Math.max(0, Math.trunc(Number(d.guestCount)));
  return {
    flow: d.flow || 'full',
    eventType: d.eventType || null,
    eventDate: d.eventDate || null,
    eventEndDate: d.eventEndDate || null,
    location: d.location.trim() || null,
    guestCount: guests != null && Number.isFinite(guests) ? guests : null,
    budgetMinor: d.budget > 0 ? Math.round(d.budget * 100) : null,
    currency: d.currency || null,
    source: (d.source || null) as InquirySource | null,
    notes: d.notes.trim() || null,
  };
}

/** The fields whose value differs between the two drafts. */
export function changedKeys(draft: ProjectDraft, base: ProjectDraft): ProjectDraftKey[] {
  const a = fieldsFromDraft(draft);
  const b = fieldsFromDraft(base);
  return (Object.keys(draft) as ProjectDraftKey[]).filter((key) => {
    const field = key === 'budget' ? 'budgetMinor' : key;
    return a[field as keyof ProjectInquiryFields] !== b[field as keyof ProjectInquiryFields];
  });
}

/** Only the changed fields, so saving an untouched draft writes nothing. */
export function updatePayload(draft: ProjectDraft, base: ProjectDraft): ProjectWritePayload {
  const fields = fieldsFromDraft(draft);
  const out: ProjectWritePayload = {};
  for (const key of changedKeys(draft, base)) {
    const field = (key === 'budget' ? 'budgetMinor' : key) as keyof ProjectInquiryFields;
    (out as Record<string, unknown>)[field] = fields[field];
  }
  return out;
}

/** A refetch changed the server state under an edited draft: take the new
 *  value for every field the admin has not touched (UX.md › rebaseDraft). */
export function rebaseDraft(draft: ProjectDraft, oldBase: ProjectDraft, newBase: ProjectDraft): ProjectDraft {
  const touched = new Set(changedKeys(draft, oldBase));
  const next = { ...newBase };
  for (const key of touched) (next as Record<string, unknown>)[key] = draft[key];
  return next;
}

/** End before start, the one cross-field rule (the API refuses it too). */
export function dateRangeError(d: ProjectDraft): boolean {
  return !!(d.eventDate && d.eventEndDate && d.eventEndDate < d.eventDate);
}

/** The API's limit for guestCount (adminProjects inquiryValidators). */
export const MAX_GUESTS = 100000;

/** More guests than the API takes: flagged on the field, not sent. */
export function guestCountError(d: ProjectDraft): boolean {
  // The number fieldsFromDraft would send.
  return d.guestCount.trim() !== '' && Math.trunc(Number(d.guestCount)) > MAX_GUESTS;
}

/** What stops the draft from saving, as a message key, or null. */
export function draftError(d: ProjectDraft): 'endBeforeStart' | 'tooManyGuests' | null {
  if (dateRangeError(d)) return 'endBeforeStart';
  if (guestCountError(d)) return 'tooManyGuests';
  return null;
}
