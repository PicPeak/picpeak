import { useEffect, useRef, useState } from 'react';
import { parseLocaleDecimal } from '../../utils/parsers';

/**
 * DecimalInput — controlled text input that accepts both '.' and ','
 * as the decimal separator. Bubbles a parsed `number` up via
 * `onChange`, but keeps the raw typed string in local state so the
 * user can see their own keystrokes (German "12,5" stays "12,5"
 * during editing instead of being instantly reformatted to "12.5").
 *
 * Why not `type="number"`?  Chrome/Firefox `<input type=number>` reject
 * comma input on non-DE document.lang and round-trip everything
 * through `parseFloat`, which silently truncates "12,50" to 12. The
 * audit found this eating real money on monthly bills typed by the
 * operator in German. Switching to `type="text"` plus
 * `inputMode="decimal"` keeps the mobile keypad and re-routes parsing
 * through the locale-tolerant helper.
 *
 * Value-prop sync: the parent owns the canonical number. When the
 * parent pushes a value that disagrees with what's in our local text
 * (after parsing the local text back to a number), we reformat. This
 * lets external updates (preset selection, autocompute) reflect in
 * the field while still preserving the user's in-progress typing.
 */
export interface DecimalInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> {
  /** Canonical numeric value. May be NaN when the field is empty. */
  value: number;
  /** Bubbled on every parseable keystroke. Receives NaN when the input is cleared. */
  onChange: (next: number) => void;
  /**
   * Number of fraction digits to display when reformatting from a
   * parent-pushed value. Defaults to undefined which uses the
   * platform default (`Number.prototype.toString`).
   */
  fractionDigits?: number;
  /** Optional formatter override — receives the number, returns the display string. */
  formatValue?: (value: number) => string;
}

function defaultFormat(value: number, fractionDigits?: number): string {
  if (!Number.isFinite(value)) return '';
  if (fractionDigits !== undefined) return value.toFixed(fractionDigits);
  return String(value);
}

export function DecimalInput({
  value,
  onChange,
  fractionDigits,
  formatValue,
  ...rest
}: DecimalInputProps) {
  const fmt = (v: number) => (formatValue ? formatValue(v) : defaultFormat(v, fractionDigits));
  const [text, setText] = useState<string>(() => fmt(value));
  const lastEmittedRef = useRef<number>(value);

  // Sync from the parent when the externally-owned value disagrees
  // with our locally-buffered text. We compare on the parsed number,
  // not the string, so the user typing "12," doesn't snap back to
  // "12" just because the parent saw 12 from the last keystroke.
  useEffect(() => {
    const parsed = parseLocaleDecimal(text);
    const matchesParsed = Number.isFinite(parsed) && parsed === value;
    const bothEmpty = text === '' && !Number.isFinite(value);
    if (!matchesParsed && !bothEmpty && value !== lastEmittedRef.current) {
      setText(fmt(value));
    }
    lastEmittedRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        // Empty field → propagate NaN so the parent can decide
        // whether to coerce to 0 or treat as "unset".
        if (raw.trim() === '') {
          lastEmittedRef.current = NaN;
          onChange(NaN);
          return;
        }
        const parsed = parseLocaleDecimal(raw);
        if (Number.isFinite(parsed)) {
          lastEmittedRef.current = parsed;
          onChange(parsed);
        }
        // Unparseable intermediate state (e.g. "12,") — keep the
        // text but don't emit. The next keystroke usually completes
        // the number and triggers a valid emit.
      }}
      onBlur={(e) => {
        // Reformat on blur so the resting state shows the canonical
        // form. Empty stays empty.
        const parsed = parseLocaleDecimal(e.target.value);
        if (Number.isFinite(parsed)) {
          setText(fmt(parsed));
        }
        rest.onBlur?.(e);
      }}
      {...rest}
    />
  );
}
