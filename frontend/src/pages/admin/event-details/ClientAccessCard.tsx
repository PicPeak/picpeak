import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Shield, Key, Copy, CheckCircle } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card, Input, Modal } from '../../../components/common';
import { eventsService } from '../../../services/events.service';

interface ClientAccessCardProps {
  event: Event;
  refetchEvent: () => void;
}

export const ClientAccessCard: React.FC<ClientAccessCardProps> = ({ event, refetchEvent }) => {
  const { t } = useTranslation();
  const [copiedClientLink, setCopiedClientLink] = useState(false);
  const [clientPin, setClientPin] = useState('');
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollPin, setEnrollPin] = useState('');
  const [pinEntrySaving, setPinEntrySaving] = useState(false);
  const [enrollError, setEnrollError] = useState('');
  // The PIN and the client link are the owner's to change (issue 743); a
  // team member sees the link but not these controls. Missing = owner.
  const ownsEvent = event?.can_manage_assignments !== false;

  const regenerateLink = async () => {
    try {
      await eventsService.updateEvent(event.id, { regenerate_client_token: true });
      toast.success(t('clientAccess.tokenRegenerated'));
      refetchEvent();
    } catch {
      toast.error(t('common.error'));
    }
  };

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-heading mb-4 flex items-center gap-2">
        <Shield className="w-5 h-5" />
        {t('clientAccess.adminTitle')}
      </h2>

      <div className="space-y-4">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 w-4 h-4 text-accent border-line-strong rounded focus:ring-accent"
            checked={!!event?.client_access_enabled}
            onChange={async (e) => {
              try {
                await eventsService.updateEvent(event.id, { client_access_enabled: e.target.checked });
                refetchEvent();
              } catch {
                toast.error(t('common.error'));
              }
            }}
            disabled={event?.is_archived}
          />
          <div>
            <span className="text-sm font-medium text-body">
              {t('clientAccess.enableToggle')}
            </span>
            <p className="text-xs text-muted mt-1">
              {t('clientAccess.enableDescription')}
            </p>
          </div>
        </label>

        {/* !! — SQLite integer boolean; bare 0 renders as literal "0" */}
        {!!event?.client_access_enabled && (
          <>
            {ownsEvent && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 w-4 h-4 text-accent border border-line-strong rounded focus:ring-accent"
                  checked={!!event.client_pin_entry_enabled}
                  disabled={event.is_archived || pinEntrySaving}
                  onChange={async (e) => {
                    if (e.target.checked) {
                      setEnrollPin(''); setEnrollError(''); setEnrollOpen(true);
                      return;
                    }
                    setPinEntrySaving(true);
                    try {
                      await eventsService.updateEvent(event.id, { client_pin_entry_enabled: false });
                      await refetchEvent();
                    } catch { toast.error(t('common.error')); }
                    finally { setPinEntrySaving(false); }
                  }}
                />
                <span>
                  <span className="text-sm font-medium text-body">{t('clientAccess.pinEntryToggle', 'Allow PIN entry from the regular gallery')}</span>
                  <span className="block text-xs text-muted mt-1">{t('clientAccess.pinEntryDescription', 'Visitors with the PIN receive full client access, including hidden photos, originals and reveal previews. Turning this off ends PIN-entry sessions; private-link access remains available.')}</span>
                </span>
              </label>
            )}
            {/* Set/Change PIN */}
            {ownsEvent && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-sm font-medium text-body mb-1">
                  {t('clientAccess.pinLabel')}
                </label>
                <input
                  type="text"
                  value={clientPin}
                  onChange={(e) => setClientPin(e.target.value)}
                  minLength={event.client_pin_entry_enabled ? 8 : 6}
                  maxLength={128}
                  placeholder={t('clientAccess.pinPlaceholder')}
                  aria-describedby="client-pin-helper"
                  className="w-full px-3 py-2 bg-inset border border-line-strong text-heading rounded-lg text-sm"
                />
                {/* Not a form, so minLength alone never blocks the save; the
                    handler below checks the floor and this line names it. */}
                <p id="client-pin-helper" className="mt-1 text-xs text-muted">
                  {event.client_pin_entry_enabled ? t('clientAccess.pinEntryPinHelper', 'Gallery PIN entry requires at least 8 characters.') : t('clientAccess.pinHelperText')}
                </p>
              </div>
              <Button
                variant="outline"
                size="md"
                leftIcon={<Key className="w-4 h-4" />}
                onClick={async () => {
                  if (!clientPin.trim()) return;
                  if (event.client_pin_entry_enabled ? Array.from(clientPin.trim()).length < 8 : clientPin.length < 6) {
                    toast.error(event.client_pin_entry_enabled ? t('clientAccess.pinEntryPinHelper', 'Gallery PIN entry requires at least 8 characters.') : t('clientAccess.pinHelperText'));
                    return;
                  }
                  try {
                    await eventsService.updateEvent(event.id, { client_password: clientPin });
                    setClientPin('');
                    toast.success(t('clientAccess.pinUpdated'));
                    refetchEvent();
                  } catch {
                    toast.error(t('common.error'));
                  }
                }}
                disabled={!clientPin.trim() || (event.client_pin_entry_enabled ? Array.from(clientPin.trim()).length < 8 : clientPin.length < 6)}
              >
                {t('clientAccess.setPin')}
              </Button>
            </div>
            )}

            {/* Client access link */}
            {event?.client_share_token && (
              <div>
                <label className="block text-sm font-medium text-body mb-1">
                  {t('clientAccess.linkLabel')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={`${window.location.origin}/gallery/${event.slug}/client-access?token=${event.client_share_token}`}
                    readOnly
                    className="flex-1 px-3 py-2 bg-inset border border-line-strong text-heading rounded-lg text-sm"
                  />
                  <Button
                    variant="outline"
                    size="md"
                    leftIcon={copiedClientLink ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    onClick={async () => {
                      const link = `${window.location.origin}/gallery/${event.slug}/client-access?token=${event.client_share_token}`;
                      try {
                        await navigator.clipboard.writeText(link);
                      } catch {
                        const textArea = document.createElement('textarea');
                        textArea.value = link;
                        document.body.appendChild(textArea);
                        textArea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textArea);
                      }
                      setCopiedClientLink(true);
                      setTimeout(() => setCopiedClientLink(false), 2000);
                    }}
                  >
                    {copiedClientLink ? t('events.copied') : t('events.copy')}
                  </Button>
                </div>

                {ownsEvent && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={regenerateLink}
                >
                  {t('clientAccess.regenerateToken')}
                </Button>
                )}
              </div>
            )}
            {/* No link yet (older galleries): the PIN alone cannot sign a
                client in, so the control that mints one stays reachable. */}
            {!event?.client_share_token && (
              <Button variant="ghost" size="sm" className="text-xs" onClick={regenerateLink}>
                {t('clientAccess.regenerateToken')}
              </Button>
            )}
          </>
        )}
      </div>
      <Modal open={enrollOpen} onClose={() => { if (!pinEntrySaving) { setEnrollOpen(false); setEnrollPin(''); } }}
        title={t('clientAccess.pinEntryEnrollTitle', 'Enable gallery PIN entry')} size="sm" closeOnBackdrop={false}>
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          if (pinEntrySaving || Array.from(enrollPin.trim()).length < 8) return;
          setPinEntrySaving(true); setEnrollError('');
          try {
            await eventsService.updateEvent(event.id, { client_pin_entry_enabled: true, client_password: enrollPin });
            await refetchEvent();
            setEnrollOpen(false); setEnrollPin('');
          } catch {
            setEnrollError(t('clientAccess.pinEntrySaveFailed', 'PIN entry could not be enabled. Check that Client Access is still enabled, then try again.'));
          } finally { setPinEntrySaving(false); }
        }}>
          <p className="text-sm text-body">{t('clientAccess.pinEntryDescription', 'Visitors with the PIN receive full client access, including hidden photos, originals and reveal previews. Turning this off ends PIN-entry sessions; private-link access remains available.')}</p>
          <Input type="password" autoComplete="new-password" label={t('clientAccess.pinLabel')} value={enrollPin}
            minLength={8} maxLength={128} required disabled={pinEntrySaving} onChange={(e) => setEnrollPin(e.target.value)} />
          <p className="text-xs text-muted">{t('clientAccess.pinEntryEnrollHelp', 'Enter the existing PIN again or set a new one with at least 8 characters. On a public gallery, this PIN is the only secret protecting client access.')}</p>
          {enrollError && <p role="alert" className="text-sm text-danger-text">{enrollError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pinEntrySaving} onClick={() => { setEnrollOpen(false); setEnrollPin(''); }}>{t('common.cancel', 'Cancel')}</Button>
            <Button type="submit" disabled={pinEntrySaving || Array.from(enrollPin.trim()).length < 8} isLoading={pinEntrySaving}>
              {t('clientAccess.pinEntryEnrollTitle', 'Enable gallery PIN entry')}
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
};
