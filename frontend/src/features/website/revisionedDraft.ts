/**
 * What the website's two drafts do alike (issue 2618): the document
 * (useWebsiteEditor) and the contact form settings (contactSettingsDraft)
 * are each saved against the revision they were made from. How a newer
 * server state is taken in differs (the whole document; field by field),
 * and stays with each.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { apiErrorCode } from '../../utils/apiErrorText';

/** Whether a save was refused because the stored revision moved on (the draft's own conflict code). */
export const isRevisionConflict = (err: unknown, code: string): boolean => apiErrorCode(err) === code;

/**
 * A write's answer is the latest state: it goes into the cache at once, and
 * a fetch already on its way, which describes the state before the write,
 * is dropped. Resolves once that fetch is cancelled.
 */
export function takeWriteAnswer<T>(queryClient: QueryClient, queryKey: QueryKey, answer: T): Promise<void> {
  const cancelled = queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData(queryKey, answer);
  return cancelled;
}
