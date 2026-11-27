/**
 * The website's traffic (issue 2618) on the Analytics page: counted on the
 * server per page, referring site and device class; no cookies, no script.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Eye, Globe, Link2, Monitor, Smartphone, Tablet } from 'lucide-react';
import { Card } from '../../common';
import { websiteService } from '../../../services/website.service';
import { MiniChart } from './MiniChart';

export function WebsiteTrafficSection({ days }: { days: number }) {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['website-analytics', days], queryFn: () => websiteService.getAnalytics(days) });
  if (!data) return null;
  const devices: Array<[keyof typeof data.devices, typeof Monitor, string]> = [
    ['desktop', Monitor, t('analytics.desktop')], ['mobile', Smartphone, t('analytics.mobile')], ['tablet', Tablet, t('analytics.tablet')],
  ];
  return (
    <section className="mt-8">
      <div className="flex items-center gap-2 mb-1">
        <Globe className="w-5 h-5 text-soft" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-heading">{t('analytics.website.title', 'Website')}</h2>
      </div>
      <p className="text-sm text-soft mb-4">
        {t('analytics.website.hint', 'Page views of your public website, counted on the server: no cookies, no tracking script, no addresses stored. Crawlers are left out.')}
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card padding="md">
          <div className="flex items-start justify-between mb-4">
            <div>
              <p className="text-sm text-soft">{t('analytics.pageViews')}</p>
              <p className="text-3xl font-bold text-heading">{data.totals.views.toLocaleString()}</p>
            </div>
            <Eye className="w-8 h-8 text-info-text" aria-hidden="true" />
          </div>
          <MiniChart data={data.chartData.map((d) => ({ date: d.date, value: d.views }))} color="bg-info" />
          <div className="mt-5 space-y-3">
            {devices.map(([key, Icon, label]) => (
              <div key={key} className="flex items-center justify-between">
                <span className="flex items-center gap-3 text-sm text-body"><Icon className="w-5 h-5 text-soft" aria-hidden="true" />{label}</span>
                <span className="text-sm font-semibold text-heading">{data.devices[key]}%</span>
              </div>
            ))}
          </div>
        </Card>
        <Card padding="md">
          <h3 className="text-base font-semibold text-heading mb-4">{t('analytics.website.topPages', 'Most viewed pages')}</h3>
          <div className="space-y-3">
            {data.topPages.map((page) => (
              <div key={page.page} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-heading truncate">{page.title || `/${page.page}`}</p>
                  <p className="text-xs text-muted">/{page.page}</p>
                </div>
                <p className="text-sm font-semibold text-heading">{page.views}</p>
              </div>
            ))}
            {!data.topPages.length && <p className="text-sm text-muted">{t('analytics.website.none', 'No visits in this period yet.')}</p>}
          </div>
        </Card>
        <Card padding="md">
          <h3 className="text-base font-semibold text-heading mb-4">{t('analytics.website.referrers', 'Where visitors came from')}</h3>
          <div className="space-y-3">
            {data.referrers.map((row) => (
              <div key={row.domain} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 min-w-0 text-sm text-body"><Link2 className="w-4 h-4 text-soft flex-shrink-0" aria-hidden="true" /><span className="truncate">{row.domain}</span></span>
                <span className="text-sm font-semibold text-heading">{row.views}</span>
              </div>
            ))}
            {!data.referrers.length && <p className="text-sm text-muted">{t('analytics.website.direct', 'Only direct visits so far.')}</p>}
          </div>
        </Card>
      </div>
    </section>
  );
}
