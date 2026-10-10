import React, { useRef, useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal, Notice } from '../common';
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
  const confirmInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const count = selectedEvents.length;
  const confirmed = confirmText === CONFIRM_LITERAL;

  const handleSubmit = async () => {
    if (!confirmed || isLoading) return;
    await onConfirm();
  };

  return (
    <Modal
      open={isOpen}
      onClose={() => { if (!isLoading) onClose(); }}
      closeOnBackdrop={false}
      size="sm"
      initialFocusRef={confirmInputRef}
      title={t('events.bulkDelete.title', 'Permanently delete {{count}} events?', { count })}
      footer={isLoading ? undefined : (
        <>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={handleSubmit}
            disabled={!confirmed || isLoading}
            leftIcon={<Trash2 className="w-4 h-4" />}
          >
            {t('events.bulkDelete.submit', 'Delete {{count}} events', { count })}
          </Button>
        </>
      )}
    >
      {isLoading ? (
        <div className="py-8 text-center">
          <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin text-danger-text" />
          <p className="text-sm text-body">
            {t('events.bulkDelete.processing', 'Deleting {{count}} events. This may take a few minutes — please don\'t close this window.', { count })}
          </p>
        </div>
      ) : (
        <>
          <Notice tone="danger" className="mb-4">
            {t('events.bulkDelete.warning', 'This will permanently delete the selected events, all their photos, archives, and audit logs. This action cannot be undone.')}
          </Notice>

          <div className="border border-line rounded-lg max-h-40 overflow-y-auto mb-4">
            <ul className="p-3 space-y-1">
              {selectedEvents.map((event) => (
                <li key={event.id} className="text-sm text-body">
                  • {event.event_name} ({event.event_type})
                </li>
              ))}
            </ul>
          </div>

          <Input
            ref={confirmInputRef}
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
        </>
      )}
    </Modal>
  );
};

BulkDeleteModal.displayName = 'BulkDeleteModal';
