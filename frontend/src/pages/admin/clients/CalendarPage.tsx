/**
 * /admin/clients/calendar — admin calendar (read-only skeleton for E.6).
 *
 * Renders four layers fetched in one shot from /api/admin/calendar/items
 * (backend route adminCalendar.js, E.3):
 *
 *   - events (galleries)              → blue solid
 *   - hour entries                    → green solid (greyed when locked)
 *   - pending quotes (not converted)  → amber dashed
 *   - pending contracts (not converted) → purple dashed
 *
 * View toggle (Month / Week) persists per admin via localStorage
 * (`utils/calendarPrefs.ts`).
 *
 * Click behaviour:
 *   - event    → /admin/events/:slug
 *   - quote    → /admin/clients/quotes/:id
 *   - contract → /admin/clients/contracts/:id
 *   - hours    → noop in E.6; E.7 adds the inline edit popover.
 *
 * Interactions deferred to E.7:
 *   - drag-create on empty slots (hour-entry create modal)
 *   - drag-resize / drag-move on unlocked hour entries
 *   - inline edit popover on hour entries
 *
 * Bundle note: this file is the entry point of the `fullcalendar` chunk
 * carved in vite.config.ts (E.5). FullCalendar's plugin imports flow
 * through here only — the calling App.tsx loads this module lazily.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import FullCalendar from '@fullcalendar/react';
import type {
  EventInput,
  DatesSetArg,
  EventClickArg,
  EventDropArg,
  DateSelectArg,
} from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
// F.4 — bundle locales for the languages picpeak speaks. Importing
// the locale module registers it with FC's locale registry; the
// `locale` prop then resolves to it by code. Other locales (fr/nl/
// pt/ru) fall back to English day/month names.
import deLocale from '@fullcalendar/core/locales/de';
import { Card, Button, Loading } from '../../../components/common';
import {
  calendarService,
  type CalendarItem,
  type CalendarHoursItem,
} from '../../../services/calendar.service';
import { businessProfileService } from '../../../services/businessProfile.service';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { getCalendarView, setCalendarView, type CalendarView } from '../../../utils/calendarPrefs';
import { HourEntryDragCreateModal } from './HourEntryDragCreateModal';
import { HourEntryInlinePopover } from './HourEntryInlinePopover';

// Color tokens. Hex literals (rather than tailwind utility classes)
// because FullCalendar applies these as inline `background-color` /
// `border-color` styles on the rendered event chips — tailwind classes
// wouldn't take effect.
const COLOR_EVENT = '#3B82F6';      // blue-500
const COLOR_HOURS = '#10B981';      // emerald-500
const COLOR_HOURS_LOCKED = '#9CA3AF'; // gray-400 (greyed)
const COLOR_QUOTE_BORDER = '#F59E0B'; // amber-500
const COLOR_CONTRACT_BORDER = '#A855F7'; // purple-500

/**
 * Convert a backend CalendarItem to a FullCalendar EventInput. Embeds
 * the original item in `extendedProps` so the event-click handler can
 * read the `kind` discriminator without re-fetching.
 */
