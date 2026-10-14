import React from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { DateCalendar } from './DateCalendar';
import { useEscapeClose } from './useEscapeClose';
import { isImeComposing } from '../../utils/imeComposition';

/**
 * Date input that displays + accepts values in the admin-configured
 * format from Settings → General (`general_date_format`), independent
 * of the browser locale. Stores + emits ISO (YYYY-MM-DD) so the rest
 * of the form / API surface keeps the canonical shape.
 *
 * A native `<input type="date">` always renders in the browser's own
 * locale (en-US users see MM/DD/YYYY) no matter what the app is
 * configured for, so it can't be used directly. This component shows
 * a plain text input in the configured format and parses on blur. The
 * calendar icon opens the app's own `DateCalendar` in a popover, portalled
 * to <body> so a dialog's scrolling body does not clip it. (It used to
 * call showPicker() on a hidden native date input, which Safari does not
 * open reliably.)
 */
interface LocalizedDateInputProps {
  label?: string;
  value: string;
  onChange: (iso: string) => void;
  error?: string;
  /** Hint rendered below the field, hidden while an error is showing. */
  helperText?: string;
  /** Earliest / latest day the calendar offers (ISO yyyy-MM-dd). */
  min?: string;
  max?: string;
  disabled?: boolean;
  /** Accessible name when the visible label sits outside the component. */
  ariaLabel?: string;
}

