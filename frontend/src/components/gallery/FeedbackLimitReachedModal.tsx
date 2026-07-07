import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Heart, Bookmark, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Per-guest cap modal (#655). Shown when the guest clicks the heart or
 * thumbs-up on a photo that would exceed the per-event cap set by the
 * photographer. Mobile-first responsive: full-width card with safe inset
 * on phones, 420px centered card on desktop. High z-index because the
 * lightbox sits at z-50; we render above at z-[60].
 *
 * Single OK button rather than confirm/cancel — this is an
 * acknowledgement, not a decision. Backdrop click + Escape both dismiss
 * for users who want to recover quickly.
 */
export interface FeedbackLimitReachedModalProps {
  open: boolean;
  feedbackType: 'favorite' | 'like';
  limit: number;
  currentCount: number;
  onClose: () => void;
}

export const FeedbackLimitReachedModal: React.FC<FeedbackLimitReachedModalProps> = ({
  open,
  feedbackType,
  limit,
  currentCount,
  onClose,
}) => {
  const { t } = useTranslation();
  const okButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the OK button so keyboard / screen-reader users can dismiss
    // straight away with Enter or Space.
    okButtonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const isFavorite = feedbackType === 'favorite';
  const Icon = isFavorite ? Bookmark : Heart;
  const title = isFavorite
    ? t('feedback.limit.favoriteTitle', 'Favorite limit reached')
    : t('feedback.limit.likeTitle', 'Like limit reached');
  const body = isFavorite
    ? t(
      'feedback.limit.favoriteBody',
      'You can favorite up to {{limit}} photos in this gallery. Remove one to add a new one.',
      { limit },
    )
    : t(
      'feedback.limit.likeBody',
      'You can like up to {{limit}} photos in this gallery. Remove one to add a new one.',
      { limit },
    );

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-limit-title"
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-3 sm:p-4 bg-black/60"
      onClick={(e) => {
        // Backdrop click only — don't dismiss when clicking inside the card.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="
          w-full sm:max-w-md
          bg-white dark:bg-neutral-900
          rounded-2xl sm:rounded-xl
          shadow-2xl
          border border-neutral-200 dark:border-neutral-700
          overflow-hidden
          animate-[slide-up_0.2s_ease-out]
          pb-[env(safe-area-inset-bottom)]
        "
      >
        {/* Header */}
        <div className="flex items-start gap-3 p-5 sm:p-6">
          <div
            className={`
              flex-shrink-0 w-11 h-11 sm:w-12 sm:h-12 rounded-full
              flex items-center justify-center
              ${isFavorite ? 'bg-amber-100 dark:bg-amber-900/40' : 'bg-rose-100 dark:bg-rose-900/40'}
            `}
          >
            <Icon
              className={`w-6 h-6 ${isFavorite ? 'text-amber-600 dark:text-amber-300' : 'text-rose-600 dark:text-rose-300'}`}
              aria-hidden="true"
            />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="feedback-limit-title"
              className="text-base sm:text-lg font-semibold text-neutral-900 dark:text-neutral-100"
            >
              {title}
            </h2>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300 leading-relaxed">
              {body}
            </p>
            <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded-full px-3 py-1">
              {t('feedback.limit.counter', '{{current}} of {{limit}} used', {
                current: currentCount,
                limit,
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 rounded transition-colors"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Footer */}
        <div className="px-5 sm:px-6 pb-5 sm:pb-6 flex justify-end">
          <button
            ref={okButtonRef}
            type="button"
            onClick={onClose}
            className="
              w-full sm:w-auto px-5 py-2.5 rounded-lg text-sm font-medium
              bg-accent-dark text-white hover:opacity-90
              focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-dark focus-visible:ring-offset-2
              transition-opacity
            "
          >
            {t('feedback.limit.ok', 'Got it')}
          </button>
        </div>
      </div>
    </div>
  );

  // Portal to body so the modal escapes any lightbox / sticky parent stacking
  // context and reliably sits above everything else.
  return createPortal(node, document.body);
};
