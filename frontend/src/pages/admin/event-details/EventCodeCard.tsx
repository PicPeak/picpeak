/**
 * The gallery's event code (issue 2495), next to the share link card. Guests
 * type it on the fixed entry page /code and land on the share link, so one
 * printed QR code serves every event. The admin can copy it, generate a new
 * one, set their own, or remove it, and download a table card or poster whose
 * QR opens /code with the code printed under it. Event codes are opt-in:
 * while the setting is off the card only says so.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Copy, Download, Hash, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card, Input } from '../../../components/common';
import { useConfirm } from '../../../components/common/ConfirmDialog';
import { eventsService } from '../../../services/events.service';
import { usePermission } from '../../../hooks/usePermission';
import { PUBLIC_SETTINGS_QUERY_KEY, usePublicSettings } from '../../../hooks/usePublicSettings';
import { usePublicBaseUrl } from '../../../hooks/usePublicBaseUrl';
import { isGalleryPublic } from '../../../utils/accessControl';
import { buildShareLinkUrl } from '../../../utils/url';
import { copyText } from '../../../utils/clipboard';
import { saveBlob } from '../../../utils/saveBlob';
import { eventCodeUrl, formatEventCode, isValidEventCode, normalizeEventCode } from '../../../utils/eventCode';

interface EventCodeCardProps {
  event: Event;
  refetchEvent?: () => void;
}

// 409 EVENT_CODES_DISABLED: the setting was switched off after this page
// loaded its public settings.
const codesDisabledError = (err: unknown) =>
  (err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'EVENT_CODES_DISABLED';

export const EventCodeCard: React.FC<EventCodeCardProps> = ({ event, refetchEvent }) => {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const canEdit = usePermission('events.edit');
  const queryClient = useQueryClient();
  const { data: publicSettings, isLoading: settingsLoading } = usePublicSettings();
  // The code page links and QR are for guests: on the public address (issue 2630).
  const publicBaseUrl = usePublicBaseUrl();
  const [code, setCode] = useState<string | null>(event.access_code ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  useEffect(() => { setCode(event.access_code ?? null); }, [event.id, event.access_code]);

  // An admin who may not hand out this gallery's links does not get its code
  // either: the code leads to the share link.
  if (event.share_secrets_hidden || settingsLoading) return null;
  const codesEnabled = publicSettings?.general_event_codes_enabled === true;

  const archived = Boolean(event.is_archived);

  // Codes were switched off elsewhere: say so and reload the settings, so the
  // card turns into its disabled state.
  const handleCodesDisabled = () => {
    toast.error(t('events.eventCode.disabled', 'Event codes are switched off. Turn them on under Settings → General.'));
    queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
  };

  const handleCopy = async (kind: 'code' | 'link') => {
    if (!code) return;
    try {
      await copyText(kind === 'code' ? formatEventCode(code) : eventCodeUrl(code, publicBaseUrl));
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error(t('errors.copyFailed', 'Failed to copy link. Please copy manually.'));
    }
  };

  const handlePrintDownload = async (template: 'table-card' | 'poster') => {
    try {
      const lang = (i18n.language || 'en').split('-')[0];
      saveBlob(await eventsService.getQrPrintBlob(event.id, template, lang, 'code', publicBaseUrl), `qr-code-${template}-${event.slug}.pdf`);
    } catch {
      toast.error(t('errors.downloadFailed', 'Download failed'));
    }
  };

  const handleRegenerate = async () => {
    if (code) {
      const ok = await confirm({
        title: t('events.eventCode.regenerateTitle', 'Generate a new code?'),
        message: t('events.eventCode.regenerateConfirm', 'The current code stops working at once, also on cards that are already printed.'),
        confirmLabel: t('events.eventCode.regenerate', 'New code'),
        variant: 'warning',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const result = await eventsService.regenerateAccessCode(event.id);
      setCode(result.access_code);
      toast.success(t('events.eventCode.saved', 'Event code saved'));
      refetchEvent?.();
    } catch (err) {
      if (codesDisabledError(err)) handleCodesDisabled();
      else toast.error(t('events.eventCode.failed', 'Could not save the event code'));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: t('events.eventCode.removeTitle', 'Remove the event code?'),
      message: t('events.eventCode.removeConfirm', 'The code stops working at once, also on cards that are already printed. The share link keeps working.'),
      confirmLabel: t('events.eventCode.remove', 'Remove code'),
      variant: 'warning',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await eventsService.removeAccessCode(event.id);
      setCode(null);
      toast.success(t('events.eventCode.removed', 'Event code removed'));
      refetchEvent?.();
    } catch {
      toast.error(t('events.eventCode.failed', 'Could not save the event code'));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeEventCode(draft);
    if (!isValidEventCode(normalized)) {
      setError(t('events.eventCode.invalid', 'Use 6 to 12 letters and digits, without 0, O, 1, I or L.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await eventsService.setAccessCode(event.id, normalized);
      setCode(result.access_code);
      setEditing(false);
      toast.success(t('events.eventCode.saved', 'Event code saved'));
      refetchEvent?.();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (codesDisabledError(err)) {
        setEditing(false);
        handleCodesDisabled();
      } else if (status === 409) setError(t('events.eventCode.taken', 'Another gallery already uses this code.'));
      else if (status === 400) setError(t('events.eventCode.invalid', 'Use 6 to 12 letters and digits, without 0, O, 1, I or L.'));
      else setError(t('events.eventCode.failed', 'Could not save the event code'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-heading flex items-center gap-2">
        <Hash className="w-5 h-5" />
        {t('events.eventCode.title', 'Event code')}
      </h2>
      {!codesEnabled ? (
        <p className="text-sm text-soft mt-1" data-testid="event-code-disabled">
          {t('events.eventCode.disabled', 'Event codes are switched off. Turn them on under Settings → General.')}
        </p>
      ) : (
        <>
          <p className="text-sm text-soft mt-1 mb-4">
            {t('events.eventCode.hint', 'Guests enter this code at {{url}} to find the gallery.', { url: buildShareLinkUrl('/code', publicBaseUrl) })}
          </p>

          {editing ? (
            <form onSubmit={handleSave} className="space-y-3" noValidate>
              <Input
                label={t('events.eventCode.customLabel', 'Your own code')}
                value={draft}
                onChange={(e) => setDraft(e.target.value.toUpperCase())}
                error={error || undefined}
                helperText={error ? undefined : t('events.eventCode.invalid', 'Use 6 to 12 letters and digits, without 0, O, 1, I or L.')}
                autoFocus
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                maxLength={24}
                className="font-mono tracking-widest"
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" size="sm" isLoading={busy} disabled={busy}>
                  {t('common.save', 'Save')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(false); setError(null); }} disabled={busy}>
                  {t('common.cancel', 'Cancel')}
                </Button>
              </div>
            </form>
          ) : code ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  className="flex-1 min-w-[10rem] px-3 py-2 bg-inset border border-line-strong rounded-lg text-2xl font-mono font-semibold tracking-widest text-heading"
                  data-testid="event-code-value"
                >
                  {formatEventCode(code)}
                </code>
                <Button
                  variant="outline"
                  size="md"
                  leftIcon={copied === 'code' ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  onClick={() => handleCopy('code')}
                >
                  {copied === 'code' ? t('events.copied') : t('events.copy')}
                </Button>
              </div>
              <button
                type="button"
                className="mt-2 text-sm text-accent hover:underline inline-flex items-center gap-1"
                onClick={() => handleCopy('link')}
              >
                {copied === 'link' ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {t('events.eventCode.copyLink', 'Copy link with the code filled in')}
              </button>
              {archived ? (
                <p className="text-sm text-soft mt-3">{t('events.eventCode.archived', 'An archived gallery does not open with its code.')}</p>
              ) : isGalleryPublic(event.require_password) ? (
                <p className="text-sm text-soft mt-3">{t('events.eventCode.publicWarning', 'This gallery has no password, so anyone who knows the code can open it.')}</p>
              ) : null}
              <div className="mt-4" data-testid="event-code-print">
                <h3 className="text-sm font-medium text-heading">{t('events.eventCode.printTitle', 'Print with the code')}</h3>
                <p className="text-sm text-soft mt-1 mb-2">
                  {t('events.eventCode.printHint', 'The QR code opens {{url}} and is the same for every gallery. The code is printed below it.', { url: buildShareLinkUrl('/code', publicBaseUrl) })}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />} onClick={() => handlePrintDownload('table-card')}>
                    {t('events.qrTableCard', 'Table card (A6)')}
                  </Button>
                  <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />} onClick={() => handlePrintDownload('poster')}>
                    {t('events.qrPoster', 'Poster (A4)')}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-soft">{t('events.eventCode.none', 'This gallery has no code yet.')}</p>
          )}

          {canEdit && !editing && (
            <div className="mt-4 pt-4 border-t border-line flex flex-wrap gap-2">
              <Button variant="outline" size="sm" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={handleRegenerate} isLoading={busy} disabled={busy}>
                {code ? t('events.eventCode.regenerate', 'New code') : t('events.eventCode.generate', 'Generate code')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Pencil className="w-4 h-4" />}
                onClick={() => { setDraft(formatEventCode(code)); setError(null); setEditing(true); }}
                disabled={busy}
              >
                {t('events.eventCode.edit', 'Choose code')}
              </Button>
              {code && (
                <Button variant="outline" size="sm" leftIcon={<Trash2 className="w-4 h-4" />} onClick={handleRemove} disabled={busy}>
                  {t('events.eventCode.remove', 'Remove code')}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
};