export const LocalizedDateInput: React.FC<LocalizedDateInputProps> = ({
  label,
  value,
  onChange,
  error,
  helperText,
  min,
  max,
  disabled,
  ariaLabel,
}) => {
  const { t } = useTranslation();
  const { dateFormat, locale } = useLocalizedDate();
  const inputId = React.useId();
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<React.CSSProperties>({});

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
    // Reject impossible calendar dates (day 00, month 13, 31 Feb…) — a partial
    // value mid-backspace like "0/07/2026" is otherwise coerced to "2026-07-00",
    // which is a valid string but an Invalid Date that crashes date-fns format()
    // downstream. Round-trip through Date to confirm the components survive.
    const yy = Number(y), mm = Number(mo), dd = Number(d);
    const probe = new Date(yy, mm - 1, dd);
    if (probe.getFullYear() !== yy || probe.getMonth() !== mm - 1 || probe.getDate() !== dd) return '';
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  };

  const isComplete = (raw: string) => /^(\d{2}[./-]\d{2}[./-]\d{4}|\d{4}-\d{2}-\d{2})$/.test(raw.trim());

  const [text, setText] = React.useState(toDisplay(value));
  // Follow a value set from outside (the calendar, a reset, another field),
  // but leave the text alone when it already means that value: the value is
  // our own live commit coming back, and reformatting it mid-edit moved the
  // caret to the end, so the next Delete or digit landed in the wrong place.
  // A cleared value only keeps a blank field: half-typed text also parses to
  // '', and a reset from outside must still clear it.
  React.useEffect(() => {
    const iso = String(value || '').slice(0, 10);
    setText((current) => ((iso ? toIso(current) === iso : !current.trim()) ? current : toDisplay(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const toggleRef = React.useRef<HTMLButtonElement>(null);
  // Escape hands focus back to the calendar button, as a dialog returns it to
  // its opener; otherwise it falls to <body> and the next Tab starts over at
  // the top of the page.
  const closeFromKeyboard = React.useCallback(() => {
    setOpen(false);
    if (popoverRef.current?.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
  }, []);
  useEscapeClose(open, closeFromKeyboard);

  // Below the field, right edges lined up; above it when the window has no
  // room below; kept inside the window on a phone. The calendar sizes itself
  // to this width (border included). When neither side has room, it goes on
  // the roomier side, pushed back inside the window over the field.
  const place = React.useCallback(() => {
    const field = fieldRef.current;
    if (!field) return;
    const box = field.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 16);
    const height = popoverRef.current?.offsetHeight || 340;
    const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
    const below = box.bottom + 4;
    const above = box.top - 4 - height;
    const fitsBelow = below + height <= window.innerHeight - 8;
    const fitsAbove = above >= 8;
    let top = below;
    if (!fitsBelow && fitsAbove) top = above;
    else if (!fitsBelow) {
      top = window.innerHeight - box.bottom >= box.top ? Math.max(8, window.innerHeight - 8 - height) : 8;
    }
    setPosition({ position: 'fixed', top, left, width });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (fieldRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Capture: a scroll inside a dialog body moves the field too.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, place]);

  const commitText = () => {
    const iso = toIso(text);
    if (iso) {
      onChange(iso);
      setText(toDisplay(iso));
    } else if (!text.trim()) {
      onChange('');
    }
  };

  const pick = (iso: string) => {
    onChange(iso);
    setText(toDisplay(iso));
    setOpen(false);
    // Back to the visible field, so the next Tab or click behaves as usual.
    document.getElementById(inputId)?.focus({ preventScroll: true });
  };

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-body mb-1.5">
          {label}
        </label>
      )}
      <div className="relative" ref={fieldRef}>
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
            // value (e.g. the import form's "today" default). Only a fully
            // typed date commits (two-digit day and month, four-digit year):
            // editing "15.08.2026" passes through "1.08.2026", which is a
            // valid date but not the one meant. Blur still accepts the short
            // forms. toIso returns '' for impossible dates.
            const iso = isComplete(next) ? toIso(next) : '';
            if (iso) onChange(iso);
          }}
          onKeyDown={(e) => {
            // Enter submits the surrounding form without a blur: commit a
            // short date ("1.8.2026") first, or the form saves the old value.
            // The Enter that commits an IME composition is the field's.
            if (e.key === 'Enter' && !isImeComposing(e)) commitText();
          }}
          onBlur={commitText}
          aria-label={label ? undefined : ariaLabel}
          className={clsx('input pr-10', error && 'border-danger focus-visible:ring-accent')}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={
            error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined
          }
        />
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
          aria-label={t('common.chooseDate', 'Choose date')}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted hover:text-body disabled:opacity-50"
        >
          <Calendar className="w-5 h-5" />
        </button>
        {open && createPortal(
          <div
            ref={popoverRef}
            // Tab out of the calendar closes it: a portalled popover would
            // otherwise stay open behind the focus, and inside a Modal it
            // would hold the top layer and switch off the Modal's Tab trap.
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (next && (popoverRef.current?.contains(next) || fieldRef.current?.contains(next))) return;
              if (next) setOpen(false);
            }}
            // The popover is the last node in <body>, so Tab past its last
            // button leaves the page (relatedTarget null, the blur above
            // cannot tell that from switching windows). Tab past either end
            // closes it and returns to the calendar button, which sits where
            // the popover belongs in the tab order.
            onKeyDown={(e) => {
              if (e.key !== 'Tab' || e.altKey || e.metaKey || e.ctrlKey) return;
              const stops = Array.from(popoverRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled):not([tabindex="-1"])',
              ) || []);
              const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
              if (e.target !== edge) return;
              e.preventDefault();
              closeFromKeyboard();
            }}
            role="dialog"
            aria-label={label || t('common.chooseDate', 'Choose date')}
            style={position}
            className="z-[60] rounded-lg border border-line bg-panel shadow-lg"
          >
            <DateCalendar value={value} onSelect={pick} locale={locale} min={min} max={max} label={label} />
          </div>,
          document.body,
        )}
      </div>
      {error && (
        <p id={`${inputId}-error`} className="mt-1.5 text-sm text-danger-text">
          {error}
        </p>
      )}
      {helperText && !error && (
        <p id={`${inputId}-helper`} className="mt-1.5 text-sm text-muted">
          {helperText}
        </p>
      )}
    </div>
  );
};
