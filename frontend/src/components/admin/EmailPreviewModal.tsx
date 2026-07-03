import React from 'react';
import { X, Mail, FileText } from 'lucide-react';
import { Button, Card } from '../common';

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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-700">
          <div className="flex items-center gap-3">
            <Mail className="w-6 h-6 text-accent" />
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">Email Preview</h2>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Subject */}
        <div className="px-6 py-4 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Subject:</p>
          <p className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mt-1">{subject}</p>
        </div>

        {/* View mode toggle */}
        <div className="px-6 py-3 border-b border-neutral-200 dark:border-neutral-700">
          <div className="flex gap-2">
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
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {viewMode === 'html' ? (
            <div className="bg-white border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-sm">
              <iframe
                srcDoc={htmlContent}
                className="w-full h-[600px] border-0"
                title="Email Preview"
                sandbox="allow-same-origin"
              />
            </div>
          ) : (
            <div className="bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg p-6">
              <pre className="whitespace-pre-wrap font-mono text-sm text-neutral-700 dark:text-neutral-300">
                {textContent}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-6 border-t border-neutral-200 dark:border-neutral-700">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </Card>
    </div>
  );
};