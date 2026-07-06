/**
 * Booking-target dropdown for accounting (expenses + incoming invoices).
 * "Company" (value null) or a specific event. Projects remain a separate
 * aggregation of events and are intentionally NOT a booking target here.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { eventsService } from '../../services/events.service';

interface Props {
  value: number | null;
  onChange: (eventId: number | null) => void;
  className?: string;
}

export const EventBookingSelect: React.FC<Props> = ({ value, onChange, className }) => {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['events-for-booking'],
    queryFn: () => eventsService.getEvents(1, 200),
    staleTime: 60_000,
  });
  const events = data?.events ?? [];
  const cls = className
    || 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';

  return (
    <select className={cls} value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{t('accounting.booking.company', 'Company')}</option>
      {events.map((ev) => (
        <option key={ev.id} value={ev.id}>{ev.event_name}</option>
      ))}
    </select>
  );
};

export default EventBookingSelect;
