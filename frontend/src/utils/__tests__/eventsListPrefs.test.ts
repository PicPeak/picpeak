import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventsListSort, parseEventsListSort, setEventsListSort } from '../eventsListPrefs';

describe('eventsListPrefs', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads nothing when nothing is stored', () => {
    expect(getEventsListSort()).toBeNull();
  });

  it('round-trips a sort', () => {
    setEventsListSort({ sortBy: 'event_name', sortOrder: 'asc' });
    expect(getEventsListSort()).toEqual({ sortBy: 'event_name', sortOrder: 'asc' });
  });

  it('ignores a stored value the menus cannot produce', () => {
    localStorage.setItem('picpeak.eventsList.sort', 'password:asc');
    expect(getEventsListSort()).toBeNull();
    localStorage.setItem('picpeak.eventsList.sort', 'event_name');
    expect(getEventsListSort()).toBeNull();
  });

  it('does not persist an invalid sort', () => {
    // @ts-expect-error — exercising the runtime guard
    setEventsListSort({ sortBy: 'nope', sortOrder: 'asc' });
    expect(localStorage.getItem('picpeak.eventsList.sort')).toBeNull();
  });

  it('reads as nothing stored when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getEventsListSort()).toBeNull();
  });

  it('parses only complete pairs', () => {
    expect(parseEventsListSort('event_date', 'desc')).toEqual({ sortBy: 'event_date', sortOrder: 'desc' });
    expect(parseEventsListSort('event_date', null)).toBeNull();
    expect(parseEventsListSort(null, 'asc')).toBeNull();
  });
});