function mapItemToFcEvent(item: CalendarItem): EventInput {
  // Only unlocked hour entries are draggable/resizable. Everything
  // else stays inert — click-to-deep-link is the only interaction.
  const editable = item.kind === 'hours' && !item.locked;
  const base: EventInput = {
    id: `${item.kind}-${item.id}`,
    extendedProps: { item },
    editable,
    durationEditable: editable,
    startEditable: editable,
  };

  // Backend should return YYYY-MM-DD, but a prior bug (a pg date
  // column round-tripping as a full ISO timestamp like
  // "2026-05-18T00:00:00.000Z") slipped through and ended up
  // concatenated into FC start strings as
  // "2026-05-18T00:00:00.000ZT09:00", which FC parsed to NaN and
  // silently dropped. Slice to 10 chars here as a safety belt so any
  // future Date-vs-string drift on the backend can't repeat that.
  const rawDate = (item as { eventDate?: string; entryDate?: string }).eventDate
    || (item as { entryDate?: string }).entryDate
    || '';
  const dateStr = typeof rawDate === 'string' ? rawDate.slice(0, 10) : '';

  if (item.kind === 'event') {
    base.title = item.eventName || 'Event';
    base.backgroundColor = COLOR_EVENT;
    base.borderColor = COLOR_EVENT;
    if (item.isFullDay || !item.eventTimeStart) {
      base.start = dateStr;
      base.allDay = true;
    } else {
      base.start = `${dateStr}T${item.eventTimeStart}`;
      base.end = item.eventTimeEnd ? `${dateStr}T${item.eventTimeEnd}` : undefined;
    }
  } else if (item.kind === 'hours') {
    // Hours always have HH:MM start + end (entered via the form).
    base.title = item.customerName
      ? `${item.customerName} — ${item.description || ''}`.trim().replace(/—\s*$/, '')
      : item.description || 'Hours';
    if (item.locked) {
      base.backgroundColor = COLOR_HOURS_LOCKED;
      base.borderColor = COLOR_HOURS_LOCKED;
      base.classNames = ['cal-hours-locked'];
    } else {
      base.backgroundColor = COLOR_HOURS;
      base.borderColor = COLOR_HOURS;
    }
    base.start = `${dateStr}T${item.startTime}`;
    base.end = `${dateStr}T${item.endTime}`;
  } else if (item.kind === 'quote') {
    base.title = item.eventName
      ? `${item.quoteNumber} — ${item.eventName}`
      : item.quoteNumber;
    base.backgroundColor = 'transparent';
    base.borderColor = COLOR_QUOTE_BORDER;
    base.textColor = COLOR_QUOTE_BORDER;
    base.classNames = ['cal-dashed'];
    if (item.eventTimeStart) {
      base.start = `${dateStr}T${item.eventTimeStart}`;
      base.end = item.eventTimeEnd ? `${dateStr}T${item.eventTimeEnd}` : undefined;
    } else {
      base.start = dateStr;
      base.allDay = true;
    }
  } else if (item.kind === 'contract') {
    base.title = item.eventName
      ? `${item.contractNumber} — ${item.eventName}`
      : item.contractNumber;
    base.backgroundColor = 'transparent';
    base.borderColor = COLOR_CONTRACT_BORDER;
    base.textColor = COLOR_CONTRACT_BORDER;
    base.classNames = ['cal-dashed'];
    if (item.eventTimeStart) {
      base.start = `${dateStr}T${item.eventTimeStart}`;
      base.end = item.eventTimeEnd ? `${dateStr}T${item.eventTimeEnd}` : undefined;
    } else {
      base.start = dateStr;
      base.allDay = true;
    }
  }
  return base;
}

/**
 * Derive an ISO YYYY-MM-DD pair covering the calendar's current visible
 * range plus a 1-week buffer on each side. The buffer keeps the cache
 * hot during week-by-week navigation so the user doesn't see a
 * loading flicker each step.
 */
function bufferedRange(active: { start: Date; end: Date }) {
  const startMs = active.start.getTime() - 7 * 24 * 60 * 60 * 1000;
  const endMs = active.end.getTime() + 7 * 24 * 60 * 60 * 1000;
  const from = new Date(startMs).toISOString().slice(0, 10);
  const to = new Date(endMs).toISOString().slice(0, 10);
  return { from, to };
}

