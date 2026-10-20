import React, { forwardRef, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MousePointer2, Pencil } from 'lucide-react';

export type LightboxMode = 'select' | 'annotate';

interface LightboxModeSwitchProps {
  mode: LightboxMode;
  onChange: (mode: LightboxMode) => void;
  /** Annotate cannot start now: a video, a stand-in thumbnail, a comment on its way. */
  annotateDisabled: boolean;
}

const segmentClass = (active: boolean) =>
  `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    active ? 'bg-white text-black font-medium' : 'text-white hover:bg-white/15'
  }`;

/**
 * The lightbox bar's two modes (issue 1733): Select holds the proofing
 * actions, Annotate the drawing tools. A radio group, so the mode on is
 * announced, one Tab reaches it and the arrow keys move between the two.
 * The arrows are kept from the lightbox, where they would page the photo.
 */
export const LightboxModeSwitch = forwardRef<HTMLButtonElement, LightboxModeSwitchProps>(
  ({ mode, onChange, annotateDisabled }, selectRef) => {
    const { t } = useTranslation();
    const annotateRef = useRef<HTMLButtonElement>(null);

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const next: LightboxMode = mode === 'select' ? 'annotate' : 'select';
      if (next === 'annotate' && annotateDisabled) return;
      onChange(next);
      const target = next === 'annotate' ? annotateRef.current : (selectRef as React.RefObject<HTMLButtonElement>)?.current;
      target?.focus();
    };

    return (
      <div
        role="radiogroup"
        aria-label={t('feedback.annotation.modeLabel', 'Mode')}
        className="inline-flex items-center gap-0.5 rounded-full bg-white/10 p-1"
        onKeyDown={handleKeyDown}
      >
        <button
          ref={selectRef}
          type="button"
          role="radio"
          aria-checked={mode === 'select'}
          tabIndex={mode === 'select' ? 0 : -1}
          className={segmentClass(mode === 'select')}
          onClick={() => onChange('select')}
        >
          <MousePointer2 className="w-4 h-4" aria-hidden="true" />
          {t('feedback.annotation.modeSelect', 'Select')}
        </button>
        <button
          ref={annotateRef}
          type="button"
          role="radio"
          aria-checked={mode === 'annotate'}
          tabIndex={mode === 'annotate' ? 0 : -1}
          disabled={annotateDisabled && mode !== 'annotate'}
          className={segmentClass(mode === 'annotate')}
          onClick={() => onChange('annotate')}
        >
          <Pencil className="w-4 h-4" aria-hidden="true" />
          {t('feedback.annotation.modeAnnotate', 'Annotate')}
        </button>
      </div>
    );
  },
);
LightboxModeSwitch.displayName = 'LightboxModeSwitch';
