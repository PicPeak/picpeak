import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  feedbackService,
  COLOR_LABELS,
  COLOR_LABEL_SWATCHES,
  type ColorLabel,
} from '../../services/feedback.service';
import { toast } from 'react-toastify';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';

interface PhotoColorLabelsProps {
  photoId: string;
  gallerySlug: string;
  /** The guest's current colour label, or null. */
  myColorLabel: ColorLabel | null;
  /** Per-colour visible counts, e.g. { green: 3 }. */
  colorLabelCounts?: Partial<Record<ColorLabel, number>>;
  isEnabled: boolean;
  requireNameEmail?: boolean;
  /** Keyboard hint to show under each swatch, e.g. { green: '1' }. */
  shortcutHints?: Partial<Record<ColorLabel, string>>;
  onColorLabelChange?: (label: ColorLabel | null) => void;
}

/**
 * Colour-label picker (#1044): one label per guest per photo, changeable —
 * tapping the current colour removes it, tapping another switches. Same
 * contract and identity handling as PhotoReactions; the labels are
 * Lightroom's five colours so a selection round-trips into the catalogue.
 */
export const PhotoColorLabels: React.FC<PhotoColorLabelsProps> = ({
  photoId,
  gallerySlug,
  myColorLabel,
  colorLabelCounts = {},
  isEnabled,
  requireNameEmail = false,
  shortcutHints = {},
  onColorLabelChange
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const [pendingColor, setPendingColor] = useState<ColorLabel | null>(null);

  const colorName = (color: ColorLabel) => t(`feedback.colorLabels.${color}`, color);

  const submitColorLabelMutation = useMutation({
    mutationFn: (data: { color: ColorLabel; guest_name?: string; guest_email?: string }) =>
      feedbackService.submitFeedback(gallerySlug, photoId, {
        feedback_type: 'color_label',
        color_label: data.color,
        guest_name: data.guest_name || undefined,
        guest_email: data.guest_email || undefined
      }),
    onMutate: async (data) => {
      setIsSubmitting(true);
      // Optimistic update: the same colour toggles off, another switches. The
      // PRE-mutation value travels via the mutation context — the onError
      // closure sees the post-optimistic render, so reading `myColorLabel`
      // there would "revert" to the already-wrong state.
      const previousColor = myColorLabel;
      if (onColorLabelChange) {
        onColorLabelChange(data.color === previousColor ? null : data.color);
      }
      return { previousColor };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['photo-feedback', gallerySlug, photoId] });
    },
    onError: (_error, _data, context) => {
      if (onColorLabelChange) {
        onColorLabelChange(context?.previousColor ?? null); // revert optimistic update
      }
      toast.error(t('feedback.colorLabelError', 'Failed to update color label'));
    },
    onSettled: () => {
      setIsSubmitting(false);
    }
  });

  const handleColorClick = async (color: ColorLabel) => {
    if (!isEnabled || isSubmitting) return;

    // Guest identity mode: ensure a per-person guest token; the server reads
    // name/email from the token — body values are ignored.
    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return; // user cancelled the prompt
      }
      submitColorLabelMutation.mutate({ color });
      return;
    }

    // Simple mode: legacy inline prompt flow.
    if (requireNameEmail && !savedIdentity) {
      setPendingColor(color);
      setShowIdentityModal(true);
    } else {
      submitColorLabelMutation.mutate({
        color,
        ...(savedIdentity ? { guest_name: savedIdentity.name, guest_email: savedIdentity.email } : {})
      });
    }
  };

  const handleIdentitySubmit = (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);
    if (pendingColor) {
      submitColorLabelMutation.mutate({ color: pendingColor, guest_name: name, guest_email: email });
      setPendingColor(null);
    }
  };

  if (!isEnabled) return null;

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={t('feedback.colorLabelsTitle', 'Color labels')}
      >
        {COLOR_LABELS.map((color) => {
          const count = colorLabelCounts[color] || 0;
          const isMine = myColorLabel === color;
          const swatch = COLOR_LABEL_SWATCHES[color];
          const shortcut = shortcutHints[color];
          return (
            <button
              key={color}
              type="button"
              onClick={() => handleColorClick(color)}
              disabled={isSubmitting}
              className={`flex items-center gap-1.5 pl-1.5 pr-2.5 py-1.5 rounded-full text-sm transition-all ${
                isMine
                  ? 'bg-primary-100 dark:bg-primary-900/40 ring-1 ring-primary-500 scale-105'
                  : 'bg-surface text-muted-theme hover:bg-black/10 hover:scale-105'
              } ${isSubmitting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
              aria-pressed={isMine}
              // The colour is the only visual difference between these five
              // buttons, so the name has to carry it for anyone who can't
              // distinguish them.
              aria-label={isMine
                ? t('feedback.removeColorLabel', 'Remove {{color}} label', { color: colorName(color) })
                : t('feedback.setColorLabel', 'Mark as {{color}}', { color: colorName(color) })}
              title={shortcut
                ? `${colorName(color)} (${shortcut})`
                : colorName(color)}
            >
              <span
                className="w-4 h-4 rounded-full border shrink-0"
                style={{ backgroundColor: swatch.fill, borderColor: swatch.ring }}
                aria-hidden="true"
              />
              {shortcut && (
                <span className="text-[10px] font-semibold opacity-70 leading-none" aria-hidden="true">
                  {shortcut}
                </span>
              )}
              {count > 0 && <span className="font-medium">{count}</span>}
            </button>
          );
        })}
      </div>
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingColor(null); }}
        onSubmit={handleIdentitySubmit}
        feedbackType={t('feedback.colorLabel', 'color label')}
      />
    </>
  );
};
