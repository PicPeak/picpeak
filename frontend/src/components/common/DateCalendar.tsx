import React from 'react';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import type { Locale } from 'date-fns';

interface DateCalendarProps {
  /** Selected day as ISO yyyy-MM-dd, or '' for none. */
  value: string;
  onSelect: (iso: string) => void;
  locale: Locale;
  min?: string;
  max?: string;
  /** Names the grid for screen readers (the field's label). */
  label?: string;
}

const toIso = (d: Date) => format(d, 'yyyy-MM-dd');

// Local midnight from yyyy-MM-dd (or the date part of a full ISO datetime).
// `new Date('2026-10-12')` would be UTC midnight, the day before west of UTC.
const fromIso = (iso: string | undefined): Date | null => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/**
 * Month calendar for `LocalizedDateInput`. Rendered by the app, not the
 * browser: a native date input opened through `showPicker()` from a hidden
 * field does not open reliably in Safari, and its calendar ignores the app
 * language and the dark mode. Week start and month names follow the UI
 * language. Arrow keys move by day and week, Page Up / Page Down by month,
 * Home / End to the week's ends, Enter or Space picks.
 */
export const DateCalendar: React.FC<DateCalendarProps> = ({ value, onSelect, locale, min, max, label }) => {
  const { t } = useTranslation();
  const selected = fromIso(value);
  const minDate = fromIso(min);
  const maxDate = fromIso(max);
  const today = new Date();
  // Start on the selected day (or today), moved into [min, max]: a disabled
  // day cannot take focus, and the grid would have no keyboard entry.
  const clamp = (d: Date) => {
    if (minDate && d < minDate) return minDate;
    if (maxDate && d > maxDate) return maxDate;
    return d;
  };
  const [focusDay, setFocusDay] = React.useState<Date>(() => clamp(selected || today));
  const [month, setMonth] = React.useState<Date>(() => startOfMonth(focusDay));
  const gridRef = React.useRef<HTMLDivElement>(null);
  // Focus follows the active day: on open (so the arrow keys work at once)
  // and after each keyboard step, not after a click on the month arrows.
  const moveFocus = React.useRef(true);

  const weekStartsOn = locale.options?.weekStartsOn ?? 1;
  const first = startOfWeek(startOfMonth(month), { weekStartsOn });
  const last = endOfWeek(endOfMonth(month), { weekStartsOn });
  const days: Date[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const isDisabled = (d: Date) => (minDate !== null && d < minDate) || (maxDate !== null && d > maxDate);

  React.useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${toIso(focusDay)}"]`)?.focus({ preventScroll: true });
  }, [focusDay, month]);

  // Every move stays inside [min, max] for the same reason: focus on a
  // disabled day goes nowhere and the arrow keys would go dead.
  const goTo = (target: Date) => {
    const d = clamp(target);
    moveFocus.current = true;
    setFocusDay(d);
    if (!isSameMonth(d, month)) setMonth(startOfMonth(d));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      PageUp: () => addMonths(focusDay, -1),
      PageDown: () => addMonths(focusDay, 1),
      Home: () => startOfWeek(focusDay, { weekStartsOn }),
      End: () => endOfWeek(focusDay, { weekStartsOn }),
    };
    const next = step[e.key];
    // Alt+Left is the browser's Back; leave modified keys alone.
    if (!next || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    goTo(next());
  };

  // A month wholly outside [min, max] has no day to pick or focus.
  const canPrev = !minDate || endOfMonth(addMonths(month, -1)) >= minDate;
  const canNext = !maxDate || startOfMonth(addMonths(month, 1)) <= maxDate;
  const shiftMonth = (by: number) => {
    const next = addMonths(month, by);
    setMonth(next);
    setFocusDay(isSameMonth(focusDay, next) ? focusDay : clamp(next));
  };

  const navButton = 'p-1.5 rounded-md text-muted hover:text-heading hover:bg-hover disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={() => shiftMonth(-1)} disabled={!canPrev} className={navButton} aria-label={t('common.previousMonth', 'Previous month')}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-heading capitalize" aria-live="polite">
          {format(month, 'LLLL yyyy', { locale })}
        </span>
        <button type="button" onClick={() => shiftMonth(1)} disabled={!canNext} className={navButton} aria-label={t('common.nextMonth', 'Next month')}>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div ref={gridRef} role="grid" aria-label={label} onKeyDown={onKeyDown}>
        <div role="row" className="grid grid-cols-7 mb-1">
          {weeks[0].map((d) => (
            <span key={d.getDay()} role="columnheader" aria-label={format(d, 'EEEE', { locale })} className="text-center text-xs text-muted py-1">
              {format(d, 'EEEEEE', { locale })}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={toIso(week[0])} role="row" className="grid grid-cols-7">
            {week.map((d) => {
              const isSelected = selected !== null && isSameDay(d, selected);
              const inMonth = isSameMonth(d, month);
              return (
                <span key={toIso(d)} role="gridcell" aria-selected={isSelected}>
                  <button
                    type="button"
                    data-day={toIso(d)}
                    tabIndex={isSameDay(d, focusDay) ? 0 : -1}
                    disabled={isDisabled(d)}
                    onClick={() => onSelect(toIso(d))}
                    aria-label={format(d, 'PPPP', { locale })}
                    aria-current={isSameDay(d, today) ? 'date' : undefined}
                    className={clsx(
                      'w-full h-9 rounded-md text-sm tabular-nums disabled:opacity-40 disabled:pointer-events-none',
                      isSelected
                        ? 'bg-accent-strong text-accent-fg font-medium'
                        : clsx('hover:bg-hover', inMonth ? 'text-body' : 'text-muted'),
                      !isSelected && isSameDay(d, today) && 'ring-1 ring-inset ring-line-strong font-medium',
                    )}
                  >
                    {format(d, 'd')}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => onSelect(toIso(today))}
          disabled={isDisabled(new Date(today.getFullYear(), today.getMonth(), today.getDate()))}
          className="px-2 py-1 rounded-md text-sm text-accent hover:bg-hover disabled:opacity-40"
        >
          {t('common.today', 'Today')}
        </button>
      </div>
    </div>
  );
};
