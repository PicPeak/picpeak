/**
 * How the builder's pickers show a failed list load (frontend/UX.md section 4).
 */
import { Button, Notice } from '../../components/common';
import { ErrorState } from '../../components/common/EmptyState';
import { apiErrorText } from '../../utils/apiErrorText';

export interface PaneQuery {
  data?: unknown;
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}

/**
 * A pane's failed load (frontend/UX.md §4). Nothing loaded yet: the error
 * with Retry takes the list's place, never "nothing here". A list already
 * on screen stays, under a notice.
 */
export function loadFailure(query: PaneQuery, t: (key: string, fallback: string) => string) {
  if (!query.isError) return { blocking: null, notice: null };
  const retry = () => { void query.refetch(); };
  if (!query.data) {
    return { blocking: <ErrorState size="inline" message={apiErrorText(query.error)} onRetry={retry} retrying={query.isFetching} />, notice: null };
  }
  return {
    blocking: null,
    notice: (
      <Notice tone="warning" size="sm" action={<Button size="sm" variant="secondary" isLoading={query.isFetching} onClick={retry}>{t('common.retry', 'Retry')}</Button>}>
        {t('website.picker.refreshFailed', 'Could not refresh this list. What you see may be out of date.')}
      </Notice>
    ),
  };
}
