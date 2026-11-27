import { useEffect, useMemo, useRef } from 'react';
import { staleFaceCovers } from './imageTiers';

type Person = Parameters<typeof staleFaceCovers>[0][number];
type ListedPhoto = { id: number; url?: string | null; thumbnail_url?: string | null };

/**
 * Keeps face covers in step with the photos they are cut from (issue 2619):
 * the people list is cached apart from the photo list, so after an edit lands
 * a photo can name a newer revision than its cover's box. The people list is
 * then fetched again, once for each answer of it (`updatedAt`), so a server
 * still behind does not start a loop.
 */
export function useFreshFaceCovers(
  people: Person[],
  photos: ListedPhoto[] | undefined,
  updatedAt: number,
  refresh: () => void,
) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const askedFor = useRef<number | null>(null);
  const stale = useMemo(
    () => Boolean(photos?.length) && staleFaceCovers(people, new Map((photos || []).map((p) => [p.id, p]))),
    [people, photos],
  );
  useEffect(() => {
    if (!stale || askedFor.current === updatedAt) return;
    askedFor.current = updatedAt;
    refreshRef.current();
  }, [stale, updatedAt]);
}
