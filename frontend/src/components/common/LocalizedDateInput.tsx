import React from 'react';
import { clsx } from 'clsx';
import { Calendar } from 'lucide-react';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

/**
 * Date input that displays + accepts values in the admin-configured
 * format from Settings → General (`general_date_format`), independent
 * of the browser locale. Stores + emits ISO (YYYY-MM-DD) so the rest
 * of the form / API surface keeps the canonical shape.
 *
 * A native `<input type="date">` always renders in the browser's own
 * locale (en-US users see MM/DD/YYYY) no matter what the app is
 * configured for, so it can't be used directly. This component shows
 * a plain text input in the configured format and parses on blur. A
 * calendar icon button opens the native date picker (via showPicker())
 * off a visually-hidden native input, giving the click-to-pick
 * affordance without rendering a second visible date box.
 */
interface LocalizedDateInputProps {
  label?: string;
  value: string;
  onChange: (iso: string) => void;
  error?: string;
  /** Forwarded to the native picker so min/max date constraints work. */
  min?: string;
  max?: string;
  disabled?: boolean;
}

export const LocalizedDateInput: React.FC<LocalizedDateInputProps> = ({
  label,
  value,
  onChange,
  error,
  min,
  max,
  disabled,
}) => {
  const { dateFormat } = useLocalizedDate();
  const nativeRef = React.useRef<HTMLInputElement>(null);
  const inputId = React.useId();

  // Normalise the configured format down to the four shapes the parser
  // understands. Defaults to DD.MM.YYYY (the operator's primary locale)
  // when unknown.
  const normalisedFormat = ((): 'DD.MM.YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' => {
    const f = String(dateFormat || 'dd.MM.yyyy').toLowerCase();
    if (f.startsWith('mm/dd')) return 'MM/DD/YYYY';
    if (f.startsWith('yyyy')) return 'YYYY-MM-DD';
    if (f.includes('/')) return 'DD/MM/YYYY';
    return 'DD.MM.YYYY';
  })();
  const placeholder = normalisedFormat.toLowerCase();

  // ISO → display. NOTE: no `$` anchor — Postgres serialises DATE columns
  // as a full ISO datetime ("2026-04-06T00:00:00.000Z"), so we match the
  // leading yyyy-MM-dd and ignore any trailing time. (SQLite returns the
  // bare date string, which also matches.) Coerced to String in case a
  // Date object slips through. Without this the field rendered the raw
  // ISO timestamp on pg — see feedback_pg_date_columns_serialize.
  const toDisplay = (iso: string): string => {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return String(iso);
    const [, y, mo, d] = m;
    switch (normalisedFormat) {
      case 'MM/DD/YYYY': return `${mo}/${d}/${y}`;
      case 'YYYY-MM-DD': return `${y}-${mo}-${d}`;
      case 'DD/MM/YYYY': return `${d}/${mo}/${y}`;
      case 'DD.MM.YYYY':
      default: return `${d}.${mo}.${y}`;
    }
  };

  // display → ISO (accepts variant separators leniently)
  const toIso = (raw: string): string => {
    const s = raw.trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const parts = s.split(/[./-]/);
    if (parts.length !== 3) return '';
    const [a, b, c] = parts;
    let y: string, mo: string, d: string;
    if (normalisedFormat === 'YYYY-MM-DD' || a.length === 4) {
      [y, mo, d] = [a, b, c];
    } else if (normalisedFormat === 'MM/DD/YYYY') {
      [mo, d, y] = [a, b, c];
    } else {
      [d, mo, y] = [a, b, c];
    }
    if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(mo) || !/^\d{4}$/.test(y)) return '';
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  };

  const [text, setText] = React.useState(toDisplay(value));
  React.useEffect(() => {
    setText(toDisplay(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const openPicker = () => {
    const el = nativeRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      // showPicker throws on unsupported browsers / outside a user
      // gesture — the text field stays fully usable for typing.
    }
  };

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            // Commit live as soon as a complete, valid date is typed —
            // don't wait for blur. Otherwise a value entered then submitted
            // without blurring (or before React re-renders after the
            // blur-time setState) is lost and the parent keeps its previous
            // value (e.g. the import form's "today" default). toIso returns
            // '' for partial/invalid input, so intermediate keystrokes emit
            // nothing.
            const iso = toIso(next);
            if (iso) onChange(iso);
          }}
          onBlur={() => {
            const iso = toIso(text);
            if (iso) {
              onChange(iso);
              setText(toDisplay(iso));
            } else if (!text.trim()) {
              onChange('');
            }
          }}
          className={clsx('input pr-10', error && 'border-red-500 focus-visible:ring-red-500')}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? `${inputId}-error` : undefined}
        />
        <button
          type="button"
          onClick={openPicker}
          disabled={disabled}
          tabIndex={-1}
          aria-label={label}
          className="absolute inset-y-0 right-0 pr-3 flex items-center text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-50"
        >
          <Calendar className="w-5 h-5" />
        </button>
        {/* Visually hidden native picker — its only job is to provide
            the calendar popup the icon button triggers. Value stays in
            ISO so it's always parseable. */}
        <input
          ref={nativeRef}
          type="date"
          // Bare yyyy-MM-dd — a native date input rejects a full ISO
          // datetime (pg serialisation), which would blank the picker.
          value={value ? String(value).slice(0, 10) : ''}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />
      </div>
      {error && (
        <p id={`${inputId}-error`} className="mt-1.5 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
};
