/**
 * The client's booking request status (#2440, part 3) at /book/status/:token.
 * Stripe Checkout returns here after the deposit; back from a cancelled
 * checkout, the server closes it and frees the slot. While the payment is still
 * open the page checks again every few seconds, for up to a minute (the
 * server also asks Stripe directly, so a late webhook does not keep it
 * waiting).
 */
import React from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CalendarCheck, Clock } from 'lucide-react';
import { Loading } from '../../components/common';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { bookingService, type PublicRequestStatus } from '../../services/booking.service';
import { formatMoneyMinor } from '../../utils/money';
import { zonedWallClock } from '../../utils/zonedWallClock';

const POLL_MS = 3000;
const POLL_LIMIT = 20;

export const BookingStatusPage: React.FC = () => {
  const { t } = useTranslation();
  usePublicDarkMode();
  const { token } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const cancelled = params.get('cancelled') === '1';
  const { format, formatTime } = useLocalizedDate();
  const polls = React.useRef(0);

  const { data, isLoading, isError } = useQuery<PublicRequestStatus>({
    queryKey: ['public-booking-status', token],
    queryFn: () => { polls.current += 1; return bookingService.requestStatus(token as string, { cancelled }); },
    enabled: Boolean(token),
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'awaiting_payment' && polls.current < POLL_LIMIT ? POLL_MS : false),
  });

  const card = 'bg-surface rounded-xl shadow-sm border border-border-token p-6 text-center space-y-3';
  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-background text-theme px-4 py-8">
      <div className="mx-auto w-full max-w-lg">{children}</div>
    </div>
  );

  if (isLoading) return shell(<Loading />);
  if (isError || !data) {
    return shell(
      <div className={card}>
        <AlertCircle className="mx-auto h-10 w-10 text-muted-theme" aria-hidden />
        <p>{t('booking.status.notFound', 'This booking request could not be found.')}</p>
      </div>,
    );
  }

  const start = zonedWallClock(data.startsAt, data.timezone);
  const when = t('booking.public.sentSlot', '{{service}} on {{day}} at {{time}}', {
    service: data.serviceName, day: format(new Date(`${start.day}T12:00:00`)), time: formatTime(start.time),
  });

  const body = (() => {
    switch (data.status) {
      case 'awaiting_payment':
        return {
          icon: Clock,
          title: cancelled
            ? t('booking.status.payCancelled', 'Payment not completed')
            : t('booking.status.payPending', 'Waiting for your payment'),
          text: cancelled
            ? t('booking.status.payCancelledText', 'The deposit was not paid, so the time is not reserved. Please book again.')
            : t('booking.status.payPendingText', 'We are waiting for the payment confirmation. This page updates by itself.'),
        };
      case 'pending':
        return {
          icon: CalendarCheck,
          title: t('booking.public.sentTitle', 'Request sent'),
          text: t('booking.public.sentBody', 'We have reserved the time for you and will send you a quote with the final price. You will also get an email confirmation.'),
        };
      case 'accepted':
        return {
          icon: CalendarCheck,
          title: t('booking.status.accepted', 'Request accepted'),
          text: t('booking.status.acceptedText', 'You will receive the quote by email.'),
        };
      case 'declined':
        return {
          icon: AlertCircle,
          title: t('booking.status.declined', 'Request declined'),
          text: data.depositStatus === 'refunded'
            ? t('booking.status.declinedRefunded', 'The studio cannot take on this date. Your deposit has been refunded.')
            : t('booking.status.declinedText', 'The studio cannot take on this date.'),
        };
      default:
        return {
          icon: AlertCircle,
          title: t('booking.status.expired', 'Reservation expired'),
          text: t('booking.status.expiredText', 'The time is free again. You are welcome to book again.'),
        };
    }
  })();
  const Icon = body.icon;

  return shell(
    <div className={card}>
      <Icon className="mx-auto h-10 w-10" aria-hidden />
      <h1 className="text-xl font-semibold">{body.title}</h1>
      <p>{when}</p>
      <p className="text-muted-theme" aria-live="polite">{body.text}</p>
      {data.depositStatus === 'paid' && (
        <p>{t('booking.status.depositPaid', 'Deposit paid: {{amount}}', { amount: formatMoneyMinor(data.depositMinor, data.currency) })}</p>
      )}
      <p className="text-sm">{t('booking.public.reference', 'Your reference: {{reference}}', { reference: data.reference })}</p>
      {(data.status === 'expired' || (cancelled && data.status === 'awaiting_payment')) && (
        <Link className="inline-block underline" to="/book">{t('booking.status.bookAgain', 'Book again')}</Link>
      )}
    </div>,
  );
};
