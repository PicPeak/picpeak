/**
 * Public booking page (#2440, part 2) at /book. A client picks a service,
 * answers its pricing factors, sees the estimate, picks a free slot and sends
 * a request. The request only reserves the slot for a while; the studio
 * confirms the price with a quote. Times show in the studio's time zone.
 *
 * Off (feature flag) or with no bookable service, the page says booking is
 * not available. The hidden `website` field is a honeypot; `startedAt` lets
 * the server drop a form posted faster than a person can fill it in.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { Button, Loading } from '../../components/common';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { FactorInputs, initialFactorValue } from '../../features/pricing-factors/FactorInputs';
import { bookingService, type PublicService, type Slot } from '../../services/booking.service';
import type { FactorValue, PricingFactor } from '../../services/quoteCatalog.service';
import { formatMoneyMinor } from '../../utils/money';
import { addDays, isoWeekday, zonedWallClock } from '../../utils/zonedWallClock';

/** The public factor shape as the shared inputs expect it (prices stay on the server). */
function asFactor(f: PublicService['factors'][number], currency: string): PricingFactor {
  return {
    id: f.id, name: f.name, description: f.description, inputType: f.inputType, effect: null,
    unitLabel: f.unitLabel, currency, amountMinor: null, percent: null, includedUnits: null, stepSize: null,
    minValue: f.minValue, maxValue: f.maxValue, defaultValue: f.defaultValue, clientVisible: true,
    displayOrder: 0, isActive: true,
    options: f.options.map((o) => ({ id: o.id, label: o.label, effect: 'fixed', amountMinor: null, percent: null })),
  };
}

const errorText = (err: any, fallback: string): string => err?.response?.data?.error || fallback;

