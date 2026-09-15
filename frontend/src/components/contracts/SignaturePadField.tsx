/**
 * A signature canvas (signature_pad) with a Clear button.
 *
 * - The drawing buffer is sized to the canvas's CSS size × devicePixelRatio
 *   so strokes stay crisp on HiDPI screens, and re-sized on window resize
 *   (rotating a phone) — which clears the pad, as signature_pad expects.
 * - `toDataUrl()` exports a PNG downscaled to MAX_SIGNATURE_WIDTH, so a 4×
 *   retina canvas doesn't produce a multi-MB image that trips the server's
 *   SIGNATURE_TOO_LARGE cap.
 *
 * Read it through a ref: `ref.current.isEmpty()`, `.clear()`, `.toDataUrl()`.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import SignaturePad from 'signature_pad';
import { RotateCcw } from 'lucide-react';

/**
 * Maximum width of the exported signature PNG. 800 px is wide enough to
 * render the signature legibly when stamped onto the contract PDF
 * (printed at 4 inches × 200 dpi).
 */
export const MAX_SIGNATURE_WIDTH = 800;

/** Export the canvas as a PNG data URL no wider than MAX_SIGNATURE_WIDTH. */
export function downscaleSignature(pad: SignaturePad, sourceCanvas: HTMLCanvasElement): string {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  if (srcW <= MAX_SIGNATURE_WIDTH) {
    return pad.toDataURL('image/png');
  }
  const scale = MAX_SIGNATURE_WIDTH / srcW;
  const targetW = MAX_SIGNATURE_WIDTH;
  const targetH = Math.round(srcH * scale);
  const dst = document.createElement('canvas');
  dst.width = targetW;
  dst.height = targetH;
  const ctx = dst.getContext('2d');
  if (!ctx) return pad.toDataURL('image/png');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, srcW, srcH, 0, 0, targetW, targetH);
  return dst.toDataURL('image/png');
}

export interface SignaturePadHandle {
  isEmpty: () => boolean;
  clear: () => void;
  /** The drawn signature as a downscaled PNG, or null when nothing is drawn. */
  toDataUrl: () => string | null;
}

interface SignaturePadFieldProps {
  /** Accessible name for the drawing area. */
  label: string;
  /** Tailwind height class for the canvas. */
  heightClassName?: string;
  /** Called after each stroke and on clear, with whether the pad is empty. */
  onChange?: (isEmpty: boolean) => void;
  className?: string;
}

export const SignaturePadField = forwardRef<SignaturePadHandle, SignaturePadFieldProps>(
  ({ label, heightClassName = 'h-32', onChange, className }, ref) => {
    const { t } = useTranslation();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const padRef = useRef<SignaturePad | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      const pad = new SignaturePad(canvas, {
        penColor: '#111',
        backgroundColor: 'rgba(255, 255, 255, 0)',
      });
      padRef.current = pad;
      const resize = () => {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        canvas.getContext('2d')?.scale(ratio, ratio);
        pad.clear(); // a resized canvas has lost its drawing
        onChangeRef.current?.(true);
      };
      const handleStroke = () => onChangeRef.current?.(pad.isEmpty());
      resize();
      pad.addEventListener('endStroke', handleStroke);
      window.addEventListener('resize', resize);
      return () => {
        window.removeEventListener('resize', resize);
        pad.removeEventListener('endStroke', handleStroke);
        pad.off();
        padRef.current = null;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      isEmpty: () => !padRef.current || padRef.current.isEmpty(),
      clear: () => {
        padRef.current?.clear();
        onChangeRef.current?.(true);
      },
      toDataUrl: () => {
        const pad = padRef.current;
        const canvas = canvasRef.current;
        if (!pad || !canvas || pad.isEmpty()) return null;
        return downscaleSignature(pad, canvas);
      },
    }), []);

    return (
      <div className={className}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={label}
          className={`w-full ${heightClassName} bg-white rounded border border-neutral-300 dark:border-neutral-600 touch-none`}
        />
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => {
              padRef.current?.clear();
              onChangeRef.current?.(true);
            }}
            className="text-xs text-neutral-600 dark:text-neutral-400 hover:underline inline-flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" />
            {t('publicContract.clearSignature', 'Clear')}
          </button>
        </div>
      </div>
    );
  },
);

SignaturePadField.displayName = 'SignaturePadField';
