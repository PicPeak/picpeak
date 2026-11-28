/**
 * `?section=website` opens the Public website section of a gallery's settings
 * (issue 2618): the details page opens only the sections a link may name.
 */
import { expect, it } from 'vitest';
import { isLinkedSection } from '../draft';

it('accepts the website section in the URL, and nothing it does not know', () => {
  expect(isLinkedSection('website')).toBe(true);
  expect(isLinkedSection('general')).toBe(true);
  expect(isLinkedSection('nope')).toBe(false);
  expect(isLinkedSection(null)).toBe(false);
});
