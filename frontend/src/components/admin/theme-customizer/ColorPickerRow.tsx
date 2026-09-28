import React from 'react';
import { Info } from 'lucide-react';
import { Input } from '../../common';

/**
 * Compact color-picker row used by the 8-token palette.
 * Renders [Label + Info icon (tooltip)] / [color swatch + hex input].
 * Help text is hidden in the static layout (lives on the Info icon's title
 * attribute) so all rows are the same height — keeps the four Surfaces
 * pickers and the two Accent pickers grid-aligned without forcing the user
 * to read every help string up front.
 */
export const ColorPickerRow: React.FC<{
  label: string;
  help: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}> = ({ label, help, value, fallback, onChange }) => (
  <div>
    <label className="flex items-center gap-1.5 text-sm font-medium text-body mb-2">
      {label}
      <span
        className="info-tooltip text-faint"
        data-tooltip={help}
        tabIndex={0}
      >
        <Info className="w-3.5 h-3.5" />
      </span>
    </label>
    <div className="flex gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-20 rounded border border-line-strong cursor-pointer"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fallback}
        className="flex-1"
      />
    </div>
  </div>
);
