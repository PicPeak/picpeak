import React, { useCallback, useState } from 'react';
import {
  FeedbackLimitReachedModal,
} from '../components/gallery/FeedbackLimitReachedModal';

/**
 * Per-guest favorite/like cap (#655). Components that submit feedback wrap
 * their mutation's onError with `handleError(err)` from this hook; when the
 * backend returns the structured 403 (`code: 'FAVORITE_LIMIT_REACHED'` /
 * `'LIKE_LIMIT_REACHED'`), the shared modal renders with the current count
 * and the configured limit.
 *
 * Usage:
 *   const { modal, handleError } = useFeedbackLimitModal();
 *   useMutation({ onError: (err) => { if (!handleError(err)) toast.error(...); } });
 *   return (<> {modal} <YourButton /> </>);
 *
 * handleError returns true when the error was a limit-reached 403 (so the
 * caller can skip its generic error toast). Returns false for any other
 * error shape so existing toast/error paths still fire.
 */

interface LimitState {
  open: boolean;
  feedbackType: 'favorite' | 'like';
  limit: number;
  currentCount: number;
}

function parseFeedbackLimitError(error: unknown): { feedbackType: 'favorite' | 'like'; limit: number; currentCount: number } | null {
  const axiosErr = error as {
    response?: {
      status?: number;
      data?: {
        code?: string;
        limit?: number;
        current_count?: number;
        feedback_type?: 'favorite' | 'like';
      };
    };
  };
  const data = axiosErr?.response?.data;
  if (axiosErr?.response?.status !== 403 || !data) return null;
  if (data.code !== 'FAVORITE_LIMIT_REACHED' && data.code !== 'LIKE_LIMIT_REACHED') {
    return null;
  }
  const feedbackType: 'favorite' | 'like' = data.code === 'FAVORITE_LIMIT_REACHED' ? 'favorite' : 'like';
  return {
    feedbackType: data.feedback_type === 'like' || data.feedback_type === 'favorite'
      ? data.feedback_type
      : feedbackType,
    limit: typeof data.limit === 'number' ? data.limit : 0,
    currentCount: typeof data.current_count === 'number' ? data.current_count : 0,
  };
}

export function useFeedbackLimitModal() {
  const [state, setState] = useState<LimitState | null>(null);

  const handleError = useCallback((error: unknown): boolean => {
    const parsed = parseFeedbackLimitError(error);
    if (!parsed) return false;
    setState({ open: true, ...parsed });
    return true;
  }, []);

  const close = useCallback(() => {
    setState((prev) => (prev ? { ...prev, open: false } : prev));
  }, []);

  const modal = state ? (
    <FeedbackLimitReachedModal
      open={state.open}
      feedbackType={state.feedbackType}
      limit={state.limit}
      currentCount={state.currentCount}
      onClose={close}
    />
  ) : null;

  return { handleError, modal };
}

// Exported for unit tests; the hook above is the consumer-facing API.
export { parseFeedbackLimitError };
