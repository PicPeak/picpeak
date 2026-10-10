/**
 * Public recipient download page for PicTransfer (#997).
 *
 * Token-only (no auth). By design there are NO thumbnails — just filenames,
 * sizes and a prominent "Download all" button, plus per-file download.
 * Files served are always ORIGINALS.
 *
 * Styling reads the branding theme tokens (bg-surface, text-theme, ...), not
 * Tailwind neutral/`dark:` utilities: the instance branding (colours + light
 * or dark) is what drives a public page. usePublicDarkMode puts that palette
 * in charge of the shared components too.
 */
import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, FileDown, Clock, PackageOpen, AlertCircle } from 'lucide-react';

import { Button, Loading } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { transfersService } from '../../services/transfers.service';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const TransferDownloadPage: React.FC = () => {
  const { t } = useTranslation();
  usePublicDarkMode();
  const { format } = useLocalizedDate();
  const { token } = useParams<{ token: string }>();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-transfer', token],
    queryFn: () => transfersService.getPublic(token as string),
    enabled: !!token,
    retry: false,
  });

  const wrap = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center p-4 bg-background text-theme">
      <div className="w-full max-w-lg rounded-lg border shadow-sm bg-surface border-border-token">
        {children}
      </div>
    </div>
  );


  if (isLoading) return wrap(<div className="p-6"><Loading /></div>);

  if (isError || !data) {
    return wrap(
      <div className="p-8 text-center">
        <AlertCircle className="mx-auto mb-3 h-12 w-12 text-muted-theme" />
        <h1 className="text-xl font-semibold">{t('transfers.public.notFoundTitle', 'Link not found')}</h1>
        <p className="mt-2 text-muted-theme">{t('transfers.public.notFoundBody', 'This transfer link is invalid or has been removed.')}</p>
      </div>,
    );
  }

  if (!data.downloadable) {
    const isLimit = data.status === 'limit_reached';
    return wrap(
      <div className="p-8 text-center">
        <Clock className="mx-auto mb-3 h-12 w-12 text-muted-theme" />
        <h1 className="text-xl font-semibold">
          {isLimit ? t('transfers.public.limitTitle', 'Download limit reached') : t('transfers.public.expiredTitle', 'This link has expired')}
        </h1>
        <p className="mt-2 text-muted-theme">
          {isLimit
            ? t('transfers.public.limitBody', 'This transfer has reached its maximum number of downloads.')
            : t('transfers.public.expiredBody', 'Please ask the sender for a new link.')}
        </p>
      </div>,
    );
  }

  return wrap(
    <div className="p-6">
      <div className="mb-5 text-center">
        <PackageOpen className="mx-auto mb-2 h-10 w-10 text-accent" />
        <h1 className="text-2xl font-bold">{data.title}</h1>
        {data.message && <p className="mt-2 whitespace-pre-line text-muted-theme">{data.message}</p>}
        <p className="mt-2 text-sm text-muted-theme">
          {t('transfers.public.fileSummary', '{{count}} files', { count: data.file_count || 0 })}
          {data.total_bytes ? ` · ${formatBytes(data.total_bytes)}` : ''}
        </p>
      </div>

      {/* Prominent download-all */}
      <a href={transfersService.publicDownloadAllUrl(token as string)} className="block">
        <Button size="lg" leftIcon={<Download className="h-5 w-5" />} className="w-full">
          {t('transfers.downloadAll', 'Download all')}
        </Button>
      </a>

      {data.files && data.files.length > 0 && (
        <ul className="mt-5 border-t border-border-token">
          {data.files.map((f) => (
            <li
              key={f.file_id}
              className="flex items-center justify-between border-b py-2.5 text-sm border-border-token"
            >
              <span className="mr-3 truncate">{f.filename}</span>
              <span className="flex shrink-0 items-center gap-3 text-muted-theme">
                {f.size_bytes ? <span>{formatBytes(f.size_bytes)}</span> : null}
                <a
                  href={transfersService.publicFileUrl(token as string, f.file_id)}
                  className="rounded p-1.5 hover:opacity-70 text-accent"
                  title={t('transfers.public.downloadFile', 'Download')}
                  aria-label={`${t('transfers.public.downloadFile', 'Download')}: ${f.filename}`}
                >
                  <FileDown className="h-4 w-4" />
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}

      {data.expires_at && (
        <p className="mt-5 text-center text-xs text-muted-theme">
          {t('transfers.public.availableUntil', 'Available until {{date}}', { date: format(data.expires_at) })}
        </p>
      )}
    </div>,
  );
};
