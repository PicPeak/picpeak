/**
 * Customer portal → one event (#1444).
 *
 * Everything for one event in one place: the gallery, and the quotes,
 * contracts, invoices and documents that belong to it. The server decides
 * which of these the customer may see and whether the gallery is open,
 * expired or not available yet — an expired gallery is shown with its
 * expiry date and can't be opened.
 */
import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Calendar, Clock, Download, ExternalLink } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, Loading } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { formatMoneyMinor } from '../../utils/money';
import { customerService } from '../../services/customer.service';
import { storeGalleryToken, setActiveGallerySlug } from '../../utils/galleryAuthStorage';
import { CustomerDocumentList } from './CustomerDocumentsPage';

/** Open a blob URL produced by `load` in a new tab, keeping the click gesture. */
async function openPdf(load: () => Promise<string>, blockedMessage: string, failedMessage: string) {
  const w = window.open('about:blank', '_blank');
  if (!w) {
    toast.error(blockedMessage);
    return;
  }
  try {
    w.location.href = await load();
  } catch {
    w.close();
    toast.error(failedMessage);
  }
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Card padding="none" className="mb-4">
    <h2 className="px-4 pt-4 pb-2 text-base font-semibold text-theme">{title}</h2>
    {children}
  </Card>
);

export const CustomerEventPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { slug = '' } = useParams<{ slug: string }>();
  const { format: fmtDate } = useLocalizedDate();
  const [opening, setOpening] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customer-event-overview', slug],
    queryFn: () => customerService.getEventOverview(slug),
    enabled: !!slug,
    retry: false,
  });

  if (isLoading) return <Loading />;
  if (isError || !data) {
    return (
      <div className="container py-8">
        <p className="text-theme mb-4">
          {t('customer.event.notFound', 'This event was not found, or you no longer have access to it.')}
        </p>
        <Link to="/customer/dashboard" className="text-sm underline text-theme">
          {t('customer.event.back', 'Back to your galleries')}
        </Link>
      </div>
    );
  }

  const { event, sections } = data;
  const blocked = t('customer.event.popupBlocked', 'Allow pop-ups for this site to open the PDF.');
  const failed = t('customer.event.pdfError', 'The PDF could not be opened. Please try again.');

  const openGallery = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const { token } = await customerService.getEventAccessToken(event.slug);
      storeGalleryToken(event.slug, token);
      setActiveGallerySlug(event.slug);
      navigate(`/gallery/${encodeURIComponent(event.slug)}`);
    } catch {
      toast.error(t('customer.dashboard.openError', 'Could not open this gallery. Please try again.'));
    } finally {
      setOpening(false);
    }
  };

  const nothingElse = (!sections.quotes || data.quotes.length === 0)
    && (!sections.contracts || data.contracts.length === 0)
    && (!sections.invoices || data.invoices.length === 0)
    && (!sections.documents || data.documents.length === 0);

  return (
    <div className="container py-6">
      <Link to="/customer/dashboard" className="inline-flex items-center gap-1 text-sm text-muted-theme hover:text-theme mb-4">
        <ArrowLeft className="w-4 h-4" />
        {t('customer.event.back', 'Back to your galleries')}
      </Link>

      <h1 className="text-2xl font-bold text-theme">{event.eventName}</h1>
      <div className="mt-1 mb-6 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-theme">
        {event.eventDate && (
          <span className="inline-flex items-center gap-1.5"><Calendar className="w-4 h-4" />{fmtDate(event.eventDate)}</span>
        )}
        {event.expiresAt && (
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-4 h-4" />
            {event.availability === 'expired'
              ? t('customer.dashboard.expiredOn', 'Expired {{date}}', { date: fmtDate(event.expiresAt) })
              : t('customer.dashboard.expiresOn', 'Expires {{date}}', { date: fmtDate(event.expiresAt) })}
          </span>
        )}
      </div>

      <Card padding="lg" className="mb-4">
        <h2 className="text-base font-semibold text-theme mb-2">{t('customer.event.gallery', 'Gallery')}</h2>
        {event.availability === 'active' ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={openGallery}
            disabled={opening}
            leftIcon={<ExternalLink className="w-4 h-4" />}
          >
            {opening ? t('customer.dashboard.opening', 'Opening…') : t('customer.event.openGallery', 'Open gallery')}
          </Button>
        ) : event.availability === 'expired' ? (
          <p className="text-sm text-muted-theme">
            {t('customer.event.galleryExpired', 'This gallery expired on {{date}} and can no longer be opened. Contact your photographer if you still need the photos.', {
              date: event.expiresAt ? fmtDate(event.expiresAt) : '',
            })}
          </p>
        ) : (
          <p className="text-sm text-muted-theme">
            {t('customer.event.galleryUnavailable', 'This gallery is not available yet.')}
          </p>
        )}
      </Card>

      {sections.quotes && data.quotes.length > 0 && (
        <Section title={t('customer.nav.quotes', 'Quotes')}>
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {data.quotes.map((q) => (
              <li key={q.id} className="p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <span className="font-mono text-sm text-theme">{q.quoteNumber}</span>
                  <span className="ml-2 text-xs text-muted-theme">{t(`quotes.status.${q.status}`, q.status)}</span>
                  <p className="text-xs text-muted-theme mt-0.5">
                    {q.issueDate && fmtDate(q.issueDate)}{' · '}{formatMoneyMinor(q.totalAmountMinor, q.currency)}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />}
                  onClick={() => openPdf(() => customerService.quotePdfUrl(q.id), blocked, failed)}>
                  {t('customer.event.pdf', 'PDF')}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {sections.contracts && data.contracts.length > 0 && (
        <Section title={t('customer.nav.contracts', 'Contracts')}>
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {data.contracts.map((c) => (
              <li key={c.id} className="p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <span className="font-mono text-sm text-theme">{c.contractNumber}</span>
                  <span className="ml-2 text-xs text-muted-theme">{t(`contracts.status.${c.status}`, c.status)}</span>
                  {c.title && <p className="text-xs text-muted-theme mt-0.5">{c.title}</p>}
                </div>
                {(c.hasPdf || c.hasSignedPdf) && (
                  <Button type="button" variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />}
                    onClick={() => openPdf(() => customerService.contractPdfUrl(c.id), blocked, failed)}>
                    {t('customer.event.pdf', 'PDF')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {sections.invoices && data.invoices.length > 0 && (
        <Section title={t('customer.nav.bills', 'Invoices')}>
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {data.invoices.map((i) => (
              <li key={i.id} className="p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <span className="font-mono text-sm text-theme">{i.invoiceNumber}</span>
                  <span className="ml-2 text-xs text-muted-theme">{t(`bills.status.${i.status}`, i.status)}</span>
                  <p className="text-xs text-muted-theme mt-0.5">
                    {i.dueDate && t('customer.event.dueOn', 'Due {{date}}', { date: fmtDate(i.dueDate) })}
                    {' · '}{formatMoneyMinor(i.totalAmountMinor, i.currency)}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />}
                  onClick={() => openPdf(() => customerService.invoicePdfUrl(i.id), blocked, failed)}>
                  {t('customer.event.pdf', 'PDF')}
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {sections.documents && data.documents.length > 0 && (
        <Section title={t('customer.nav.documents', 'Documents')}>
          <CustomerDocumentList documents={data.documents} showEvent={false} />
        </Section>
      )}

      {nothingElse && (
        <p className="text-sm text-muted-theme">
          {t('customer.event.nothingElse', 'There are no documents for this event yet.')}
        </p>
      )}
    </div>
  );
};

export default CustomerEventPage;
