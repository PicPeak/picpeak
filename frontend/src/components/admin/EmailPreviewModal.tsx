import React from 'react';
import { Mail, FileText } from 'lucide-react';
import { Button, Modal } from '../common';

interface EmailPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  subject: string;
  htmlContent: string;
  textContent?: string;
}

export const EmailPreviewModal: React.FC<EmailPreviewModalProps> = ({
  isOpen,
  onClose,
  subject,
  htmlContent,
  textContent
}) => {
  const [viewMode, setViewMode] = React.useState<'html' | 'text'>('html');

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      closeOnBackdrop={false}
      size="xl"
      title={
        <span className="flex items-center gap-3">
          <Mail className="w-6 h-6 text-accent" aria-hidden="true" />
          Email Preview
        </span>
      }
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      {/* Subject */}
      <div className="-mx-6 -mt-4 mb-4 px-6 py-4 border-b border-line bg-subtle">
        <p className="text-sm font-medium text-soft">Subject:</p>
        <p className="text-lg font-semibold text-heading mt-1">{subject}</p>
      </div>

      {/* View mode toggle */}
      <div className="flex gap-2 mb-4">
        <Button
          variant={viewMode === 'html' ? 'primary' : 'outline'}
          size="sm"
          onClick={() => setViewMode('html')}
          leftIcon={<Mail className="w-4 h-4" />}
        >
          HTML View
        </Button>
        {textContent && (
          <Button
            variant={viewMode === 'text' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setViewMode('text')}
            leftIcon={<FileText className="w-4 h-4" />}
          >
            Text View
          </Button>
        )}
      </div>

      {/* Content */}
      {viewMode === 'html' ? (
        <div className="bg-panel border border-line rounded-lg shadow-sm">
          <iframe
            srcDoc={htmlContent}
            className="w-full h-[600px] border-0"
            title="Email Preview"
            // Same posture as the inbound-mail pane: no scripts, no
            // same-origin. The preview needs neither; images and styles
            // still render, and nothing reaches contentDocument.
            sandbox=""
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <div className="bg-subtle border border-line rounded-lg p-6">
          <pre className="whitespace-pre-wrap font-mono text-sm text-body">
            {textContent}
          </pre>
        </div>
      )}
    </Modal>
  );
};
