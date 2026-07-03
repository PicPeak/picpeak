import React, { useState } from 'react';
import { X, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input, LocalizedDateInput } from '../common';

interface DuplicateEventDialogProps {
  sourceEventName: string;
  isDuplicating: boolean;
  onConfirm: (data: {
    event_name: string;
    event_date?: string;
    customer_name?: string;
    customer_email?: string;
  }) => void;
  onClose: () => void;
}

/**
 * "Duplicate gallery" dialog (#626) — admin types a fresh event name + date
 * (and optionally a new customer) and the backend clones the source event's
 * branding / behaviour / feedback / categories into a new draft. Photos,
 * the password, the share token and client-access secrets do NOT carry over —
 * those are set fresh on the duplicate. The new event opens in draft mode so
 * the admin can finish customising before publishing via the publish dialog
 * (#627).
 */
export const DuplicateEventDialog: React.FC<DuplicateEventDialogProps> = ({
  sourceEventName,
  isDuplicating,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation();
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = () => {
    if (!eventName.trim()) {
      setError(t('events.duplicateDialog.errorNameRequired', 'Event name is required.'));
      return;
    }
    setError(undefined);
    onConfirm({
      event_name: eventName.trim(),
      event_date: eventDate || undefined,
      customer_name: customerName.trim() || undefined,
      customer_email: customerEmail.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="max-w-md w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {t('events.duplicateDialog.title', 'Duplicate gallery')}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-neutral-600 dark:text-neutral-400 mb-4">
          {t('events.duplicateDialog.description', {
            sourceEventName,
            defaultValue:
              'Creates a new draft gallery that inherits the branding, behaviour, feedback, and category configuration from "{{sourceEventName}}". Photos, password, and share tokens are NOT carried over.',
          })}
        </p>

        <div className="space-y-3 mb-4">
          <Input
            type="text"
            label={t('events.duplicateDialog.eventNameLabel', 'New event name *')}
            placeholder={t('events.duplicateDialog.eventNamePlaceholder', 'e.g. Müller Wedding 2026')}
            value={eventName}
            onChange={(e) => {
              setEventName(e.target.value);
              if (error) setError(undefined);
            }}
            error={error}
          />

          <LocalizedDateInput
            label={t('events.duplicateDialog.eventDateLabel', 'Event date')}
            value={eventDate}
            onChange={setEventDate}
            helperText={t(
              'events.duplicateDialog.eventDateHelp',
              'Leave blank to use a random suffix in the gallery URL. Expiration is recomputed from this date plus the source gallery’s expiration window.',
            )}
          />

          <Input
            type="text"
            label={t('events.duplicateDialog.customerNameLabel', 'Customer name')}
            placeholder={t('events.duplicateDialog.customerNamePlaceholder', 'Optional — fill in later if unknown')}
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
          />

          <Input
            type="email"
            label={t('events.duplicateDialog.customerEmailLabel', 'Customer email')}
            placeholder={t('events.duplicateDialog.customerEmailPlaceholder', 'Optional')}
            value={customerEmail}
            onChange={(e) => setCustomerEmail(e.target.value)}
          />
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isDuplicating}
            className="flex-1"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isDuplicating}
            isLoading={isDuplicating}
            leftIcon={<Copy className="w-4 h-4" />}
            className="flex-1"
          >
            {t('events.duplicateDialog.confirm', 'Create duplicate')}
          </Button>
        </div>
      </Card>
    </div>
  );
};
