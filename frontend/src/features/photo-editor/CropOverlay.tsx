import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MIN_CROP, type CropRect } from './editMath';

interface CropOverlayProps {
  /** The crop as rendered (the one asked for, shrunk onto a straightened photo), fractions of the frame; drags start from it. */
  effective: CropRect;
  /** width / height of the crop in frame fractions that keeps the chosen aspect, or null for free. */
  aspect: number | null;
  onChange: (crop: CropRect) => void;
}

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Drag the crop's edges, corners or middle; with an aspect the corners keep it. */
export function dragCrop(start: CropRect, handle: Handle, dx: number, dy: number, aspect: number | null): CropRect {
  if (handle === 'move') {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  }
  let { x, y, w, h } = start;
  const right = x + w;
  const bottom = y + h;
  if (handle.includes('w')) { x = clamp(x + dx, 0, right - MIN_CROP); w = right - x; }
  if (handle.includes('e')) { w = clamp(w + dx, MIN_CROP, 1 - x); }
  if (handle.includes('n')) { y = clamp(y + dy, 0, bottom - MIN_CROP); h = bottom - y; }
  if (handle.includes('s')) { h = clamp(h + dy, MIN_CROP, 1 - y); }
  if (aspect) {
    // Width leads on a side handle that moves it, height otherwise; the
    // other follows. The box is cut back to the room the frame leaves on
    // the side it grows to, measured from the edges that stay, and only then
    // placed against them: placed first, it could start outside the frame.
    if (handle === 'n' || handle === 's') w = h * aspect; else h = w / aspect;
    const roomW = handle.includes('w') ? right : 1 - x;
    const roomH = handle.includes('n') ? bottom : 1 - y;
    if (w > roomW) { w = roomW; h = w / aspect; }
    if (h > roomH) { h = roomH; w = h * aspect; }
    if (handle.includes('w')) x = right - w;
    if (handle.includes('n')) y = bottom - h;
  }
  return { x, y, w, h };
}

/** The crop frame drawn over the turned photo in crop mode (issue 2619). */
export const CropOverlay: React.FC<CropOverlayProps> = ({ effective, aspect, onChange }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const start = (handle: Handle) => (event: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY };
    // From the frame as drawn: on a straightened photo the crop asked for
    // (or the whole frame, with none) is shrunk to what renders, and a drag
    // from the larger rectangle would have no room to move.
    const from = effective;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      onChange(dragCrop(from, handle, (e.clientX - origin.x) / box.width, (e.clientY - origin.y) / box.height, aspect));
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };
  const pct = (v: number) => `${v * 100}%`;
  const handlePos: Record<Handle, React.CSSProperties> = {
    move: {}, nw: { left: 0, top: 0 }, n: { left: '50%', top: 0 }, ne: { left: '100%', top: 0 }, e: { left: '100%', top: '50%' },
    se: { left: '100%', top: '100%' }, s: { left: '50%', top: '100%' }, sw: { left: 0, top: '100%' }, w: { left: 0, top: '50%' },
  };
  return (
    <div ref={ref} className="absolute inset-0 z-10 select-none touch-none" data-testid="crop-overlay">
      {/* Outside the rendered crop: dimmed, four bands around it. */}
      {[
        { left: 0, top: 0, width: '100%', height: pct(effective.y) },
        { left: 0, top: pct(effective.y + effective.h), width: '100%', height: pct(1 - effective.y - effective.h) },
        { left: 0, top: pct(effective.y), width: pct(effective.x), height: pct(effective.h) },
        { left: pct(effective.x + effective.w), top: pct(effective.y), width: pct(1 - effective.x - effective.w), height: pct(effective.h) },
      ].map((band, i) => (
        <div key={i} className="absolute pointer-events-none" style={{ ...band, background: "rgba(0, 0, 0, 0.55)" }} />
      ))}
      <div
        role="group"
        aria-label={t('photoEditor.crop.frame', 'Crop frame')}
        className="absolute border border-white/90 cursor-move"
        style={{ left: pct(effective.x), top: pct(effective.y), width: pct(effective.w), height: pct(effective.h) }}
        onPointerDown={start('move')}
      >
        {/* Rule of thirds. */}
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: 'linear-gradient(to right, transparent 33.1%, rgba(255,255,255,0.45) 33.3%, transparent 33.5%, transparent 66.5%, rgba(255,255,255,0.45) 66.7%, transparent 66.9%), linear-gradient(to bottom, transparent 33.1%, rgba(255,255,255,0.45) 33.3%, transparent 33.5%, transparent 66.5%, rgba(255,255,255,0.45) 66.7%, transparent 66.9%)',
        }}
        />
        {HANDLES.map((handle) => (
          <div
            key={handle}
            data-handle={handle}
            onPointerDown={start(handle)}
            className="absolute w-4 h-4 -ml-2 -mt-2 bg-white rounded-sm shadow"
            style={{ ...handlePos[handle], cursor: `${handle}-resize` }}
          />
        ))}
      </div>
    </div>
  );
};
