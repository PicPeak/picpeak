import React, { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthenticatedImage, Button } from '../common';

interface FocalPointPickerProps {
  imageUrl: string;
  currentValue: string;
  onChange: (value: string) => void;
  slug?: string;
}

/** Convert legacy keyword to percentage pair */
const keywordToPercent = (value: string): string => {
  switch (value) {
    case 'top': return '50% 0%';
    case 'center': return '50% 50%';
    case 'bottom': return '50% 100%';
    default: return value || '50% 50%';
  }
};

/** Parse an anchor value (keyword or "X% Y%") into [x, y] numbers 0-100 */
const parseAnchor = (value: string): [number, number] => {
  const pct = keywordToPercent(value);
  const match = pct.match(/^(\d{1,3})%\s+(\d{1,3})%$/);
  if (match) return [parseInt(match[1]), parseInt(match[2])];
  return [50, 50];
};

export const FocalPointPicker: React.FC<FocalPointPickerProps> = ({
  imageUrl,
  currentValue,
  onChange,
  slug,
}) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [x, y] = parseAnchor(currentValue);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = Math.round(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)));
      const py = Math.round(Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)));
      onChange(`${px}% ${py}%`);
    },
    [onChange],
  );

  const presets: { label: string; value: string }[] = [
    { label: t('events.heroImageAnchorTop', 'Top'), value: '50% 0%' },
    { label: t('events.heroImageAnchorCenter', 'Center'), value: '50% 50%' },
    { label: t('events.heroImageAnchorBottom', 'Bottom'), value: '50% 100%' },
  ];

  return (
    <div>
      {/* Clickable image preview */}
      <div
        ref={containerRef}
        onClick={handleClick}
        className="relative w-full h-48 rounded-lg overflow-hidden cursor-crosshair border border-neutral-300"
      >
        <AuthenticatedImage
          src={imageUrl}
          alt={t('events.heroPreview', 'Hero preview')}
          className="w-full h-full object-cover pointer-events-none"
          style={{ objectPosition: `${x}% ${y}%` }}
          slug={slug}
        />

        {/* Crosshair marker */}
        <div
          className="absolute pointer-events-none"
          style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}
        >
          {/* Outer ring (dark) for contrast on light areas */}
          <div className="w-6 h-6 rounded-full border-2 border-black/50" />
          {/* Inner ring (white) for contrast on dark areas */}
          <div className="absolute inset-0 m-px w-6 h-6 rounded-full border-2 border-white" />
          {/* Center dot */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-1.5 h-1.5 rounded-full bg-white shadow-sm" />
          </div>
        </div>

        {/* Coordinate label */}
        <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 text-[10px] font-mono leading-none text-white bg-black/60 rounded">
          {x}% {y}%
        </span>
      </div>

      {/* Preset buttons */}
      <div className="flex gap-2 mt-2">
        {presets.map((p) => (
          <Button
            key={p.value}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(p.value)}
            className={
              keywordToPercent(currentValue) === p.value
                ? 'bg-accent-dark/15 border-accent-dark/30 text-accent-dark'
                : ''
            }
          >
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  );
};

FocalPointPicker.displayName = 'FocalPointPicker';
