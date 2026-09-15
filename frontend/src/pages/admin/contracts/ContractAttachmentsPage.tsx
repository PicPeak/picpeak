/**
 * Admin → Contracts → Attachments (#1445). The library of PDFs that contract
 * templates and contracts include. A file is stored once and never changed;
 * uploading the same file again finds the existing entry. Archived entries
 * stay listed (contracts that include them keep working) but can't be added
 * to templates or contracts.
 */
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Upload } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card, Input, Loading } from '../../../components/common';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import {
  documentAttachmentsService, formatAttachmentSize, ATTACHMENT_MAX_BYTES, type DocumentAttachment,
} from '../../../services/documentAttachments.service';
import { templateError } from '../../../services/contractTemplates.service';

const UPLOAD_ERRORS: Record<string, [string, string]> = {
  PDF_TOO_LARGE: ['contracts.attachments.errors.tooLarge', 'The file is larger than 20 MB.'],
  PDF_NOT_A_PDF: ['contracts.attachments.errors.notPdf', 'That file isn\'t a PDF.'],
  PDF_ENCRYPTED: ['contracts.attachments.errors.encrypted', 'The PDF is password-protected. Save it without a password and upload it again.'],
  PDF_MALFORMED: ['contracts.attachments.errors.malformed', 'The PDF can\'t be read. Export it again from the original and upload that.'],
  PDF_ACTIVE_CONTENT: ['contracts.attachments.errors.activeContent', 'The PDF contains scripts, form fields or embedded files. Print it to a new PDF ("Save as PDF") and upload that.'],
  PDF_EMPTY: ['contracts.attachments.errors.empty', 'The PDF has no pages.'],
  PDF_TOO_MANY_PAGES: ['contracts.attachments.errors.tooManyPages', 'The PDF has more than 100 pages.'],
};

export const ContractAttachmentsPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { formatDateTime } = useLocalizedDate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['document-attachments'],
    queryFn: () => documentAttachmentsService.list(),
  });
  const attachments = data?.attachments || [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['document-attachments'] });

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setProblem(null);
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setProblem(t(...UPLOAD_ERRORS.PDF_TOO_LARGE) as string);
      return;
    }
    setBusy(true);
    try {
      const result = await documentAttachmentsService.upload(file, { name: name.trim(), description: description.trim() });
      await refresh();
      toast.success(result.existing
        ? t('contracts.attachments.alreadyThere', 'This file is already in the library as "{{name}}".', { name: result.attachment.name })
        : t('contracts.attachments.uploaded', 'Attachment added'));
      setFile(null);
      setName('');
      setDescription('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      const { message, code } = templateError(err);
      const known = code ? UPLOAD_ERRORS[code] : undefined;
      setProblem(known ? t(...known) as string : (message || t('contracts.attachments.uploadFailed', 'The file could not be uploaded.') as string));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (attachment: DocumentAttachment) => {
    setBusy(true);
    try {
      if (attachment.isActive) await documentAttachmentsService.archive(attachment.id);
      else await documentAttachmentsService.restore(attachment.id);
      await refresh();
    } catch (err) {
      toast.error(templateError(err).message || t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const open = async (attachment: DocumentAttachment) => {
    try {
      const url = await documentAttachmentsService.downloadUrl(attachment.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(templateError(err).message || t('contracts.templates.actionFailed', 'That didn\'t work. Please try again.'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/admin/clients/contracts" className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label={t('contracts.templates.back', 'Back to contracts') as string}>
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-2xl font-bold flex-1 text-neutral-900 dark:text-neutral-100">
          {t('contracts.attachments.title', 'Contract attachments')}
        </h1>
      </div>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-3xl">
        {t('contracts.attachments.intro', 'PDFs that go out with contracts — terms and conditions, a privacy notice, an appendix. Add them to a template or a single contract, either inside the contract PDF or as a separate file.')}
      </p>

      <PermissionGate permission="contracts.templates.manage">
        <Card padding="md">
          <form onSubmit={upload} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="attachment-file" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('contracts.attachments.file', 'PDF (up to 20 MB)')}
                </label>
                <input
                  id="attachment-file"
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="block w-full text-sm text-neutral-700 dark:text-neutral-300"
                  onChange={(e) => {
                    const picked = e.target.files?.[0] || null;
                    setFile(picked);
                    if (picked && !name) setName(picked.name.replace(/\.pdf$/i, ''));
                  }}
                />
              </div>
              <Input id="attachment-name" label={t('contracts.attachments.name', 'Name') as string} value={name}
                maxLength={255} onChange={(e) => setName(e.target.value)} />
              <div className="md:col-span-2">
                <Input id="attachment-description" label={t('contracts.attachments.description', 'Description (optional)') as string}
                  value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </div>
            {problem && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">{problem}</p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !file}>
                <Upload className="w-4 h-4 mr-1" />{t('contracts.attachments.upload', 'Upload')}
              </Button>
            </div>
          </form>
        </Card>
      </PermissionGate>

      {isLoading ? <Loading /> : (
        <Card padding="md">
          {attachments.length === 0 ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('contracts.attachments.empty', 'No attachments yet.')}</p>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
              {attachments.map((a) => (
                <li key={a.id} className={`py-3 flex flex-wrap items-center gap-3 ${a.isActive ? '' : 'opacity-60'}`}>
                  <div className="flex-1 min-w-[200px]">
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">
                      {a.name}
                      {!a.isActive && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-200">
                          {t('contracts.attachments.archived', 'Archived')}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('contracts.attachments.pages', '{{count}} pages', { count: a.pages })} · {formatAttachmentSize(a.bytes)} · {formatDateTime(a.createdAt)}
                      {a.description ? ` · ${a.description}` : ''}
                    </p>
                    <p className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400 break-all" title={a.sha256}>
                      {a.sha256.slice(0, 16)}…
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => open(a)}>{t('contracts.attachments.open', 'Open')}</Button>
                    <PermissionGate permission="contracts.templates.manage">
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => toggle(a)}>
                        {a.isActive ? t('contracts.templates.archive', 'Archive') : t('contracts.templates.restore', 'Restore')}
                      </Button>
                    </PermissionGate>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
};
