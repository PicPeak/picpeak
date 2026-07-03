import React, { useState } from 'react';
import { X, Copy, Check, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Button, Card } from '../common';

interface ExportPreviewModalProps {
  format: 'txt' | 'csv';
  content: string;
  filename: string;
  onClose: () => void;
}

/**
 * Inline preview for text-based photo exports (#631).
 *
 * Daniel reported in #623 that the Lightroom TXT export was effectively
 * unusable as a file download — admins re-open the file, select-all, copy,
 * paste into Lightroom's search field. He suggested a modal with a
 * copy-to-clipboard button as a follow-up. Same workflow applies to the
 * CSV export (paste straight into Sheets / Excel).
 *
 * The modal preserves the file-download path so admins who want the file
 * (sharing with colleagues, archiving, post-processing tooling) aren't
 * worse off. XMP (ZIP archive) and JSON exports stay direct downloads —
 * neither makes sense as a textarea preview.
 */
export const ExportPreviewModal: React.FC<ExportPreviewModalProps> = ({
  format,
  content,
  filename,
  onClose,
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast.success(t('export.preview.copied', 'Copied to clipboard.'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Some browsers (older Safari, hardened sandboxes) reject
      // clipboard writes. Fall back to manual select-all so the admin
      // can Cmd/Ctrl+C themselves; doesn't fail silently.
      toast.error(
        t('export.preview.copyFailed', 'Clipboard write blocked. Select the text and copy manually.'),
      );
    }
  };

  const handleDownload = () => {
    const blob = new Blob([content], {
      type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8',
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const titleKey = format === 'csv' ? 'export.preview.titleCsv' : 'export.preview.titleTxt';
  const titleDefault = format === 'csv' ? 'CSV export' : 'Lightroom filename list';
  const helpKey = format === 'csv'
    ? 'export.preview.helpCsv'
    : 'export.preview.helpTxt';
  const helpDefault = format === 'csv'
    ? 'Paste into a spreadsheet (Google Sheets, Excel, Numbers) — the first row is the column header.'
    : 'Paste into Lightroom\'s filename search. The list is comma-separated with no extension so it matches a catalog that holds RAW files.';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="max-w-2xl w-full">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {t(titleKey, titleDefault)}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
          {t(helpKey, helpDefault)}
        </p>

        <textarea
          readOnly
          value={content}
          onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          className="w-full h-64 p-3 rounded-md border border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900 text-sm font-mono text-neutral-900 dark:text-neutral-100 mb-4"
        />

        <div className="flex gap-2 justify-between items-center">
          <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono truncate">
            {filename}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleDownload}
              leftIcon={<Download className="w-4 h-4" />}
            >
              {t('export.preview.download', 'Download as file')}
            </Button>
            <Button
              variant="primary"
              onClick={handleCopy}
              leftIcon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            >
              {copied
                ? t('export.preview.copiedShort', 'Copied')
                : t('export.preview.copyButton', 'Copy to clipboard')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};
