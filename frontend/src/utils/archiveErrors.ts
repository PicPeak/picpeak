import type { TFunction } from 'i18next';

/**
 * Another archive job holds the gallery (issue 2012): the archive, restore and
 * delete routes answer 409 ARCHIVE_IN_PROGRESS. Translated text for that code,
 * or undefined so the caller keeps its own message.
 */
export function archiveInProgressError(error: unknown, t: TFunction): string | undefined {
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return code === 'ARCHIVE_IN_PROGRESS' ? t('events.archiveInProgress') : undefined;
}
