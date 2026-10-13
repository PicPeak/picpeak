import type { QueryClient } from '@tanstack/react-query';
import { folderQueryKey } from '../../../services/folders.service';

/**
 * Everything a folder change can move (issue 1786): the folder tree and its
 * requests, the photo grid (photos change folder), the event's counters and
 * the category lists (folders are photo_categories rows, cached by
 * EventDetailsPage and by EventCategoryManager under different keys).
 */
export function invalidateFolderViews(queryClient: QueryClient, eventId: number): void {
  queryClient.invalidateQueries({ queryKey: folderQueryKey(eventId) });
  queryClient.invalidateQueries({ queryKey: ['admin-event-photos', String(eventId)] });
  queryClient.invalidateQueries({ queryKey: ['admin-event', String(eventId)] });
  queryClient.invalidateQueries({ queryKey: ['admin-event-categories', String(eventId)] });
  queryClient.invalidateQueries({ queryKey: ['event-categories', eventId] });
}

type Translate = (key: string, fallback: string, options?: Record<string, unknown>) => string;

/**
 * The reason for a refused folder change, in the admin's language: the
 * folder routes answer with a stable `code` (and `limit` where one applies).
 * A code without a string here, or a reply without a code, falls back to
 * the server's English message.
 */
export function folderErrorMessage(error: unknown, t: Translate): string | undefined {
  const e = error as { response?: { data?: { error?: string; code?: string; limit?: number; name?: string } } };
  const data = e?.response?.data;
  const limit = data?.limit;
  switch (data?.code) {
    case 'FOLDER_EXISTS': return t('photos.folders.errors.exists', 'A folder with this name already exists here.');
    case 'FOLDER_DELETE_NAME_CLASH': return t('photos.folders.errors.deleteNameClash', 'The subfolder "{{name}}" cannot move up: a folder with this name already exists there. Rename or move it first.', { name: data?.name ?? '' });
    case 'FOLDER_TOO_DEEP': return t('photos.folders.errors.tooDeep', 'Folders can be nested at most {{limit}} levels deep.', { limit: limit ?? 3 });
    case 'FOLDER_NOT_FOUND': return t('photos.folders.errors.notFound', 'This folder no longer exists. Reload the page.');
    case 'FOLDER_CYCLE': return t('photos.folders.errors.cycle', 'A folder cannot be moved into itself or one of its subfolders.');
    case 'FOLDER_LIMIT_REACHED': return t('photos.folders.errors.limitReached', 'This gallery has reached its limit of {{limit}} folders.', { limit });
    case 'FOLDER_REQUEST_LIMIT_REACHED': return t('photos.folders.errors.requestLimitReached', 'This gallery has reached its limit of {{limit}} open folder requests. Ask an administrator to approve or reject some first.', { limit });
    case 'FOLDER_REQUEST_NOT_FOUND': return t('photos.folders.errors.requestNotFound', 'This folder request was already decided or no longer exists.');
    default: return data?.error;
  }
}
