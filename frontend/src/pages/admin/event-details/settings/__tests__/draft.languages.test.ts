/**
 * Multilingual texts in the settings draft (issue 2550): the mode and the
 * languages go with the events row and belong to the Languages section; the
 * title's translations count for Languages, the welcome message's for
 * General; only changed texts are written, an emptied one is removed.
 */
import { describe, expect, it } from 'vitest';
import type { Event } from '../../../../../types';
import {
  DraftValidationError,
  dirtySections,
  eventFieldsFromEvent,
  eventTextChanges,
  eventTextsFromRows,
  eventUpdatePayload,
  rebaseDraft,
  resetSection,
  type EventSettingsDraft,
} from '../draft';

const t = (_key: string, fallback: string) => fallback;
const EVENT = {
  id: 4, slug: 'g', event_type: 'wedding', event_name: 'Hochzeit', expires_at: null, require_password: false,
  source_mode: 'managed', custom_theme_enabled: false,
} as unknown as Event;

const base = eventFieldsFromEvent(EVENT, null);
const slices = (event = base, translations: Record<string, string> | null = {}): EventSettingsDraft =>
  ({ event, feedback: null, downloads: null, slideshow: null, translations });

describe('language settings', () => {
  it('reads an unknown stored mode as off', () => {
    expect(eventFieldsFromEvent({ ...EVENT, text_language_mode: 'auto' as never }, null).text_language_mode).toBe('off');
  });

  it('sends the mode and the languages, dirtying Languages only', () => {
    const draft = { ...base, text_language_mode: 'bilingual' as const, text_primary_language: 'de', text_secondary_language: 'en' };
    expect(eventUpdatePayload(draft, base, t)).toEqual({ text_language_mode: 'bilingual', text_primary_language: 'de', text_secondary_language: 'en' });
    expect(dirtySections(slices(draft), slices())).toEqual(new Set(['languages']));
  });

  it('refuses a mode without its languages', () => {
    const noPrimary = { ...base, text_language_mode: 'visitor' as const, text_primary_language: null };
    expect(() => eventUpdatePayload(noPrimary, base, t)).toThrow(DraftValidationError);
    const sameTwice = { ...base, text_language_mode: 'bilingual' as const, text_primary_language: 'de', text_secondary_language: 'de' };
    try {
      eventUpdatePayload(sameTwice, base, t);
      throw new Error('accepted');
    } catch (error) {
      expect((error as DraftValidationError).section).toBe('languages');
    }
  });
});

describe('event texts', () => {
  const rows = [
    { entity_type: 'event' as const, entity_id: 4, field: 'event_name', language: 'en', text: 'Wedding' },
    { entity_type: 'event' as const, entity_id: 4, field: 'welcome_message', language: 'en', text: 'Welcome' },
    // Not the title or welcome message of this event: left to the category manager.
    { entity_type: 'category' as const, entity_id: 9, field: 'name', language: 'en', text: 'Ceremony' },
    { entity_type: 'event' as const, entity_id: 5, field: 'event_name', language: 'en', text: 'Other' },
  ];

  it('keeps only this event\'s title and welcome message', () => {
    expect(eventTextsFromRows(rows, 4)).toEqual({ 'event_name:en': 'Wedding', 'welcome_message:en': 'Welcome' });
    expect(eventTextsFromRows(undefined, 4)).toBeNull();
  });

  it('writes what changed; an emptied text removes the row', () => {
    const loaded = eventTextsFromRows(rows, 4)!;
    const edited = { ...loaded, 'event_name:en': '  The wedding ', 'welcome_message:en': ' ', 'event_name:fr': 'Mariage' };
    expect(eventTextChanges(edited, loaded, 4).sort((a, b) => `${a.field}${a.language}`.localeCompare(`${b.field}${b.language}`))).toEqual([
      { entity_type: 'event', entity_id: 4, field: 'event_name', language: 'en', text: 'The wedding' },
      { entity_type: 'event', entity_id: 4, field: 'event_name', language: 'fr', text: 'Mariage' },
      { entity_type: 'event', entity_id: 4, field: 'welcome_message', language: 'en', text: null },
    ]);
    expect(eventTextChanges(loaded, loaded, 4)).toEqual([]);
    // Not loaded yet: nothing to compare, nothing to write.
    expect(eventTextChanges(edited, null, 4)).toEqual([]);
  });

  it('dirties the section that shows the field, and undoes it per section', () => {
    const loaded = eventTextsFromRows(rows, 4)!;
    const edited = { ...loaded, 'event_name:fr': 'Mariage', 'welcome_message:en': 'Hello' };
    expect(dirtySections(slices(base, edited), slices(base, loaded))).toEqual(new Set(['languages', 'general']));
    const undone = resetSection(slices(base, edited), slices(base, loaded), 'general');
    expect(undone.translations).toEqual({ ...loaded, 'event_name:fr': 'Mariage' });
  });

  it('follows the server while untouched, keeps edits otherwise', () => {
    const loaded = eventTextsFromRows(rows, 4)!;
    const server = { ...loaded, 'event_name:de': 'Hochzeit!' };
    expect(rebaseDraft(slices(base, loaded), slices(base, loaded), slices(base, server)).translations).toEqual(server);
    const edited = { ...loaded, 'event_name:fr': 'Mariage' };
    // Per key: the edit stays, the text that arrived meanwhile comes in too,
    // so the save does not delete what the admin never touched.
    const rebased = rebaseDraft(slices(base, edited), slices(base, loaded), slices(base, server)).translations!;
    expect(rebased).toEqual({ ...server, 'event_name:fr': 'Mariage' });
    expect(eventTextChanges(rebased, server, 4)).toEqual([
      { entity_type: 'event', entity_id: 4, field: 'event_name', language: 'fr', text: 'Mariage' },
    ]);
  });
});