export const CalendarPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const calendarRef = useRef<FullCalendar | null>(null);
  // I.3 — master `hoursLogging` flag gates ALL hour-entry interactions
  // on the calendar (drag-create / drag-move / drag-resize / inline
  // edit). When off, the calendar stays read-only: existing entries
  // still render so the admin sees their history, but no new ones can
  // be created and existing ones can't be moved. The Customers detail
  // page is where the per-customer flag is set; THIS gate is the
  // global Settings → Features master switch.
  const { flags } = useFeatureFlags();
  const hoursLoggingEnabled = !!flags.hoursLogging;
  // F.4 — admin's general_time_format drives FC's time labels.
  // dateFormat is consumed only for the (deferred) custom title
  // formatter; FC's built-in title/header formatting follows the
  // `locale` prop below for now.
  const { timeFormat } = useLocalizedDate();
  const fcHour12 = timeFormat === '12h';
  // Single Intl.DateTimeFormatOptions object reused by slotLabelFormat
  // and eventTimeFormat so the time-grid axis and event-chip prefixes
  // stay in sync. 24h installs see "14:00"; 12h installs see "2:00 PM".
  const fcTimeFormat: Intl.DateTimeFormatOptions = useMemo(() => ({
    hour: '2-digit',
    minute: '2-digit',
    hour12: fcHour12,
    // 24h installs prefer no leading zero on the hour ("9:00" not "09:00");
    // FC accepts the `meridiem: false` shortcut for that.
    meridiem: fcHour12 ? 'short' : false,
  } as Intl.DateTimeFormatOptions), [fcHour12]);

  // View persisted in localStorage (E.5 / E.6 — utils/calendarPrefs.ts).
  const [view, setView] = useState<CalendarView>(() => getCalendarView());

  // Interaction state (E.7): drag-create payload + the hour entry the
  // inline popover is open against. Each is mutually exclusive; opening
  // one closes the other through the consumer's onClose.
  const [dragCreateState, setDragCreateState] = useState<{
    entryDate: string; startTime: string; endTime: string;
  } | null>(null);
  const [activeHoursItem, setActiveHoursItem] = useState<CalendarHoursItem | null>(null);

  // Range owned by the calendar instance — initialised lazily once
  // FullCalendar fires its first `datesSet`. Until then the query is
  // disabled so we don't fire a request for a guessed range.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  const { data: itemsResp, isLoading: itemsLoading } = useQuery({
    queryKey: ['calendar-items', range?.from, range?.to],
    queryFn: () => calendarService.list(range as { from: string; to: string }),
    enabled: !!range,
    // I.5 — staleTime bumped to 5 min so navigation away from the
    // calendar and back within a reasonable window reads cache only;
    // no refetch fires that could (per the bug the user keeps
    // reporting) overwrite the local optimistic-merged items with a
    // server response that's missing the freshly-saved entry. After
    // 5 min the natural staleness kicks in + the entry is in the DB
    // anyway by then. gcTime stays at the default 5 min so the cache
    // entry survives a brief nav away.
    staleTime: 5 * 60_000,
    // Don't refetch on every remount — the cache is the source of
    // truth for the duration of the staleTime. datesSet (a real range
    // change) still triggers a fresh fetch via the queryKey change.
    refetchOnMount: false,
  });

  // Resolve the timezone the calendar should render in. business_profile
  // .timezone wins; fall back to the browser's IANA tz.
  const { data: bpSnapshot } = useQuery({
    queryKey: ['business-profile-for-calendar'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60_000, // Settings change infrequently — long stale window.
  });
  const resolvedTz = bpSnapshot?.profile.timezone
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';

  // Map backend → FC event shape. Recomputed on every items change;
  // the cost is tiny relative to FC's render path.
  const fcEvents = useMemo(
    () => (itemsResp?.items || []).map(mapItemToFcEvent),
    [itemsResp],
  );

  // Persist view changes. We don't use FC's viewClassNames or similar
  // — the explicit toggle buttons drive both the FC instance + the
  // stored pref.
  useEffect(() => {
    setCalendarView(view);
    const api = calendarRef.current?.getApi();
    if (api && api.view.type !== view) {
      api.changeView(view);
    }
  }, [view]);

  const handleDatesSet = (arg: DatesSetArg) => {
    const next = bufferedRange({ start: arg.start, end: arg.end });
    setRange((prev) => {
      // Avoid a re-render storm: only update when the buffered range
      // actually shifts past its window.
      if (prev && prev.from === next.from && prev.to === next.to) return prev;
      return next;
    });
  };

  const handleEventClick = (arg: EventClickArg) => {
    const item = arg.event.extendedProps.item as CalendarItem | undefined;
    if (!item) return;
    if (item.kind === 'event') navigate(`/admin/events/${item.slug}`);
    else if (item.kind === 'quote') navigate(`/admin/clients/quotes/${item.id}`);
    else if (item.kind === 'contract') navigate(`/admin/clients/contracts/${item.id}`);
    else if (item.kind === 'hours') setActiveHoursItem(item);
  };

  /**
   * Drag-select on the time grid → open the create modal pre-filled
   * with the selected range. In month view a single-click select gets a
   * full-day range (no times) — guard against that so we don't open the
   * modal with HH:MM=00:00–00:00 across a multi-day span. Single-day,
   * sub-24h selects with explicit times are the supported case.
   *
   * I.3 — refuse if master hoursLogging flag is off. The backend would
   * 409 the save anyway; this prevents the modal from opening in the
   * first place. Toast tells the admin where to enable it.
   */
  const handleDateSelect = (sel: DateSelectArg) => {
    if (sel.allDay) return;
    // Use local-component extraction (matches handleEventDrop /
    // handleEventResize). The previous `.toISOString().slice(0, 10)`
    // path read UTC, so a drag-select on Wed 01:00 in Berlin (UTC+2)
    // shifted entryDate back to Tuesday's UTC date — the entry was
    // saved under the wrong day and "disappeared" from the visible
    // week on the next refresh.
    const pad = (n: number) => String(n).padStart(2, '0');
    const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startDay = ymd(sel.start);
    const endDay = ymd(sel.end);
    if (startDay !== endDay) return;
    if (!hoursLoggingEnabled) {
      toast.error(t('calendar.hourEntry.featureOffToast', 'Hour logging is disabled.') as string);
      calendarRef.current?.getApi().unselect();
      return;
    }
    const hh = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setDragCreateState({ entryDate: startDay, startTime: hh(sel.start), endTime: hh(sel.end) });
  };

  /**
   * Drag-move: admin drags the whole block to a different day or slot.
   * FullCalendar gives us the new start / end as Date objects. We
   * translate to (entryDate, startTime, endTime) and PUT through the
   * existing hour-entry update route. On 4xx/5xx, FC's `revert()` puts
   * the chip back where it was so the UI never lies about persistence.
   */
  const handleEventDrop = async (arg: EventDropArg) => {
    const item = arg.event.extendedProps.item as CalendarItem | undefined;
    if (!item || item.kind !== 'hours' || item.locked) {
      arg.revert();
      return;
    }
    const start = arg.event.start;
    const end = arg.event.end;
    if (!start || !end) {
      arg.revert();
      return;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const entryDate = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
    const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
    try {
      await customerAdminService.updateHourEntry(item.customerAccountId, item.id, {
        entryDate, startTime, endTime,
      });
      toast.success(t('calendar.hourEntry.movedToast', 'Hours updated.'));
      // F.7 — refetch (not just invalidate) so the calendar visibly
      // reflects the move/resize before any subsequent user action.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['calendar-items'] }),
        queryClient.refetchQueries({
          queryKey: ['admin-customer-hour-entries', item.customerAccountId],
        }),
      ]);
    } catch (err) {
      // I.2 — friendly toast when the hour-logging flag is off
      // server-side; raw axios message otherwise.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      const code = e?.response?.data?.code;
      const serverMsg = e?.response?.data?.error;
      if (code === 'FEATURE_OFF') {
        toast.error(t('calendar.hourEntry.featureOffToast',
          'Hour logging is disabled for this customer. Enable it on the customer detail page first.') as string);
      } else {
        const msg = serverMsg || (err instanceof Error ? err.message : String(err));
        toast.error(t('calendar.hourEntry.moveFailed', { message: msg, defaultValue: `Couldn't move: ${msg}` }) as string);
      }
      arg.revert();
    }
  };

  /**
   * Drag-resize: same as drop, but the start tends to be preserved and
   * only the end shifts (or vice-versa for the leading edge). The PUT
   * payload doesn't care which edge moved — we just send the canonical
   * triple.
   */
  const handleEventResize = async (arg: EventResizeDoneArg) => {
    const item = arg.event.extendedProps.item as CalendarItem | undefined;
    if (!item || item.kind !== 'hours' || item.locked) {
      arg.revert();
      return;
    }
    const start = arg.event.start;
    const end = arg.event.end;
    if (!start || !end) {
      arg.revert();
      return;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const entryDate = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
    const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
    try {
      await customerAdminService.updateHourEntry(item.customerAccountId, item.id, {
        entryDate, startTime, endTime,
      });
      toast.success(t('calendar.hourEntry.resizedToast', 'Hours updated.'));
      // F.7 — refetch (not just invalidate) so the calendar visibly
      // reflects the move/resize before any subsequent user action.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['calendar-items'] }),
        queryClient.refetchQueries({
          queryKey: ['admin-customer-hour-entries', item.customerAccountId],
        }),
      ]);
    } catch (err) {
      // I.2 — friendly toast on FEATURE_OFF (per-customer hour
      // logging disabled server-side); raw message otherwise.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      const code = e?.response?.data?.code;
      const serverMsg = e?.response?.data?.error;
      if (code === 'FEATURE_OFF') {
        toast.error(t('calendar.hourEntry.featureOffToast',
          'Hour logging is disabled for this customer. Enable it on the customer detail page first.') as string);
      } else {
        const msg = serverMsg || (err instanceof Error ? err.message : String(err));
        toast.error(t('calendar.hourEntry.resizeFailed', { message: msg, defaultValue: `Couldn't resize: ${msg}` }) as string);
      }
      arg.revert();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {t('calendar.pageTitle', 'Calendar')}
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('calendar.subtitle',
              'Events, logged hours, and pending quotes/contracts in one view.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={view === 'dayGridMonth' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setView('dayGridMonth')}
          >
            {t('calendar.viewMonth', 'Month')}
          </Button>
          <Button
            variant={view === 'timeGridWeek' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setView('timeGridWeek')}
          >
            {t('calendar.viewWeek', 'Week')}
          </Button>
        </div>
      </div>

      <Legend />

      <Card padding="md">
        {itemsLoading && !itemsResp && (
          <div className="mb-3 flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <Loading />
            <span>{t('calendar.loading', 'Loading items…')}</span>
          </div>
        )}
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={view}
          timeZone={resolvedTz}
          // F.4 — language + time format come from picpeak settings.
          // `locales` registers the locales we ship; `locale` picks the
          // active one by i18next language code. Unknown languages
          // fall back to FC's default English. Times are gated on the
          // admin's general_time_format via the shared fcTimeFormat
          // object below.
          locales={[deLocale]}
          locale={i18n.language || 'en'}
          slotLabelFormat={fcTimeFormat}
          eventTimeFormat={fcTimeFormat}
          // Week-view column headers. FC's default in en-US renders as
          // "Thu 5/21" (M/D), which is wrong for DE / CH operators who
          // expect day.month. dayHeaderContent (NOT dayHeaderFormat,
          // which only accepts an Intl options object in FC v6 and
          // throws if handed a function) returns the rendered string
          // directly. Locale-aware short weekday + explicit DD.MM. to
          // match the project-wide useLocalizedDate convention (per
          // feedback_respect_general_format_settings.md).
          dayHeaderContent={(arg) => {
            const d = arg.date;
            const day = String(d.getUTCDate()).padStart(2, '0');
            const month = String(d.getUTCMonth() + 1).padStart(2, '0');
            const weekday = d.toLocaleDateString(i18n.language || 'en', {
              weekday: 'short',
              timeZone: 'UTC',
            });
            return `${weekday} ${day}.${month}.`;
          }}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: '',
          }}
          // Week starts on Monday for the operator's EU market.
          firstDay={1}
          // Per user spec: full 24h in week view (was 06:00-22:00).
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          slotDuration="00:30:00"
          height="auto"
          expandRows
          events={fcEvents}
          eventClick={handleEventClick}
          datesSet={handleDatesSet}
          // E.7 — interactions enabled. Per-event `editable` already
          // filters the draggable surface to unlocked hour entries
          // (mapItemToFcEvent above). `selectable` enables the
          // drag-to-create gesture on empty slots in week view.
          // I.3 — master hoursLogging gates all drag interactions
          // (drag-to-create, drag-move, drag-resize). When off, the
          // calendar is read-only; existing entries still render so
          // history stays visible.
          selectable={hoursLoggingEnabled}
          selectMirror
          editable={hoursLoggingEnabled}
          // FullCalendar quirk: selecting on the all-day row fires
          // with allDay=true; the drag-create handler ignores those.
          eventDrop={handleEventDrop}
          eventResize={handleEventResize}
          select={handleDateSelect}
        />
      </Card>

      {dragCreateState && (
        <HourEntryDragCreateModal
          entryDate={dragCreateState.entryDate}
          startTime={dragCreateState.startTime}
          endTime={dragCreateState.endTime}
          onClose={() => {
            calendarRef.current?.getApi().unselect();
            setDragCreateState(null);
          }}
          onCreated={(created) => {
            // H.1 — push the new chip into FC's eventStore directly so
            // it appears immediately, independent of the useQuery cache
            // and the events-prop diffing that was silently dropping
            // the new entry. The background invalidate from the modal
            // will eventually replace this with the server-shaped row.
            calendarRef.current?.getApi().addEvent({
              id: `hours-${created.id}`,
              title: created.customerName
                ? `${created.customerName} — ${created.description || ''}`.trim().replace(/—\s*$/, '')
                : created.description || 'Hours',
              start: `${created.entryDate}T${created.startTime}`,
              end: `${created.entryDate}T${created.endTime}`,
              backgroundColor: '#10B981',
              borderColor: '#10B981',
              editable: true,
              durationEditable: true,
              startEditable: true,
              extendedProps: {
                item: {
                  kind: 'hours' as const,
                  id: created.id,
                  customerAccountId: created.customerAccountId,
                  entryDate: created.entryDate,
                  startTime: created.startTime,
                  endTime: created.endTime,
                  description: created.description,
                  status: 'unbilled' as const,
                  invoiceId: null,
                  invoiceStatus: null,
                  locked: false,
                  customerName: created.customerName,
                },
              },
            });
            calendarRef.current?.getApi().unselect();
            setDragCreateState(null);
          }}
        />
      )}

      {activeHoursItem && (
        <HourEntryInlinePopover
          item={activeHoursItem}
          onClose={() => setActiveHoursItem(null)}
          onMutated={() => setActiveHoursItem(null)}
        />
      )}

      {/* Per-instance CSS:
          - dashed quote/contract chips (Tailwind can't reach inline FC
            chip styles, so we override with a small local rule).
          - F.5 — FC's prev/next/today buttons styled to match picpeak's
            .btn-outline / .btn-primary tokens. FC ships its own
            .fc-button-primary class; we override the relevant rules
            and bind to the CSS variables the rest of the admin theme
            uses (--color-accent-dark, --color-surface-border,
            --color-muted-text). The "today" / disabled-edge buttons
            and the active state (selected view) all read from these
            vars so the calendar respects custom branding palettes. */}
      <style>{`
        /* Admin-toggle-aware chrome vars — gallery theme writes inline
           --color-* on :root which would otherwise override .dark; scope
           local vars so the calendar follows the admin light/dark toggle. */
        .fc { --cal-border: #e5e5e5; --cal-muted: #737373; --cal-text: #171717; }
        .dark .fc { --cal-border: #262626; --cal-muted: #a3a3a3; --cal-text: #f5f5f5; }
        .cal-dashed {
          border-style: dashed !important;
          background-color: transparent !important;
        }
        .cal-dashed .fc-event-title,
        .cal-dashed .fc-event-time {
          font-style: italic;
        }
        .cal-hours-locked {
          opacity: 0.7;
        }

        /* FC button restyle — match picpeak admin .btn-outline shape. */
        .fc .fc-button-primary {
          background-color: transparent;
          border: 1px solid var(--cal-border);
          color: var(--cal-muted);
          text-transform: none;
          font-weight: 500;
          box-shadow: none;
          transition: opacity 0.15s, background-color 0.15s;
        }
        .fc .fc-button-primary:hover:not(:disabled) {
          opacity: 0.8;
          background-color: transparent;
          border-color: var(--cal-border);
          color: var(--cal-muted);
        }
        .fc .fc-button-primary:focus,
        .fc .fc-button-primary:focus-visible {
          box-shadow: 0 0 0 2px var(--color-accent-dark);
          outline: none;
        }
        /* "today" / active view button — picpeak's primary fill. */
        .fc .fc-button-primary:not(:disabled).fc-button-active,
        .fc .fc-button-primary:not(:disabled):active {
          background-color: var(--color-accent-dark);
          border-color: var(--color-accent-dark);
          color: white;
        }
        .fc .fc-button-primary:disabled {
          opacity: 0.5;
          background-color: transparent;
          border-color: var(--cal-border);
          color: var(--cal-muted);
        }
        /* Toolbar title (month / week range) reads the regular text
           colour rather than FC's hardcoded #333 so dark mode looks
           right. */
        .fc .fc-toolbar-title {
          color: var(--cal-text);
          font-size: 1.125rem;
          font-weight: 600;
        }

        /* Week-view day dividers.
           Pin --fc-border-color so FC's header cells + horizontal
           slot lines pick up the admin theme. The vertical dividers
           in the time-grid body need a separate trick: FC v6 either
           merges the day columns into one wide cell or sets a zero
           border more specifically than our rule can override, so
           plain border-left doesn't render. Use box-shadow with
           "inset 1px 0 0" instead — it draws a 1px line inside the
           column without affecting layout, survives border-collapse,
           and isn't clipped by overflow:hidden. Apply on every
           selector that maps to a day column so the rule works
           regardless of which DOM shape FC ends up rendering. */
        .fc {
          --fc-border-color: var(--cal-border);
        }
        .fc .fc-timegrid-col:not(:first-of-type),
        .fc .fc-day:not(:first-child),
        .fc .fc-timegrid-cols > table > tbody > tr > td:not(:first-child) {
          box-shadow: inset 1px 0 0 var(--cal-border);
        }
      `}</style>
    </div>
  );
};

