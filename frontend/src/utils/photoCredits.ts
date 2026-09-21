/**
 * Photo credits in the guest gallery (#1561).
 *
 * The "By" filter groups photos by who is credited. A photo carries
 * `credit_name` only when the gallery shows names to this viewer; the
 * grouping then has three kinds:
 *
 *   name          a guest's name or an EXIF/manual credit
 *   guest         a guest upload without a name
 *   photographer  everything else — the photographer's own photos
 *
 * Keys are prefixed so a guest who calls themselves "photographer" cannot
 * collide with the built-in group.
 */
import type { Photo } from '../types';

export type CreditKind = 'name' | 'guest' | 'photographer';

export interface CreditGroup {
  key: string;
  kind: CreditKind;
  name: string | null;
  count: number;
}

export const CREDIT_KEY_GUEST = 'kind:guest';
export const CREDIT_KEY_PHOTOGRAPHER = 'kind:photographer';

type CreditFields = Pick<Photo, 'credit_name' | 'uploaded_by_guest'>;

export function creditKeyOf(photo: CreditFields): string {
  if (photo.credit_name) return `name:${photo.credit_name}`;
  return photo.uploaded_by_guest ? CREDIT_KEY_GUEST : CREDIT_KEY_PHOTOGRAPHER;
}

/**
 * Groups with counts, named ones alphabetically, then unnamed guests, then the
 * photographer. Empty when no photo carries a name: a filter whose only
 * choices are "guests" and "photographer" answers nobody's "who took this?".
 */
export function creditGroups(photos: CreditFields[], locale?: string): CreditGroup[] {
  const counts = new Map<string, CreditGroup>();
  for (const photo of photos) {
    const key = creditKeyOf(photo);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        key,
        kind: photo.credit_name ? 'name' : (photo.uploaded_by_guest ? 'guest' : 'photographer'),
        name: photo.credit_name || null,
        count: 1,
      });
    }
  }
  const groups = Array.from(counts.values());
  if (!groups.some((g) => g.kind === 'name')) return [];
  const rank: Record<CreditKind, number> = { name: 0, guest: 1, photographer: 2 };
  return groups.sort((a, b) => (rank[a.kind] - rank[b.kind])
    || (a.name || '').localeCompare(b.name || '', locale, { sensitivity: 'base' }));
}
