/**
 * Branded short-URL management for a single event (#699).
 *
 * Each event can have multiple `/s/<slug>` short URLs pointing at it.
 * The public route is bot-UA aware: scrapes get OG (so the short URL
 * is what shows the rich preview in chat), browsers get a 302 to the
 * gallery URL stored at create time.
 *
 * Renders inside the event detail page as a Card. Form to create
 * (custom or auto-generated slug), list of existing short URLs with
 * copy + delete buttons. Errors from the backend's structured codes
 * (INVALID_SLUG, SLUG_TAKEN) surface inline with a "use suggested"
 * shortcut when the server proposes an alternative.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link as LinkIcon, Trash2, Plus, Check } from 'lucide-react';
import { Button, Card, Input } from '../common';
import { shortUrlsService, type GalleryShortUrl } from '../../services/shortUrls.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { toast } from 'react-toastify';

interface Props {
  eventId: number;
}

function buildShortUrl(slug: string): string {
  // Build from window.location so it survives reverse-proxy + custom-
  // domain setups without needing a separate FRONTEND_URL config in the
  // browser bundle. SSR-safe fallback: just the relative path.
  if (typeof window === 'undefined') return `/s/${slug}`;
  return `${window.location.origin}/s/${slug}`;
}

export const ShortUrlsCard: React.FC<Props> = ({ eventId }) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const qc = useQueryClient();

  const [customSlug, setCustomSlug] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [suggested, setSuggested] = useState<string | undefined>();
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const { data: shortUrls = [], isLoading } = useQuery({
    queryKey: ['short-urls', eventId],
    queryFn: () => shortUrlsService.listForEvent(eventId),
  });

  const createMutation = useMutation({
    mutationFn: (slug?: string) => shortUrlsService.create(eventId, slug),
    onSuccess: () => {
      setCustomSlug('');
      setError(undefined);
      setSuggested(undefined);
      qc.invalidateQueries({ queryKey: ['short-urls', eventId] });
      toast.success(t('events.shortUrls.created', 'Short URL created'));
    },
    onError: (err: any) => {
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.error;
      if (code === 'SLUG_TAKEN') {
        setSuggested(err?.response?.data?.suggested);
        setError(t(
          'events.shortUrls.errors.slugTaken',
          'That short URL is already taken — try {{suggested}} instead.',
          { suggested: err?.response?.data?.suggested || '' },
        ) as string);
      } else if (code === 'INVALID_SLUG') {
        setSuggested(undefined);
        setError(msg || (t('events.shortUrls.errors.invalidSlug',
          'Short URLs must be lowercase letters, digits, and hyphens (1–64 chars).') as string));
      } else {
        setSuggested(undefined);
        setError(msg || (t('common.error', 'Something went wrong') as string));
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => shortUrlsService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['short-urls', eventId] });
      toast.success(t('events.shortUrls.deleted', 'Short URL deleted'));
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(customSlug.trim() || undefined);
  };

  const handleUseSuggested = () => {
    if (suggested) {
      setCustomSlug(suggested);
      setError(undefined);
      setSuggested(undefined);
    }
  };

  const handleCopy = async (row: GalleryShortUrl) => {
    const url = buildShortUrl(row.short_slug);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId((current) => (current === row.id ? null : current)), 1500);
    } catch {
      toast.error(t('common.copyFailed', 'Could not copy to clipboard') as string);
    }
  };

  const handleDelete = (row: GalleryShortUrl) => {
    const confirm = window.confirm(t(
      'events.shortUrls.confirmDelete',
      'Delete short URL /s/{{slug}}? The link will stop working immediately.',
      { slug: row.short_slug },
    ) as string);
    if (confirm) deleteMutation.mutate(row.id);
  };

  return (
    <Card padding="md">
      <div className="flex items-center gap-2 mb-3">
        <LinkIcon className="w-5 h-5 text-primary-600 dark:text-primary-400" />
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {t('events.shortUrls.title', 'Branded short URLs')}
        </h3>
      </div>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        {t(
          'events.shortUrls.description',
          'Create memorable links like /s/sofia-graduation that resolve to this gallery. The short URL itself shows the rich social preview when shared — so iMessage, Facebook, WhatsApp etc. see the gallery photo + name even when pasting the short link.',
        )}
      </p>

      {/* Create form */}
      <form onSubmit={handleSubmit} className="mb-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <Input
              value={customSlug}
              onChange={(e) => {
                setCustomSlug(e.target.value.toLowerCase());
                if (error) setError(undefined);
                if (suggested) setSuggested(undefined);
              }}
              placeholder={t('events.shortUrls.slugPlaceholder', 'sofia-graduation (optional)') as string}
              maxLength={64}
              error={error}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={createMutation.isPending}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            {t('events.shortUrls.create', 'Create')}
          </Button>
        </div>
        {suggested && (
          <button
            type="button"
            onClick={handleUseSuggested}
            className="mt-2 text-xs text-primary-600 dark:text-primary-400 underline hover:no-underline"
          >
            {t('events.shortUrls.useSuggested', 'Use “{{suggested}}” instead', { suggested })}
          </button>
        )}
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          {t(
            'events.shortUrls.slugHelp',
            'Leave empty to auto-generate from the gallery name. Allowed characters: lowercase letters, digits, hyphens.',
          )}
        </p>
      </form>

      {/* Existing short URLs */}
      {isLoading ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('common.loading', 'Loading…')}
        </p>
      ) : shortUrls.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('events.shortUrls.empty', 'No short URLs yet. Create one above to share this gallery with a memorable link.')}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {shortUrls.map((row) => (
            <li key={row.id} className="py-3 flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm text-neutral-900 dark:text-neutral-100 break-all">
                  /s/{row.short_slug}
                </div>
                <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('events.shortUrls.hits', '{{count}} hits', { count: row.hit_count })}
                  {row.last_hit_at && (
                    <>
                      {' · '}
                      {t('events.shortUrls.lastHit', 'last {{when}}', { when: formatDateTime(row.last_hit_at) })}
                    </>
                  )}
                  {' · '}
                  {t('events.shortUrls.createdAt', 'created {{when}}', { when: formatDateTime(row.created_at) })}
                </div>
                <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 truncate">
                  → {row.target_path}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => handleCopy(row)}
                  className="p-2 text-neutral-500 hover:text-primary-600 dark:hover:text-primary-400"
                  title={t('common.copy', 'Copy') as string}
                  aria-label={t('common.copy', 'Copy') as string}
                >
                  {copiedId === row.id ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(row)}
                  disabled={deleteMutation.isPending}
                  className="p-2 text-neutral-500 hover:text-red-600"
                  title={t('common.delete', 'Delete') as string}
                  aria-label={t('common.delete', 'Delete') as string}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};
