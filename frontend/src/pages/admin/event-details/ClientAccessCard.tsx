import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Shield, Key, Copy, CheckCircle } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { eventsService } from '../../../services/events.service';

interface ClientAccessCardProps {
  event: Event;
  refetchEvent: () => void;
}

export const ClientAccessCard: React.FC<ClientAccessCardProps> = ({ event, refetchEvent }) => {
  const { t } = useTranslation();
  const [copiedClientLink, setCopiedClientLink] = useState(false);
  const [clientPin, setClientPin] = useState('');

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
        <Shield className="w-5 h-5" />
        {t('clientAccess.adminTitle')}
      </h2>

      <div className="space-y-4">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
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
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {t('clientAccess.enableToggle')}
            </span>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('clientAccess.enableDescription')}
            </p>
          </div>
        </label>

        {/* !! — SQLite integer boolean; bare 0 renders as literal "0" */}
        {!!event?.client_access_enabled && (
          <>
            {/* Set/Change PIN */}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('clientAccess.pinLabel')}
                </label>
                <input
                  type="text"
                  value={clientPin}
                  onChange={(e) => setClientPin(e.target.value)}
                  placeholder={t('clientAccess.pinPlaceholder')}
                  className="w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm"
                />
              </div>
              <Button
                variant="outline"
                size="md"
                leftIcon={<Key className="w-4 h-4" />}
                onClick={async () => {
                  if (!clientPin.trim()) return;
                  try {
                    await eventsService.updateEvent(event.id, { client_password: clientPin });
                    setClientPin('');
                    toast.success(t('clientAccess.pinUpdated'));
                    refetchEvent();
                  } catch {
                    toast.error(t('common.error'));
                  }
                }}
                disabled={!clientPin.trim()}
              >
                {t('clientAccess.setPin')}
              </Button>
            </div>

            {/* Client access link */}
            {event?.client_share_token && (
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('clientAccess.linkLabel')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={`${window.location.origin}/gallery/${event.slug}/client-access?token=${event.client_share_token}`}
                    readOnly
                    className="flex-1 px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm"
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

                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={async () => {
                    try {
                      await eventsService.updateEvent(event.id, { regenerate_client_token: true });
                      toast.success(t('clientAccess.tokenRegenerated'));
                      refetchEvent();
                    } catch {
                      toast.error(t('common.error'));
                    }
                  }}
                >
                  {t('clientAccess.regenerateToken')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
};
