import { describe, expect, it } from 'vitest';
import { eventHasGuests } from '../utils';

describe('eventHasGuests', () => {
  it('shows the Guests tab for guest feedback, and for uploader names in any feedback mode', () => {
    expect(eventHasGuests({}, { identity_mode: 'guest' })).toBe(true);
    expect(eventHasGuests({ allow_user_uploads: true, guest_name_mode: 'optional' }, { identity_mode: 'simple' })).toBe(true);
    expect(eventHasGuests({ allow_user_uploads: true, guest_name_mode: 'off' }, { identity_mode: 'simple' })).toBe(false);
    expect(eventHasGuests({ allow_user_uploads: false, guest_name_mode: 'required' }, { identity_mode: 'simple' })).toBe(false);
  });
});
