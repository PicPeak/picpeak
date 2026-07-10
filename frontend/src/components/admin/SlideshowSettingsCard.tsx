/**
 * <SlideshowSettingsCard>
 *
 * Per-event "Live Slideshow" ("Diashow") admin surface (migrations 138/139).
 * A token-only fullscreen kiosk link for live events that auto-picks-up new
 * uploads while it runs. Mounted once on the EventDetailsPage; admin can:
 *   - Generate the slideshow link on demand (mints show_share_token)
 *   - Copy / Regenerate (rotate, kills the old link) / Disable it
 *   - Tune the LIVE style (transition, timing, color filter, logo watermark)
 *     via the shared <SlideshowStyleFields>; a running projector picks the
 *     changes up within a few seconds via the show page's settings poll.
 *
 * New events inherit their initial style from the event TYPE preset; this
 * card edits the per-event override. Settings save through
 * PATCH /api/admin/events/:id/slideshow; link actions through
 * POST .../slideshow/{generate,disable}.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { MonitorPlay, Copy, CheckCircle, RotateCw, Trash2, Save } from 'lucide-react';
import { Button, Card } from '../common';
import { eventsService } from '../../services/events.service';
import { categoriesService } from '../../services/categories.service';
import { DEFAULT_SLIDESHOW_STYLE, type SlideshowStyle } from '../../services/slideshow.service';
import { SlideshowStyleFields } from './SlideshowStyleFields';

export interface SlideshowSettingsCardProps {
  eventId: number;
  slug: string;
  isArchived?: boolean;
  initial: {
    show_share_token?: string | null;
    show_interval_ms?: number;
    show_transition?: string;
    show_transition_ms?: number;
    show_watermark?: boolean | null;
    show_colorfilter?: string;
    show_order?: string;
    show_category_id?: number | null;
  };
  onChanged?: () => void;
}

// Tri-state: null/undefined → inherit the global default; true → on; false → off.
function watermarkMode(v: boolean | null | undefined): SlideshowStyle['watermark'] {
  if (v === null || v === undefined) return 'inherit';
  return v ? 'on' : 'off';
}

function styleFromInitial(initial: SlideshowSettingsCardProps['initial']): SlideshowStyle {
  return {
    interval_ms: initial.show_interval_ms ?? DEFAULT_SLIDESHOW_STYLE.interval_ms,
    transition: (initial.show_transition as SlideshowStyle['transition']) ?? DEFAULT_SLIDESHOW_STYLE.transition,
    transition_ms: initial.show_transition_ms ?? DEFAULT_SLIDESHOW_STYLE.transition_ms,
    watermark: watermarkMode(initial.show_watermark),
    colorfilter: (initial.show_colorfilter as SlideshowStyle['colorfilter']) ?? DEFAULT_SLIDESHOW_STYLE.colorfilter,
    order: (initial.show_order as SlideshowStyle['order']) ?? DEFAULT_SLIDESHOW_STYLE.order,
    category_id: initial.show_category_id ?? null,
  };
}

export const SlideshowSettingsCard: React.FC<SlideshowSettingsCardProps> = ({
  eventId, slug, isArchived, initial, onChanged,
}) => {
  const { t } = useTranslation();

  const [token, setToken] = useState<string | null>(initial.show_share_token ?? null);
  const [style, setStyle] = useState<SlideshowStyle>(() => styleFromInitial(initial));
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const link = token ? `${window.location.origin}/gallery/${slug}/show/${token}` : '';

  // Event categories for the slideshow content filter (#202). Global + this
  // event's own categories; empty for events without any → picker hides.
  const { data: categories = [] } = useQuery({
    queryKey: ['event-categories', eventId],
    queryFn: () => categoriesService.getEventCategories(eventId),
    staleTime: 60_000,
  });

  const generate = async () => {
    setBusy(true);
    try {
      const res = await eventsService.generateSlideshowLink(eventId);
      setToken(res.show_share_token);
      toast.success(t('slideshow.linkGenerated', 'Slideshow link generated'));
      onChanged?.();
    } catch (e: any) {
      // Surface the real backend reason (the toast otherwise just says "Error").
      console.error('[slideshow]', e?.response?.status, e?.response?.data || e?.message || e);
      toast.error(e?.response?.data?.error || t('common.error', 'Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!confirm(t('slideshow.disableConfirm', 'Disable this slideshow link? The current link will stop working.'))) {
      return;
    }
    setBusy(true);
    try {
      await eventsService.disableSlideshowLink(eventId);
      setToken(null);
      toast.success(t('slideshow.linkDisabled', 'Slideshow link disabled'));
      onChanged?.();
    } catch (e: any) {
      // Surface the real backend reason (the toast otherwise just says "Error").
      console.error('[slideshow]', e?.response?.status, e?.response?.data || e?.message || e);
      toast.error(e?.response?.data?.error || t('common.error', 'Something went wrong'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await eventsService.updateSlideshowSettings(eventId, {
        show_interval_ms: style.interval_ms,
        show_transition: style.transition,
        show_transition_ms: style.transition_ms,
        // Tri-state → null (inherit global) / true / false. The watermark LOOK
        // is global-only (Settings → Slideshow); we only send the mode here.
        show_watermark: style.watermark === 'inherit' ? null : style.watermark === 'on',
        show_colorfilter: style.colorfilter,
        show_order: style.order,
        show_category_id: style.category_id,
      });
      toast.success(t('slideshow.settingsSaved', 'Slideshow settings saved'));
      onChanged?.();
    } catch (e: any) {
      // Surface the real backend reason (the toast otherwise just says "Error").
      console.error('[slideshow]', e?.response?.status, e?.response?.data || e?.message || e);
      toast.error(e?.response?.data?.error || t('common.error', 'Something went wrong'));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm';
  const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
        <MonitorPlay className="w-5 h-5" />
        {t('slideshow.adminTitle', 'Live Slideshow')}
      </h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
        {t('slideshow.adminDescription', 'A separate fullscreen link for projectors at live events. It shows all published photos and automatically picks up new uploads while running.')}
      </p>

      <div className="space-y-4">
        {!token ? (
          <Button
            variant="primary"
            size="md"
            leftIcon={<MonitorPlay className="w-4 h-4" />}
            onClick={generate}
            isLoading={busy}
            disabled={isArchived}
          >
            {t('slideshow.generateLink', 'Generate slideshow link')}
          </Button>
        ) : (
          <>
            <div>
              <label className={labelClass}>{t('slideshow.linkLabel', 'Slideshow link')}</label>
              <div className="flex items-center gap-2">
                <input type="text" value={link} readOnly className={`flex-1 ${inputClass}`} />
                <Button
                  variant="outline"
                  size="md"
                  leftIcon={copied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  onClick={copy}
                >
                  {copied ? t('events.copied', 'Copied') : t('events.copy', 'Copy')}
                </Button>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  leftIcon={<RotateCw className="w-3.5 h-3.5" />}
                  onClick={generate}
                  disabled={busy || isArchived}
                >
                  {t('slideshow.regenerate', 'Regenerate')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-red-600 dark:text-red-400"
                  leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                  onClick={disable}
                  disabled={busy}
                >
                  {t('slideshow.disable', 'Disable')}
                </Button>
              </div>
            </div>

            {/* Live style settings */}
            <div className="pt-2 border-t border-neutral-200 dark:border-neutral-700">
              <SlideshowStyleFields value={style} onChange={setStyle} categories={categories} />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('slideshow.liveHint', 'Changes apply to a running slideshow within a few seconds — no need to regenerate the link.')}
            </p>
            <Button
              variant="outline"
              size="md"
              leftIcon={<Save className="w-4 h-4" />}
              onClick={saveSettings}
              isLoading={saving}
            >
              {t('slideshow.saveSettings', 'Save slideshow settings')}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
};

export default SlideshowSettingsCard;
