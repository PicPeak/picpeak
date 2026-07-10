import React from 'react';
import { Archive, AlertTriangle, X } from 'lucide-react';
import { Button, Card } from '../common';
import type { Event } from '../../types';

interface BulkArchiveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  selectedEvents: Event[];
  isLoading?: boolean;
}

export const BulkArchiveModal: React.FC<BulkArchiveModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  selectedEvents,
  isLoading = false,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">Confirm Bulk Archive</h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
              disabled={isLoading}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          <div className="mb-6">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-neutral-700">
                <p className="mb-2">
                  You are about to archive <strong>{selectedEvents.length} event{selectedEvents.length > 1 ? 's' : ''}</strong>. 
                  This action will:
                </p>
                <ul className="list-disc list-inside space-y-1 text-neutral-600">
                  <li>Create a ZIP archive of all photos for each event</li>
                  <li>Make the galleries inaccessible to guests</li>
                  <li>Remove the events from active listings</li>
                  <li>Free up storage space by compressing photos</li>
                </ul>
              </div>
            </div>

            <div className="border border-neutral-200 rounded-lg max-h-48 overflow-y-auto">
              <div className="p-3">
                <h3 className="text-sm font-medium text-neutral-700 mb-2">Events to be archived:</h3>
                <ul className="space-y-1">
                  {selectedEvents.map((event) => (
                    <li key={event.id} className="text-sm text-neutral-600">
                      • {event.event_name} ({event.event_type})
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              isLoading={isLoading}
              leftIcon={<Archive className="w-4 h-4" />}
            >
              Archive {selectedEvents.length} Event{selectedEvents.length > 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};

BulkArchiveModal.displayName = 'BulkArchiveModal';