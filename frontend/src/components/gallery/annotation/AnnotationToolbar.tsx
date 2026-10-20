import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, MoveUpRight, Pencil, Trash2, Undo2, X } from 'lucide-react';
import { ANNOTATION_MAX_STROKES, ANNOTATION_PALETTE } from '../../../utils/photoAnnotation';
import type { LightboxAnnotation } from './useLightboxAnnotation';

interface AnnotationToolbarProps {
  annotation: LightboxAnnotation;
}

const buttonClass = 'p-2 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const toolClass = (active: boolean) => `${buttonClass} ${active ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20 text-white'}`;

/**
 * The drawing controls (issue 1733): the lightbox bar's Annotate mode. They
 * take the place of zoom, download and the proofing buttons, which are
 * suspended while the photo is being drawn on.
 */
export const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({ annotation }) => {
  const { t } = useTranslation();
  const empty = annotation.strokes.length === 0;

  return (
    <div
      role="toolbar"
      aria-label={t('feedback.annotation.toolbar', 'Drawing tools')}
      className="ml-auto flex items-center justify-end gap-x-3 gap-y-2 flex-wrap"
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={toolClass(annotation.tool === 'free')}
          aria-pressed={annotation.tool === 'free'}
          aria-label={t('feedback.annotation.toolFree', 'Freehand')}
          title={t('feedback.annotation.toolFree', 'Freehand')}
          onClick={() => annotation.setTool('free')}
        >
          <Pencil className="w-5 h-5" />
        </button>
        <button
          type="button"
          className={toolClass(annotation.tool === 'arrow')}
          aria-pressed={annotation.tool === 'arrow'}
          aria-label={t('feedback.annotation.toolArrow', 'Arrow')}
          title={t('feedback.annotation.toolArrow', 'Arrow')}
          onClick={() => annotation.setTool('arrow')}
        >
          <MoveUpRight className="w-5 h-5" />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {ANNOTATION_PALETTE.map((hex, index) => (
          <button
            key={hex}
            type="button"
            aria-pressed={annotation.color === index}
            aria-label={t('feedback.annotation.color', { number: index + 1, defaultValue: 'Colour {{number}}' })}
            onClick={() => annotation.setColor(index)}
            className={`w-7 h-7 rounded-full border border-white/60 ${annotation.color === index ? 'ring-2 ring-white ring-offset-2 ring-offset-black' : ''}`}
            style={{ backgroundColor: hex }}
          />
        ))}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className={`${buttonClass} bg-white/10 hover:bg-white/20 text-white`}
          disabled={empty}
          aria-label={t('feedback.annotation.undo', 'Undo')}
          title={t('feedback.annotation.undo', 'Undo')}
          onClick={annotation.undo}
        >
          <Undo2 className="w-5 h-5" />
        </button>
        <button
          type="button"
          className={`${buttonClass} bg-white/10 hover:bg-white/20 text-white`}
          disabled={empty}
          aria-label={t('feedback.annotation.clear', 'Clear')}
          title={t('feedback.annotation.clear', 'Clear')}
          onClick={annotation.clear}
        >
          <Trash2 className="w-5 h-5" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm transition-colors"
          onClick={annotation.cancel}
        >
          <X className="w-4 h-4" />
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-white text-black hover:bg-white/90 text-sm font-medium transition-colors"
          onClick={annotation.done}
        >
          <Check className="w-4 h-4" />
          {t('feedback.annotation.done', 'Done')}
        </button>
      </div>

      {annotation.atLimit && (
        <p className="w-full text-center text-xs text-white/75" role="status">
          {t('feedback.annotation.limitReached', {
            max: ANNOTATION_MAX_STROKES,
            defaultValue: 'A drawing can have up to {{max}} strokes.',
          })}
        </p>
      )}
    </div>
  );
};