export const BookingPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { isDark } = usePublicDarkMode();
  const { data: publicSettings } = usePublicSettings();
  const { format, formatTime } = useLocalizedDate();
  const startedAt = useRef(Date.now());

  const { data: info, isLoading, isError } = useQuery({
    queryKey: ['public-booking'],
    queryFn: () => bookingService.publicInfo(),
    retry: false,
  });

  const [serviceId, setServiceId] = useState<number | null>(null);
  const service = info?.services.find((s) => s.id === serviceId) || null;
  useEffect(() => {
    if (info && info.services.length === 1 && serviceId == null) setServiceId(info.services[0].id);
  }, [info, serviceId]);

  const factors = useMemo(() => (service ? service.factors.map((f) => asFactor(f, service.currency)) : []), [service]);
  const [values, setValues] = useState<Record<string, FactorValue>>({});
  const [slot, setSlot] = useState<Slot | null>(null);
  useEffect(() => {
    const next: Record<string, FactorValue> = {};
    for (const f of factors) next[f.id] = initialFactorValue(f);
    setValues(next);
    setSlot(null);
  }, [factors]);

  // Estimate, re-priced shortly after the last change.
  const [estimate, setEstimate] = useState<Awaited<ReturnType<typeof bookingService.estimate>> | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  useEffect(() => {
    if (!service) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await bookingService.estimate(service.id, values, i18n.language);
        if (!cancelled) { setEstimate(next); setEstimateError(null); }
      } catch (err) {
        if (!cancelled) { setEstimate(null); setEstimateError(errorText(err, t('booking.public.estimateFailed', 'The price could not be worked out.'))); }
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [service, values, i18n.language, t]);

  // The week shown (Monday first), in the studio's time zone.
  const timezone = info?.timezone || 'UTC';
  const today = zonedWallClock(new Date(), timezone).day;
  const thisMonday = addDays(today, 1 - isoWeekday(today));
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const week = weekStart || thisMonday;
  const durationValue = service?.durationFactorId != null ? values[service.durationFactorId] : null;
  const { data: slotData, isFetching: slotsLoading } = useQuery({
    queryKey: ['public-booking-slots', service?.id, week, durationValue],
    queryFn: () => bookingService.slots(service!.id, week, addDays(week, 6), typeof durationValue === 'number' ? durationValue : null),
    enabled: Boolean(service),
  });
  useEffect(() => { setSlot(null); }, [durationValue]);
  const slotsByDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slotData?.slots || []) {
      const { day } = zonedWallClock(s.start, timezone);
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(s);
    }
    return map;
  }, [slotData, timezone]);
  const lastBookableDay = info ? addDays(today, info.horizonDays) : today;

  const [contact, setContact] = useState({ name: '', email: '', phone: '', company: '', message: '', website: '' });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ reference: string | null; holdExpiresAt?: string } | null>(null);

  const wallTime = (instant: string) => formatTime(zonedWallClock(instant, timezone).time);
  const wallDay = (day: string) => format(new Date(`${day}T12:00:00`));
  const weekdayName = (day: string) => new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(`${day}T12:00:00Z`));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!service || !slot) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await bookingService.sendRequest({
        serviceId: service.id, values, start: slot.start,
        name: contact.name, email: contact.email, phone: contact.phone || undefined,
        company: contact.company || undefined, message: contact.message || undefined,
        language: i18n.language, website: contact.website || undefined, startedAt: startedAt.current,
      });
      setSent(res);
    } catch (err: any) {
      setSendError(errorText(err, t('booking.public.sendFailed', 'The request could not be sent. Please try again.')));
      if (err?.response?.status === 409) setSlot(null);
    } finally {
      setSending(false);
    }
  };

  const logo = isDark && publicSettings?.branding_logo_url_dark ? publicSettings.branding_logo_url_dark : publicSettings?.branding_logo_url;
  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-background text-theme px-4 py-8">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="text-center space-y-2">
          {logo && <img src={logo} alt="" className="mx-auto max-h-16" />}
          <h1 className="text-2xl font-semibold">
            {info?.businessName
              ? t('booking.public.titleWithName', 'Book {{name}}', { name: info.businessName })
              : t('booking.public.title', 'Book a shoot')}
          </h1>
        </header>
        {children}
      </div>
    </div>
  );
  const card = 'bg-surface rounded-xl shadow-sm border border-border-token p-6';

  if (isLoading) return shell(<Loading />);
  if (isError || !info || info.services.length === 0) {
    return shell(
      <div className={`${card} text-center`}>
        <AlertCircle className="mx-auto mb-3 h-10 w-10 text-muted-theme" aria-hidden />
        <p>{t('booking.public.unavailable', 'Online booking is not available at the moment.')}</p>
      </div>,
    );
  }

  if (sent) {
    return shell(
      <div className={`${card} text-center space-y-3`}>
        <CalendarCheck className="mx-auto h-10 w-10" aria-hidden />
        <h2 className="text-xl font-semibold">{t('booking.public.sentTitle', 'Request sent')}</h2>
        {slot && (
          <p>
            {t('booking.public.sentSlot', '{{service}} on {{day}} at {{time}}', {
              service: service?.name, day: wallDay(zonedWallClock(slot.start, timezone).day), time: wallTime(slot.start),
            })}
          </p>
        )}
        <p className="text-muted-theme">
          {t('booking.public.sentBody', 'We have reserved the time for you and will send you a quote with the final price. You will also get an email confirmation.')}
        </p>
        {sent.reference && (
          <p>{t('booking.public.reference', 'Your reference: {{reference}}', { reference: sent.reference })}</p>
        )}
      </div>,
    );
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const unmatched = estimate?.unmatched || [];

  return shell(
    <form onSubmit={submit} className="space-y-6">
      {info.intro && <p className="text-center text-muted-theme whitespace-pre-line">{info.intro}</p>}

      <section className={card} aria-labelledby="booking-service">
        <h2 id="booking-service" className="text-lg font-semibold mb-3">{t('booking.public.step.service', '1. Service')}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {info.services.map((s) => (
            <label key={s.id} className={`cursor-pointer rounded-lg border p-4 ${serviceId === s.id ? 'border-primary ring-2 ring-primary' : 'border-border-token'}`}>
              <input type="radio" name="service" className="sr-only" checked={serviceId === s.id} onChange={() => setServiceId(s.id)} />
              <div className="font-medium">{s.name}</div>
              {s.description && <div className="mt-1 text-sm text-muted-theme whitespace-pre-line">{s.description}</div>}
            </label>
          ))}
        </div>
      </section>

      {service && (
        <section className={card} aria-labelledby="booking-details">
          <h2 id="booking-details" className="text-lg font-semibold mb-3">{t('booking.public.step.details', '2. Details')}</h2>
          <div className="grid gap-6 md:grid-cols-2">
            {factors.length > 0
              ? <FactorInputs factors={factors} values={values} onChange={setValues} zoneMode="postcode"
                  unmatched={unmatched} idPrefix="booking-factor" variant="public" />
              : <p className="text-sm text-muted-theme">{t('booking.public.noDetails', 'Nothing to fill in for this service.')}</p>}
            <div className="rounded-lg border border-border-token p-4" aria-live="polite">
              <div className="text-sm text-muted-theme">{t('booking.public.estimate', 'Estimate')}</div>
              {estimate ? (
                <>
                  <div className="text-2xl font-semibold tabular-nums">{formatMoneyMinor(estimate.totalMinor, estimate.currency)}</div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {estimate.lines.map((l, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span>{l.description}</span>
                        <span className="tabular-nums">{formatMoneyMinor(l.totalMinor, estimate.currency)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : estimateError ? <p className="text-sm">{estimateError}</p> : <Loading />}
              <p className="mt-3 text-xs text-muted-theme">
                {t('booking.public.estimateNote', 'This is an estimate. You will receive a quote with the final price.')}
              </p>
            </div>
          </div>
        </section>
      )}

      {service && (
        <section className={card} aria-labelledby="booking-time">
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 id="booking-time" className="text-lg font-semibold">{t('booking.public.step.time', '3. Time')}</h2>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={week <= thisMonday}
                aria-label={t('booking.public.prevWeek', 'Previous week') as string}
                onClick={() => setWeekStart(addDays(week, -7))}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="text-sm tabular-nums">{wallDay(week)} – {wallDay(addDays(week, 6))}</span>
              <Button type="button" variant="outline" size="sm" disabled={addDays(week, 7) > lastBookableDay}
                aria-label={t('booking.public.nextWeek', 'Next week') as string}
                onClick={() => setWeekStart(addDays(week, 7))}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <p className="mb-3 text-xs text-muted-theme">
            {t('booking.public.timezone', 'Times in {{zone}}.', { zone: timezone })}
          </p>
          {slotsLoading ? <Loading /> : (
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 md:grid-cols-7">
              {days.map((day) => {
                const daySlots = slotsByDay.get(day) || [];
                return (
                  <div key={day}>
                    <div className="text-xs font-medium mb-1">
                      <div>{weekdayName(day)}</div>
                      <div className="text-muted-theme">{wallDay(day)}</div>
                    </div>
                    {daySlots.length === 0 ? <div className="text-xs text-muted-theme">–</div> : (
                      <div className="flex flex-col gap-1">
                        {daySlots.map((s) => (
                          <button key={s.start} type="button" onClick={() => setSlot(s)} aria-pressed={slot?.start === s.start}
                            className={`rounded border px-2 py-1 text-sm tabular-nums ${slot?.start === s.start ? 'border-primary bg-primary text-white' : 'border-border-token'}`}>
                            {wallTime(s.start)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!slotsLoading && (slotData?.slots.length ?? 0) === 0 && (
            <p className="mt-3 text-sm text-muted-theme">{t('booking.public.noSlots', 'No free times this week. Try the next one.')}</p>
          )}
        </section>
      )}

      {service && slot && (
        <section className={card} aria-labelledby="booking-contact">
          <h2 id="booking-contact" className="text-lg font-semibold mb-3">{t('booking.public.step.contact', '4. Your details')}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="booking-name" className="block text-sm font-medium mb-1">{t('booking.public.field.name', 'Name')}</label>
              <input id="booking-name" required maxLength={160} autoComplete="name" className="input-themed w-full"
                value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="booking-email" className="block text-sm font-medium mb-1">{t('booking.public.field.email', 'Email')}</label>
              <input id="booking-email" type="email" required maxLength={255} autoComplete="email" className="input-themed w-full"
                value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
            </div>
            <div>
              <label htmlFor="booking-phone" className="block text-sm font-medium mb-1">{t('booking.public.field.phone', 'Phone (optional)')}</label>
              <input id="booking-phone" type="tel" maxLength={40} autoComplete="tel" className="input-themed w-full"
                value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
            </div>
            <div>
              <label htmlFor="booking-company" className="block text-sm font-medium mb-1">{t('booking.public.field.company', 'Company or band (optional)')}</label>
              <input id="booking-company" maxLength={160} autoComplete="organization" className="input-themed w-full"
                value={contact.company} onChange={(e) => setContact({ ...contact, company: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <label htmlFor="booking-message" className="block text-sm font-medium mb-1">{t('booking.public.field.message', 'Message (optional)')}</label>
              <textarea id="booking-message" rows={3} maxLength={5000} className="input-themed w-full h-auto"
                value={contact.message} onChange={(e) => setContact({ ...contact, message: e.target.value })} />
            </div>
            {/* Honeypot: hidden from people and screen readers; bots fill it in. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor="booking-website">Website</label>
              <input id="booking-website" tabIndex={-1} autoComplete="off" value={contact.website}
                onChange={(e) => setContact({ ...contact, website: e.target.value })} />
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-border-token p-3 text-sm">
            {t('booking.public.summary', '{{service}} on {{day}} at {{time}}', {
              service: service.name, day: wallDay(zonedWallClock(slot.start, timezone).day), time: wallTime(slot.start),
            })}
            {estimate && ` · ${t('booking.public.estimate', 'Estimate')} ${formatMoneyMinor(estimate.totalMinor, estimate.currency)}`}
          </div>
          {sendError && <p role="alert" className="mt-3 text-sm text-danger-text">{sendError}</p>}
          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={sending || !contact.name.trim() || !contact.email.trim()}>
              {t('booking.public.send', 'Send booking request')}
            </Button>
          </div>
        </section>
      )}
    </form>,
  );
};
