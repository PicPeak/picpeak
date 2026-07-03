/**
 * Unit tests for `normaliseEventTimeTriple` — the pure validator that
 * gates the migration-137 calendar time columns on events.
 *
 * The DB-bound CRUD paths (createEvent/updateEvent) inline this
 * helper and write through hasColumnCached guards; those are
 * exercised in manual QA. This file pins the contract so a future
 * tweak to the validation rules doesn't silently break it.
 */

const path = require('path');
const servicePath = path.join(__dirname, '..', '..', 'src', 'services', 'eventService');

// Stub every DB-bound peer so the require chain doesn't try to open
// a knex connection. The helper under test is pure.
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/schemaCache', () => ({ hasColumnCached: jest.fn() }));
jest.mock('bcrypt', () => ({ hash: jest.fn() }));

const { normaliseEventTimeTriple } = require(servicePath);

describe('normaliseEventTimeTriple', () => {
  it('defaults to full-day when is_full_day is undefined', () => {
    expect(normaliseEventTimeTriple({})).toEqual({
      event_time_start: null,
      event_time_end: null,
      is_full_day: true,
    });
  });

  it('forces times to null when is_full_day is true even if times are supplied', () => {
    expect(normaliseEventTimeTriple({
      is_full_day: true,
      event_time_start: '10:00',
      event_time_end: '12:00',
    })).toEqual({
      event_time_start: null,
      event_time_end: null,
      is_full_day: true,
    });
  });

  it('accepts a valid timed range when is_full_day is false', () => {
    expect(normaliseEventTimeTriple({
      is_full_day: false,
      event_time_start: '09:30',
      event_time_end: '17:00',
    })).toEqual({
      event_time_start: '09:30',
      event_time_end: '17:00',
      is_full_day: false,
    });
  });

  it('throws when is_full_day is false and start is missing/malformed', () => {
    expect(() => normaliseEventTimeTriple({
      is_full_day: false,
      event_time_end: '12:00',
    })).toThrow(/HH:MM/);
    expect(() => normaliseEventTimeTriple({
      is_full_day: false,
      event_time_start: '25:00',
      event_time_end: '12:00',
    })).toThrow(/HH:MM/);
    expect(() => normaliseEventTimeTriple({
      is_full_day: false,
      event_time_start: '9:00',
      event_time_end: '12:00',
    })).toThrow(/HH:MM/);
  });

  it('throws when end is missing or malformed', () => {
    expect(() => normaliseEventTimeTriple({
      is_full_day: false,
      event_time_start: '10:00',
    })).toThrow(/HH:MM/);
    expect(() => normaliseEventTimeTriple({
      is_full_day: false,
      event_time_start: '10:00',
      event_time_end: '12:99',
    })).toThrow(/HH:MM/);
  });

  it('throws when end is at or before start', () => {
    expect(() => normaliseEventTimeTriple({
      is_full_day: false,
      event_time_start: '10:00',
      event_time_end: '10:00',
    })).toThrow(/after/);
    expect(() => normaliseEventTimeTriple({
      is_full_day: false,
      event_time_start: '15:00',
      event_time_end: '10:00',
    })).toThrow(/after/);
  });

  it('parses string boolean flag', () => {
    // `parseBooleanInput` accepts "true" / "false" / "1" / "0" — verify
    // the helper consumes them transparently.
    expect(normaliseEventTimeTriple({
      is_full_day: 'false',
      event_time_start: '08:00',
      event_time_end: '09:00',
    })).toEqual({
      event_time_start: '08:00',
      event_time_end: '09:00',
      is_full_day: false,
    });
    expect(normaliseEventTimeTriple({
      is_full_day: '1',
      event_time_start: '08:00',
      event_time_end: '09:00',
    })).toEqual({
      event_time_start: null,
      event_time_end: null,
      is_full_day: true,
    });
  });
});
