/**
 * Calendar column headers per view (#S9).
 *
 * `dayHeaderContent` was written for the week view, where FullCalendar hands
 * the callback the real date of that column. In dayGridMonth the header row
 * labels seven generic weekday columns shared by every week, and FC fills
 * `arg.date` from its internal reference week (1970-01-04..10) — so the month
 * header read a fixed "Mo 05.01. … So 04.01." no matter which month was on
 * screen, while the day cells underneath were correct.
 *
 * The second block below mounts a real FullCalendar to pin FC's actual arg
 * behaviour: it is the library quirk, not our formatting, that these tests
 * exist to catch if a future FC upgrade changes it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';

import { formatDayHeader } from '../CalendarPage';

describe('formatDayHeader', () => {
  it('renders weekday + DD.MM. in the week view, where the column has a real date', () => {
    const d = new Date(Date.UTC(2026, 8, 1)); // Tue 2026-09-01
    expect(formatDayHeader(d, 'timeGridWeek', 'en')).toBe('Tue 01.09.');
  });

  it('renders the weekday alone in month view, where the column has no single date', () => {
    // FC's month-view reference week — the date that used to leak into the UI.
    const reference = new Date(Date.UTC(1970, 0, 5)); // Mon 1970-01-05
    expect(formatDayHeader(reference, 'dayGridMonth', 'en')).toBe('Mon');
    expect(formatDayHeader(reference, 'dayGridMonth', 'en')).not.toMatch(/\d/);
  });

  it('keeps the weekday locale-aware in both views', () => {
    const d = new Date(Date.UTC(2026, 8, 1));
    expect(formatDayHeader(d, 'dayGridMonth', 'de')).toBe('Di');
    expect(formatDayHeader(d, 'timeGridWeek', 'de')).toBe('Di 01.09.');
  });
});

describe('FullCalendar day headers', () => {
  const headerTexts = () =>
    Array.from(document.querySelectorAll('.fc-col-header-cell')).map(
      (c) => c.textContent?.trim() ?? ''
    );

  const renderCalendar = (view: 'dayGridMonth' | 'timeGridWeek') =>
    render(
      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin]}
        initialView={view}
        initialDate="2026-09-15"
        timeZone="UTC"
        firstDay={1}
        headerToolbar={false}
        height="auto"
        dayHeaderContent={(arg) => formatDayHeader(arg.date, arg.view.type, 'en')}
      />
    );

  it('month view shows seven dateless weekday headers', () => {
    renderCalendar('dayGridMonth');
    expect(headerTexts()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    // The old formatting leaked FC's 1970 reference week into the UI.
    expect(screen.queryByText(/05\.01\./)).toBeNull();
  });

  it('week view still shows the real date of each column', () => {
    renderCalendar('timeGridWeek');
    expect(headerTexts()).toEqual([
      'Mon 14.09.', 'Tue 15.09.', 'Wed 16.09.',
      'Thu 17.09.', 'Fri 18.09.', 'Sat 19.09.', 'Sun 20.09.',
    ]);
  });
});
