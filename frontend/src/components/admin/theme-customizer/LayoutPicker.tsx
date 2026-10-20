import React, { useId } from 'react';
import { Check } from 'lucide-react';
import { radioGroupKeyDown } from '../../../utils/ariaKeyboard';

export interface LayoutPickerOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  /** A short tag after the name ("Beta"). */
  tag?: string;
  /** The layout's wireframe, drawn in currentColor (layoutWireframes.tsx). */
  wireframe: React.ReactNode;
}

interface LayoutPickerProps<T extends string> {
  options: LayoutPickerOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Smaller tiles without the description (the theme editor's preview row). */
  compact?: boolean;
}

/**
 * A pick-one of layouts as wireframe tiles (issue 1733, section E): a radio
 * group of buttons, as in UX.md › Forms. The arrow keys move and pick, Tab
 * enters the group once at the chosen tile. The chosen tile is the
 * `.tile-selected` fill plus a check mark, not the colour alone. The tiles
 * wrap to the width they get.
 */
export function LayoutPicker<T extends string>({
  options,
  value,
  onChange,
  compact = false,
  ...aria
}: LayoutPickerProps<T>) {
  // With no option matching the value, the first tile takes the Tab stop.
  const hasChecked = options.some((option) => option.value === value);
  // The name is the label (and tag); the description is read after it.
  const baseId = useId();

  return (
    <div
      role="radiogroup"
      {...aria}
      onKeyDown={radioGroupKeyDown}
      className={`grid gap-3 ${compact
        ? 'grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]'
        : 'grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]'}`}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const labelId = `${baseId}-${index}-label`;
        const descriptionId = `${baseId}-${index}-description`;
        const showDescription = !compact && Boolean(option.description);
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={labelId}
            aria-describedby={showDescription ? descriptionId : undefined}
            tabIndex={checked || (!hasChecked && index === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`flex flex-col gap-2 text-left rounded-lg border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel ${compact ? 'p-2' : 'p-3'} ${
              checked ? 'tile-selected' : 'border-line hover:border-line-strong bg-panel text-soft'
            }`}
          >
            <span className={`block w-full rounded-md p-1 ${checked ? '' : 'bg-inset'}`}>
              {option.wireframe}
            </span>
            <span className="flex w-full items-start justify-between gap-1">
              <span id={labelId} className={`min-w-0 font-medium text-heading ${compact ? 'text-xs' : 'text-sm'}`}>
                {option.label}
                {option.tag && <>{' '}<span className="text-xs font-normal text-warning-text">{option.tag}</span></>}
              </span>
              {checked && <Check className="w-4 h-4 flex-shrink-0" aria-hidden="true" />}
            </span>
            {showDescription && (
              <span id={descriptionId} className="text-xs text-soft">{option.description}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
