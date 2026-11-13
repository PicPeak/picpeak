/**
 * Website embed (issue 1112, migration 359). Like the slideshow link, every
 * control here acts at once: creating, rotating and removing the embed, and
 * saving the websites allowed to show it.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { CheckCircle, Code, Copy, RotateCw, Trash2 } from 'lucide-react';
import type { Event } from '../../../../types';
import { Button, Notice } from '../../../../components/common';
import { useConfirm } from '../../../../components/common/ConfirmDialog';
import { eventsService } from '../../../../services/events.service';
import { normalizeRequirePassword } from '../../../../utils/accessControl';
import { SectionCard, labelClass } from './sections';

const escapeAttribute = (value: string) => value
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The copy-paste code for the website. */
export function embedSnippet(origin: string, event: Pick<Event, 'slug' | 'event_name'>, token: string): string {
  const src = `${origin}/gallery/${encodeURIComponent(event.slug)}/embed/${token}`;
  return `<iframe src="${escapeAttribute(src)}" title="${escapeAttribute(event.event_name || '')}" `
    + 'width="100%" height="600" style="border:0" loading="lazy" '
    + 'referrerpolicy="strict-origin-when-cross-origin" allow="fullscreen"></iframe>';
}

function parseStoredOrigins(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export const EmbedSection: React.FC<{
  event: Event;
  canAct: boolean;
  onChanged: () => void;
}> = ({ event, canAct, onChanged }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const savedOrigins = parseStoredOrigins(event.embed_allowed_origins).join('\n');
  const [origins, setOrigins] = useState(savedOrigins);
  useEffect(() => { setOrigins(savedOrigins); }, [savedOrigins]);

  const token = event.embed_token ?? null;
  const hasPassword = normalizeRequirePassword(event.require_password, true);
  const snippet = token ? embedSnippet(window.location.origin, event, token) : '';

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      onChanged();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      toast.error(err?.response?.data?.error || t('common.error', 'Error'));
    } finally {
      setBusy(false);
    }
  };

  const generate = () => run(
    () => eventsService.generateEmbedLink(event.id),
    t('embed.admin.created', 'Embed code created'),
  );

  const rotate = async () => {
    const ok = await confirm({
      message: t('embed.admin.rotateConfirm', 'Create a new embed code? Websites that use the current code stop showing the gallery until you replace it there.'),
      variant: 'danger',
    });
    if (ok) await generate();
  };

  const remove = async () => {
    const ok = await confirm({
      message: t('embed.admin.removeConfirm', 'Remove the embed? Websites that show this gallery stop showing it.'),
      variant: 'danger',
    });
    if (!ok) return;
    await run(() => eventsService.disableEmbedLink(event.id), t('embed.admin.removed', 'Embed removed'));
  };

  const saveOrigins = () => run(
    () => eventsService.updateEmbedOrigins(event.id, origins.split(/[\s,]+/).filter(Boolean)),
    t('embed.admin.websitesSaved', 'Websites saved'),
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('common.error', 'Error'));
    }
  };

  return (
    <SectionCard
      description={t('embed.admin.description', 'Show this gallery on your own website as a photo grid. Visitors see the published photos and can open them larger, but cannot download, comment or upload.')}
    >
      {hasPassword && (
        <Notice tone="info" size="sm">
          {token
            ? t('embed.admin.pausedByPassword', 'This gallery has a password, so the embed shows nothing. Remove the password under Access to show it again.')
            : t('embed.admin.needsPublic', 'Only a gallery without a password can be embedded. Remove the password under Access first.')}
        </Notice>
      )}

      {!token ? (
        <div>
          <Button
            variant="primary"
            leftIcon={<Code className="w-4 h-4" />}
            onClick={generate}
            isLoading={busy}
            disabled={!canAct || hasPassword || !!event.is_archived}
          >
            {t('embed.admin.create', 'Create embed code')}
          </Button>
        </div>
      ) : (
        <div>
          <label className={labelClass} htmlFor="embed-snippet">{t('embed.admin.codeLabel', 'Embed code')}</label>
          <textarea
            id="embed-snippet"
            value={snippet}
            readOnly
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full px-3 py-2 bg-inset border border-line-strong text-heading rounded-lg text-xs font-mono"
          />
          <p className="text-xs text-muted mt-1">
            {t('embed.admin.codeHint', 'Paste this into your website where the gallery should appear.')}
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-2">
            <Button
              variant="outline"
              size="sm"
              leftIcon={copied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              onClick={copy}
            >
              {copied ? t('events.copied', 'Copied!') : t('events.copy', 'Copy')}
            </Button>
            {canAct && (
              <>
                <Button variant="ghost" size="sm" className="text-xs" leftIcon={<RotateCw className="w-3.5 h-3.5" />} onClick={rotate} disabled={busy || hasPassword || !!event.is_archived}>
                  {t('embed.admin.rotate', 'New code')}
                </Button>
                <Button variant="ghost" size="sm" className="text-xs text-danger-text" leftIcon={<Trash2 className="w-3.5 h-3.5" />} onClick={remove} disabled={busy}>
                  {t('embed.admin.remove', 'Remove')}
                </Button>
              </>
            )}
          </div>

          <div className="pt-4 mt-4 border-t border-line">
            <label className={labelClass} htmlFor="embed-websites">{t('embed.admin.websitesLabel', 'Allowed websites')}</label>
            <textarea
              id="embed-websites"
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              rows={3}
              placeholder="https://example.com"
              disabled={!canAct}
              className="w-full px-3 py-2 bg-inset border border-line-strong text-heading rounded-lg text-sm font-mono"
            />
            <p className="text-xs text-muted mt-1">
              {t('embed.admin.websitesHint', 'One address per line, e.g. https://example.com or https://*.example.com for all subdomains. Leave empty to allow any website.')}
            </p>
            {canAct && (
              <Button variant="outline" size="sm" className="mt-2" onClick={saveOrigins} disabled={busy || origins === savedOrigins}>
                {t('embed.admin.saveWebsites', 'Save websites')}
              </Button>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
};
