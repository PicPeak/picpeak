import type { TFunction } from 'i18next';
import type { PhotoDeleteResult } from '../../services/photos.service';

/**
 * What deleting photos says (issue 1733). With a trash retention the photos
 * can be restored for that many days; without one (0, or not known yet) the
 * delete is final and the text says so.
 */
const forDays = (t: TFunction, days: number) => t('admin.photos.trash.forDays', { count: days });

export function deleteOneConfirm(t: TFunction, name: string, retentionDays?: number): string {
  return retentionDays && retentionDays > 0
    ? t('admin.photos.trash.confirmOne', { name, forDays: forDays(t, retentionDays) })
    : t('admin.photos.deleteOneConfirm', 'Delete "{{name}}"? The photo is removed from the gallery for good. This cannot be undone.', { name });
}

export function deleteManyConfirm(t: TFunction, count: number, retentionDays?: number): string {
  return retentionDays && retentionDays > 0
    ? t('admin.photos.trash.confirmMany', { count, forDays: forDays(t, retentionDays) })
    : t('admin.photos.deleteManyConfirm', 'Delete {{count}} photos? They are removed from the gallery. This cannot be undone.', { count });
}

/** The success toast for a delete of `count` photos, from what the server did. */
export function deletedMessage(t: TFunction, count: number, result: PhotoDeleteResult | undefined): string {
  const trashed = result?.trashed ?? 0;
  return trashed > 0
    ? t('admin.photos.trash.moved', { count: trashed })
    : t('admin.photos.trash.deleted', { count });
}