/**
 * Color-legend strip rendered above the calendar. Kept inline rather
 * than as a sibling component because it never reuses elsewhere and
 * sharing the COLOR_* tokens with the mapper above is cheap.
 */
const Legend: React.FC = () => {
  const { t } = useTranslation();
  return (
    <Card padding="sm">
      <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
        <LegendSwatch color={COLOR_EVENT} label={t('calendar.legend.events', 'Events')} />
        <LegendSwatch color={COLOR_HOURS} label={t('calendar.legend.hours', 'Hours')} />
        <LegendSwatch
          color={COLOR_QUOTE_BORDER}
          label={t('calendar.legend.pendingQuotes', 'Pending quotes')}
          dashed
        />
        <LegendSwatch
          color={COLOR_CONTRACT_BORDER}
          label={t('calendar.legend.pendingContracts', 'Pending contracts')}
          dashed
        />
        <LegendSwatch
          color={COLOR_HOURS_LOCKED}
          label={t('calendar.legend.hoursLocked', 'Locked (billed)')}
        />
      </div>
    </Card>
  );
};

const LegendSwatch: React.FC<{ color: string; label: string; dashed?: boolean }> = ({
  color, label, dashed,
}) => (
  <div className="flex items-center gap-2">
    <span
      aria-hidden
      className="inline-block w-4 h-3 rounded-sm"
      style={{
        backgroundColor: dashed ? 'transparent' : color,
        border: dashed ? `1.5px dashed ${color}` : `1px solid ${color}`,
      }}
    />
    <span>{label}</span>
  </div>
);
