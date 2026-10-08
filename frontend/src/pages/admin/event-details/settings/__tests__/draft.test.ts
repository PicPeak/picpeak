import { describe, expect, it } from 'vitest';
import type { Event } from '../../../../../types';
import {
  DraftValidationError,
  dirtySections,
  eventFieldsFromEvent,
  eventUpdatePayload,
  rebaseDraft,
  resetSection,
  slideshowFromEvent,
  usesCustomTheme,
  type EventSettingsDraft,
} from '../draft';

const t = (_key: string, fallback: string) => fallback;

const EVENT = {
  id: 1,
  slug: 'g',
  event_type: 'wedding',
  event_name: 'G',
  event_date: '2026-06-14',
  expires_at: '2026-12-14T00:00:00.000Z',
  require_password: true,
  customer_name: 'Sarah',
  customer_email: 'sarah@example.com',
  color_theme: JSON.stringify({ headerStyle: 'hero', primaryColor: '#111111' }),
  custom_theme_enabled: false,
  source_mode: 'managed',
} as unknown as Event;

const branding = { headerStyle: 'standard' as const, primaryColor: '#222222' };

describe('event settings draft', () => {
  it('sends nothing when nothing changed', () => {
    const base = eventFieldsFromEvent(EVENT, branding);
    expect(eventUpdatePayload({ ...base }, base, t)).toBeNull();
  });

  it('sends only the fields the admin changed', () => {
    const base = eventFieldsFromEvent(EVENT, branding);
    const payload = eventUpdatePayload({ ...base, welcome_message: 'Hi', photo_cap: 50 }, base, t);
    expect(payload).toEqual({ welcome_message: 'Hi', photo_cap: 50 });
  });

  it('sends the team and the review switch only when the owner changed them (issue 743)', () => {
    const base = eventFieldsFromEvent({
      ...EVENT,
      assigned_admins: [{ id: 7, username: 'anna', role_name: 'Team Photographer' }],
      review_contributor_uploads: 0,
    } as unknown as Event, branding);
    expect(base.assigned_admins.map((a) => a.id)).toEqual([7]);
    expect(base.review_contributor_uploads).toBe(false);
    // A team member's save of other fields never carries them.
    expect(eventUpdatePayload({ ...base, welcome_message: 'Hi' }, base, t)).toEqual({ welcome_message: 'Hi' });

    const payload = eventUpdatePayload({
      ...base,
      assigned_admins: [...base.assigned_admins, { id: 9, username: 'ben', role_name: null }],
      review_contributor_uploads: true,
    }, base, t);
    expect(payload).toEqual({ assigned_admin_ids: [7, 9], review_contributor_uploads: true });
  });

  it('switching custom styling off keeps the stored theme untouched', () => {
    const on = eventFieldsFromEvent({ ...EVENT, custom_theme_enabled: true } as Event, branding);
    const payload = eventUpdatePayload({ ...on, custom_theme_enabled: false }, on, t);
    expect(payload).toEqual({ custom_theme_enabled: false });
  });

  it('switching custom styling on sends the whole look together', () => {
    const off = eventFieldsFromEvent(EVENT, branding);
    const payload = eventUpdatePayload({ ...off, custom_theme_enabled: true, css_template_id: 3 }, off, t)!;
    expect(payload.custom_theme_enabled).toBe(true);
    expect(JSON.parse(payload.color_theme as string)).toEqual({ headerStyle: 'hero', primaryColor: '#111111' });
    expect(payload.header_style).toBe('hero');
    expect(payload.css_template_id).toBe(3);
  });

  it('starts the editor from Branding when the gallery has no theme', () => {
    const fields = eventFieldsFromEvent({ ...EVENT, color_theme: undefined } as Event, branding);
    expect(fields.theme).toEqual(branding);
  });

  it('reads the old meaning when the row predates the switch', () => {
    expect(usesCustomTheme({ ...EVENT, custom_theme_enabled: undefined } as Event)).toBe(true);
    expect(usesCustomTheme({ ...EVENT, custom_theme_enabled: undefined, color_theme: undefined } as Event)).toBe(false);
  });

  it('refuses to turn the password on without a new one', () => {
    const base = eventFieldsFromEvent({ ...EVENT, require_password: false } as Event, branding);
    expect(() => eventUpdatePayload({ ...base, require_password: true }, base, t)).toThrow(DraftValidationError);
  });

  it('refuses an external source without a folder, naming the section', () => {
    const base = eventFieldsFromEvent(EVENT, branding);
    try {
      eventUpdatePayload({ ...base, source_mode: 'reference', external_path: '' }, base, t);
      throw new Error('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(DraftValidationError);
      expect((error as DraftValidationError).section).toBe('source');
    }
  });

  it('sends an emptied customer name and email as the clearing values', () => {
    // issue 1733 — the email went out as undefined, which the payload loop
    // skips, so the stored address survived the save.
    const base = eventFieldsFromEvent(EVENT, branding);
    const payload = eventUpdatePayload({ ...base, customer_name: '', customer_email: '  ' }, base, t);
    expect(payload).toEqual({ customer_name: '', customer_email: null });
    const draft: EventSettingsDraft = { event: { ...base, customer_email: '' }, feedback: null, downloads: null, slideshow: null };
    expect([...dirtySections(draft, { ...draft, event: base })]).toEqual(['general']);
  });

  it('sends a new password and never keeps it in the comparison', () => {
    const base = eventFieldsFromEvent(EVENT, branding);
    const payload = eventUpdatePayload({ ...base, new_password: 'secret12', confirm_new_password: 'secret12' }, base, t);
    expect(payload).toEqual({ password: 'secret12' });
  });

  it('sends the delivery fields as the backend reads them (issue 1562)', () => {
    const base = eventFieldsFromEvent(EVENT, branding);
    expect(base).toMatchObject({ folder_structure: false, delivery_status: 'complete', delivery_due_at: '' });
    const payload = eventUpdatePayload({
      ...base,
      folder_structure: true,
      delivery_status: 'partial',
      delivery_expected_count: '80',
      delivery_due_at: '2026-06-21',
      delivery_badge_label: '  Social media pre-delivery ',
    }, base, t);
    expect(payload).toEqual({
      folder_structure: true,
      delivery_status: 'partial',
      delivery_expected_count: 80,
      // Noon UTC keeps the calendar date in every timezone.
      delivery_due_at: '2026-06-21T12:00:00.000Z',
      delivery_badge_label: 'Social media pre-delivery',
    });
  });

  it('refuses a non-integer expected count, naming the delivery section', () => {
    const base = eventFieldsFromEvent(EVENT, branding);
    expect(() => eventUpdatePayload({ ...base, delivery_expected_count: '0' }, base, t))
      .toThrow(DraftValidationError);
    try {
      eventUpdatePayload({ ...base, delivery_expected_count: '1.5' }, base, t);
    } catch (err) {
      expect((err as DraftValidationError).section).toBe('delivery');
    }
  });

  it('marks the sections whose fields differ', () => {
    const fields = eventFieldsFromEvent(EVENT, branding);
    const base: EventSettingsDraft = { event: fields, feedback: null, downloads: null, slideshow: slideshowFromEvent(EVENT) };
    const draft: EventSettingsDraft = {
      ...base,
      event: { ...fields, welcome_message: 'x', event_reminder_offset_days: '3' },
      slideshow: { ...base.slideshow!, interval_ms: 9000 },
    };
    expect([...dirtySections(draft, base)].sort()).toEqual(['general', 'reminder', 'slideshow']);
  });

  it('keeps a change made elsewhere when the admin edited another field', () => {
    const fields = eventFieldsFromEvent(EVENT, branding);
    const base: EventSettingsDraft = { event: fields, feedback: null, downloads: null, slideshow: slideshowFromEvent(EVENT) };
    const edited: EventSettingsDraft = { ...base, event: { ...fields, welcome_message: 'Hi' } };
    // +30 days pressed on the Overview tab, refetched.
    const server: EventSettingsDraft = { ...base, event: { ...fields, expires_at: '2027-01-13' } };
    const rebased = rebaseDraft(edited, base, server);
    expect(rebased.event.welcome_message).toBe('Hi');
    expect(rebased.event.expires_at).toBe('2027-01-13');
    expect(eventUpdatePayload(rebased.event, server.event, t)).toEqual({ welcome_message: 'Hi' });
  });

  it('undoes one section and keeps the edits in the others', () => {
    const fields = eventFieldsFromEvent(EVENT, branding);
    const base: EventSettingsDraft = { event: fields, feedback: null, downloads: null, slideshow: slideshowFromEvent(EVENT) };
    const draft: EventSettingsDraft = {
      ...base,
      event: { ...fields, welcome_message: 'Hi', expires_at: '2026-12-31', require_password: false },
      slideshow: { ...base.slideshow!, interval_ms: 9000 },
    };
    const undone = resetSection(draft, base, 'access');
    expect(undone.event.expires_at).toBe(fields.expires_at);
    expect(undone.event.require_password).toBe(fields.require_password);
    expect(undone.event.welcome_message).toBe('Hi');
    expect([...dirtySections(undone, base)].sort()).toEqual(['general', 'slideshow']);
    expect([...dirtySections(resetSection(undone, base, 'slideshow'), base)]).toEqual(['general']);
  });

  it('undoes the feedback and downloads slices with their own sections only', () => {
    const fields = eventFieldsFromEvent(EVENT, branding);
    const feedback = { feedback_enabled: false } as unknown as EventSettingsDraft['feedback'];
    const downloads = { standard: 'inherit', picker: 'inherit', allowOriginal: 'inherit' };
    const base: EventSettingsDraft = { event: fields, feedback, downloads, slideshow: slideshowFromEvent(EVENT) };
    const draft: EventSettingsDraft = {
      ...base,
      feedback: { ...feedback!, feedback_enabled: true },
      downloads: { ...downloads, picker: 'true' },
    };
    const guestsUndone = resetSection(draft, base, 'guests');
    expect(guestsUndone.feedback).toEqual(feedback);
    expect(guestsUndone.downloads).toEqual(draft.downloads);
    const downloadsUndone = resetSection(draft, base, 'downloads');
    expect(downloadsUndone.downloads).toEqual(downloads);
    expect(downloadsUndone.feedback).toEqual(draft.feedback);
  });

  it('takes the header columns only while custom styling is on', () => {
    const withHeader = { ...EVENT, color_theme: undefined, header_style: 'minimal' } as unknown as Event;
    // Off: the gallery renders Branding's header, so the stale column must not seed the editor.
    expect(eventFieldsFromEvent({ ...withHeader, custom_theme_enabled: false } as Event, branding).theme.headerStyle).toBe('standard');
    // On: the gallery renders its own column.
    expect(eventFieldsFromEvent({ ...withHeader, custom_theme_enabled: true } as Event, branding).theme.headerStyle).toBe('minimal');
  });

  it('asks for a password before a customer email reaches a gallery whose password was generated', () => {
    const portalOnly = { ...EVENT, customer_email: null, password_generated: 1 } as unknown as Event;
    const base = eventFieldsFromEvent(portalOnly, branding);
    expect(base.generated_password_pending).toBe(true);

    const withEmail = { ...base, customer_email: 'client@example.com' };
    expect(() => eventUpdatePayload(withEmail, base, t)).toThrow(DraftValidationError);

    const payload = eventUpdatePayload(
      { ...withEmail, new_password: 'Sunrise-Lake-42', confirm_new_password: 'Sunrise-Lake-42' }, base, t,
    );
    expect(payload).toMatchObject({ customer_email: 'client@example.com', password: 'Sunrise-Lake-42' });
  });

  it('does not ask galleries whose password an admin typed', () => {
    const base = eventFieldsFromEvent({ ...EVENT, customer_email: null } as unknown as Event, branding);
    expect(eventUpdatePayload({ ...base, customer_email: 'client@example.com' }, base, t)).toMatchObject({ customer_email: 'client@example.com' });
  });
});
