/**
 * Live Slideshow (migrations 138/139). The link is an action — generating,
 * rotating and disabling it take effect at once — while the style is a
 * setting and saves with the rest of the tab.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { CheckCircle, Copy, MonitorPlay, RotateCw, Trash2 } from 'lucide-react';
import type { Event } from '../../../../types';
import { Button } from '../../../../components/common';
import { SlideshowStyleFields } from '../../../../components/admin/SlideshowStyleFields';
import { useConfirm } from '../../../../components/common/ConfirmDialog';
import { eventsService } from '../../../../services/events.service';
import { categoriesService } from '../../../../services/categories.service';
import type { SlideshowStyle } from '../../../../services/slideshow.service';
import { SectionCard, labelClass } from './sections';

export const SlideshowSection: React.FC<{
  event: Event;
  style: SlideshowStyle | null;
  setStyle: (next: SlideshowStyle) => void;
  canAct: boolean;
  onLinkChanged: () => void;
}> = ({ event, style, setStyle, canAct, onLinkChanged }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const token = event.show_share_token ?? null;
  const link = token ? `${window.location.origin}/gallery/${event.slug}/show/${token}` : '';

  const { data: categories = [] } = useQuery({
    queryKey: ['event-categories', event.id],
    queryFn: () => categoriesService.getEventCategories(event.id),
    staleTime: 60_000,
  });

  const runLinkAction = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      onLinkChanged();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      toast.error(err?.response?.data?.error || t('common.error', 'Error'));
    } finally {
      setBusy(false);
    }
  };

  const generate = () => runLinkAction(
    () => eventsService.generateSlideshowLink(event.id),
    t('slideshow.linkGenerated', 'Slideshow link generated'),
  );

  const disable = async () => {
    const ok = await confirm({
      message: t('slideshow.disableConfirm', 'Disable this slideshow link? The current link will stop working.'),
      variant: 'danger',
    });
    if (!ok) return;
    await runLinkAction(
      () => eventsService.disableSlideshowLink(event.id),
      t('slideshow.linkDisabled', 'Slideshow link disabled'),
    );
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('common.error', 'Error'));
    }
  };

  return (
    <SectionCard
      description={t('slideshow.adminDescription', 'A separate fullscreen link for projectors at live events. It shows all published photos and automatically picks up new uploads while running.')}
    >
      {!token ? (
        <div>
          <Button
            variant="primary"
            leftIcon={<MonitorPlay className="w-4 h-4" />}
            onClick={generate}
            isLoading={busy}
            disabled={!canAct || !!event.is_archived}
          >
            {t('slideshow.generateLink', 'Generate slideshow link')}
          </Button>
        </div>
      ) : (
        <div>
          <label className={labelClass}>{t('slideshow.linkLabel', 'Slideshow link')}</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={link}
              readOnly
              aria-label={t('slideshow.linkLabel', 'Slideshow link')}
              className="flex-1 min-w-0 px-3 py-2 bg-inset border border-line-strong text-heading rounded-lg text-sm"
            />
            <Button
              variant="outline"
              leftIcon={copied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              onClick={copy}
            >
              {copied ? t('events.copied', 'Copied!') : t('events.copy', 'Copy')}
            </Button>
          </div>
          {canAct && (
            <div className="flex flex-wrap items-center gap-3 mt-2">
              <Button variant="ghost" size="sm" className="text-xs" leftIcon={<RotateCw className="w-3.5 h-3.5" />} onClick={generate} disabled={busy || !!event.is_archived}>
                {t('slideshow.regenerate', 'Regenerate')}
              </Button>
              <Button variant="ghost" size="sm" className="text-xs text-danger-text" leftIcon={<Trash2 className="w-3.5 h-3.5" />} onClick={disable} disabled={busy}>
                {t('slideshow.disable', 'Disable')}
              </Button>
            </div>
          )}
        </div>
      )}
      {style && (
        <div className="pt-4 border-t border-line space-y-2">
          <SlideshowStyleFields value={style} onChange={setStyle} categories={categories} />
          <p className="text-xs text-muted">
            {t('slideshow.liveHint', 'Changes apply to a running slideshow within a few seconds — no need to regenerate the link.')}
          </p>
        </div>
      )}
    </SectionCard>
  );
};
