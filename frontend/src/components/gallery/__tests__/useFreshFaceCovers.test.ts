import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFreshFaceCovers } from '../useFreshFaceCovers';

const photo = (rev: number) => ({ id: 42, url: `/api/gallery/wed/photo/42?e=${rev}` });
const people = (rev: number) => [{ cover: { photo_id: 42, bbox: [1, 2, 3, 4], edit_applied_rev: rev } }];

describe('useFreshFaceCovers (issue 2619)', () => {
  it('refetches the people list once when a cover is older than its photo', () => {
    const refresh = vi.fn();
    const { rerender } = renderHook((props) => useFreshFaceCovers(props.people, props.photos, props.at, refresh), {
      initialProps: { people: people(2), photos: [photo(2)], at: 1 },
    });
    expect(refresh).not.toHaveBeenCalled();
    // The photos list moved on to revision 3; the people list still has 2.
    rerender({ people: people(2), photos: [photo(3)], at: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Rendering again with the same people answer asks nothing more.
    rerender({ people: people(2), photos: [photo(3)], at: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
    // The refetched answer is current.
    rerender({ people: people(3), photos: [photo(3)], at: 2 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
