import React, { useState } from 'react';
import { Trash2, AlertTriangle, X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input } from '../common';
import type { Event } from '../../types';

// The exact literal a user must type to confirm bulk deletion. Kept English
// across locales (matching GitHub's repo-deletion pattern) so it can never
// be interpreted as autofillable text or be triggered by passkey/Windows
// Hello flows on a password field — see issue #417.
const CONFIRM_LITERAL = 'DELETE';

interface BulkDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  selectedEvents: Event[];
  isLoading?: boolean;
}

export const BulkDeleteModal: React.FC<BulkDeleteModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  selectedEvents,
  isLoading = false,
}) => {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState('');

  if (!isOpen) return null;

  const count = selectedEvents.length;
  const confirmed = confirmText === CONFIRM_LITERAL;

  const handleSubmit = async () => {
    if (!confirmed || isLoading) return;
    await onConfirm();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-red-700 dark:text-red-400">
              {t('events.bulkDelete.title', 'Permanently delete {{count}} events?', { count })}
            </h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
              disabled={isLoading}
              aria-label={t('common.close', 'Close')}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          {isLoading ? (
            <div className="py-8 text-center">
              <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin text-red-600 dark:text-red-400" />
              <p className="text-sm text-neutral-700 dark:text-neutral-300">
                {t('events.bulkDelete.processing', 'Deleting {{count}} events. This may take a few minutes — please don\'t close this window.', { count })}
              </p>
            </div>
          ) : (
            <>
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800 dark:text-red-200">
                  {t('events.bulkDelete.warning', 'This will permanently delete the selected events, all their photos, archives, and audit logs. This action cannot be undone.')}
                </p>
              </div>

              <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg max-h-40 overflow-y-auto mb-4">
                <ul className="p-3 space-y-1">
                  {selectedEvents.map((event) => (
                    <li key={event.id} className="text-sm text-neutral-700 dark:text-neutral-300">
                      • {event.event_name} ({event.event_type})
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mb-6">
                <Input
                  type="text"
                  label={t(
                    'events.bulkDelete.confirmLabel',
                    'Type {{literal}} to confirm',
                    { literal: CONFIRM_LITERAL }
                  )}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={CONFIRM_LITERAL}
                  helperText={t(
                    'events.bulkDelete.confirmHelp',
                    'A typed confirmation prevents accidental deletions and isn\'t affected by browser autofill or passkey shortcuts.'
                  )}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  onClick={onClose}
                  disabled={isLoading}
                >
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSubmit}
                  disabled={!confirmed || isLoading}
                  leftIcon={<Trash2 className="w-4 h-4" />}
                  className="bg-red-600 hover:bg-red-700 focus:ring-red-500 text-white"
                >
                  {t('events.bulkDelete.submit', 'Delete {{count}} events', { count })}
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
};

BulkDeleteModal.displayName = 'BulkDeleteModal';
