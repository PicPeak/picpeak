import React, { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

/**
 * Parse a free-typed time into canonical 24h "HH:MM", or null if
 * unparseable. Tolerant of: "13:00", "1300", "9:5", "9", "1:00 PM",
 * "1pm", "12 am". Lets the field accept input in whichever format it is
 * displaying (24h or 12h) and normalise it back to storage form.
 */
export const parseTimeToHHMM = (raw: string): string | null => {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let ampm: 'am' | 'pm' | null = null;
  let core = s;
  const am = s.match(/(a|p)\.?m?\.?\s*$/);
  if (am) {
    ampm = am[1] === 'p' ? 'pm' : 'am';
    core = s.slice(0, am.index).trim();
  }
  let h: number;
  let mi: number;
  const colon = core.match(/^(\d{1,2})\s*[:.]\s*(\d{1,2})$/);
  if (colon) {
    h = parseInt(colon[1], 10);
    mi = parseInt(colon[2], 10);
  } else {
    const digits = core.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length <= 2) { h = parseInt(digits, 10); mi = 0; }
    else if (digits.length === 3) { h = parseInt(digits.slice(0, 1), 10); mi = parseInt(digits.slice(1), 10); }
    else { h = parseInt(digits.slice(0, 2), 10); mi = parseInt(digits.slice(2, 4), 10); }
  }
  if (Number.isNaN(h) || Number.isNaN(mi)) return null;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  h = Math.min(23, Math.max(0, h));
  mi = Math.min(59, Math.max(0, mi));
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
};

interface TimeFieldProps {
  /** Canonical 24h "HH:MM" (or '' for empty). */
  value: string;
  /** Emits canonical 24h "HH:MM". */
  onChange: (v: string) => void;
  /** Optional label rendered above the field (matches the `Input` component). */
  label?: string;
  ariaLabel?: string;
  /** Tailwind width/extra classes for the input; defaults to w-full. */
  className?: string;
  disabled?: boolean;
}

/**
 * Time field that DISPLAYS in the admin's `general_time_format` (24h →
 * "13:00", 12h → "01:00 PM") but always stores/emits canonical 24h
 * "HH:MM". A plain text input, so the rendered format is identical in
 * EVERY browser — native <input type="time"> ignores our setting (its
 * 12h/24h chrome is browser-locale-controlled and Safari ignores the
 * `lang` hint). Free text while typing; parsed + reformatted on blur,
 * reverting to the last good value if unparseable.
 */
export const TimeField: React.FC<TimeFieldProps> = ({
  value, onChange, label, ariaLabel, className, disabled,
}) => {
  const { formatTime: fmtTime, timeFormat } = useLocalizedDate();
  const display = (v: string) => (/^\d{1,2}:\d{2}/.test(v) ? fmtTime(v) : (v || ''));
  const [text, setText] = useState(() => display(value));
  // Re-sync when the external value or the format setting changes.
  useEffect(() => { setText(display(value)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [value, timeFormat]);

  const commit = () => {
    const parsed = parseTimeToHHMM(text);
    if (parsed) {
      setText(display(parsed));
      if (parsed !== value) onChange(parsed);
    } else {
      setText(display(value));
    }
  };

  const input = (
    <input
      type="text"
      inputMode={timeFormat === '12h' ? 'text' : 'numeric'}
      aria-label={ariaLabel || label}
      placeholder={timeFormat === '12h' ? '1:00 PM' : 'HH:MM'}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      className={clsx('input', className || 'w-full')}
    />
  );

  if (!label) return input;
  return (
    <div className="w-full">
      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
        {label}
      </label>
      {input}
    </div>
  );
};
