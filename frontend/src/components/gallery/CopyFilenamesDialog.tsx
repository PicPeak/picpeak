import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, X } from 'lucide-react';

import { Button } from '../common';
import type { Photo } from '../../types';
import { joinFilenameStems, type FilenameListSeparator } from '../../utils/photoFilename';
import { useGalleryDialog } from './hooks/useGalleryDialog';

/**
 * Copyable filename list for guests (issue 1733, backlog item A3d).
 *
 * The photographer has the TXT export on the admin side; this is the guest's
 * counterpart: the stems of the selected (or favourited) photos on one line,
 * ready for the filename search of a RAW editor. Frontend only — the list is
 * built from the photos already on screen.
 */

interface CopyFilenamesDialogProps {
  photos: ReadonlyArray<Pick<Photo, 'filename' | 'original_filename'>>;
  /** Where the photos came from, for the count line. */
  source: 'selection' | 'favorites';
  onClose: () => void;
}

export const CopyFilenamesDialog: React.FC<CopyFilenamesDialogProps> = ({ photos, source, onClose }) => {
  const { t } = useTranslation();
  // Comma first: that is what the admin export produces and what Lightroom's
  // filename search takes.
  const [separator, setSeparator] = useState<FilenameListSeparator>('comma');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const text = useMemo(() => joinFilenameStems(photos, separator), [photos, separator]);

  const panelRef = useRef<HTMLDivElement>(null);
  useGalleryDialog({ open: true, onClose, panelRef });

  const selectText = () => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  };

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      // Older Safari and hardened sandboxes reject clipboard writes: leave
      // the text selected so Cmd/Ctrl+C finishes the job.
      selectText();
      setCopyState('failed');
    }
  };

  const title = t('gallery.copyFilenames.title', 'Copy filenames');

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card-themed text-theme p-6 max-w-md w-full"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-lg font-semibold text-theme">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="text-muted-theme hover:text-theme"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-theme mb-1" data-testid="copy-filenames-count">
          {source === 'selection'
            ? t('gallery.copyFilenames.selectedCount', 'Selected photos: {{count}}', { count: photos.length })
            : t('gallery.copyFilenames.favoritesCount', 'Favorited photos: {{count}}', { count: photos.length })}
        </p>
        <p className="text-xs text-muted-theme mb-4">
          {t('gallery.copyFilenames.hint', 'Paste the list into the filename search of your RAW editor. Extensions are left off so it also matches the RAW files.')}
        </p>

        <textarea
          ref={textareaRef}
          readOnly
          value={text}
          onFocus={selectText}
          rows={5}
          aria-label={title}
          className="w-full p-3 rounded-lg border border-border-token bg-elevated text-theme font-mono text-xs break-all resize-y focus:outline-none focus:ring-2 focus:ring-accent"
        />

        <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2" role="group" aria-label={t('gallery.copyFilenames.separator', 'Separator')}>
            <Button
              variant={separator === 'comma' ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={separator === 'comma'}
              onClick={() => { setSeparator('comma'); setCopyState('idle'); }}
            >
              {t('gallery.copyFilenames.separatorComma', 'Comma')}
            </Button>
            <Button
              variant={separator === 'space' ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={separator === 'space'}
              onClick={() => { setSeparator('space'); setCopyState('idle'); }}
            >
              {t('gallery.copyFilenames.separatorSpace', 'Space')}
            </Button>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleCopy}
            leftIcon={copyState === 'copied' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          >
            {copyState === 'copied'
              ? t('gallery.copyFilenames.copied', 'Copied')
              : t('gallery.copyFilenames.copy', 'Copy')}
          </Button>
        </div>
        {copyState === 'failed' && (
          <p className="mt-3 text-xs text-status hue-danger" role="alert">
            {t('gallery.copyFilenames.copyFailed', 'Copying was blocked. The text is selected, press Ctrl+C or Cmd+C to copy it.')}
          </p>
        )}
      </div>
    </div>
  );
};
