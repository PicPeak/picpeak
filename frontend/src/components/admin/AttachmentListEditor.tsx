/**
 * The attachments of a contract template or a contract (#1445), in delivery
 * order: pick from the attachment library, choose whether each one is merged
 * into the contract PDF (before the signature page) or sent as a separate
 * file, reorder, remove.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '../common';
import {
  documentAttachmentsService, formatAttachmentSize, type AttachmentDelivery,
} from '../../services/documentAttachments.service';

export interface AttachmentRow {
  attachmentId: number;
  delivery: AttachmentDelivery;
  name: string;
  pages: number;
  bytes: number;
  isActive: boolean;
}

const fieldClass = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 px-2 py-1 rounded-md border border-neutral-300 dark:border-neutral-600 '
  + 'bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100';
const iconButton = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 p-1 rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 '
  + 'disabled:opacity-40 hover:bg-neutral-50 dark:hover:bg-neutral-700';

export const AttachmentListEditor: React.FC<{
  idPrefix: string;
  value: AttachmentRow[];
  onChange: (rows: AttachmentRow[]) => void;
  readOnly?: boolean;
}> = ({ idPrefix, value, onChange, readOnly = false }) => {
  const { t } = useTranslation();
  const [pick, setPick] = useState('');
  const { data } = useQuery({
    queryKey: ['document-attachments'],
    queryFn: () => documentAttachmentsService.list(),
    enabled: !readOnly,
  });
  const included = new Set(value.map((row) => row.attachmentId));
  const available = (data?.attachments || []).filter((a) => a.isActive && !included.has(a.id));

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const add = () => {
    const attachment = available.find((a) => a.id === Number(pick));
    if (!attachment) return;
    onChange([...value, {
      attachmentId: attachment.id, delivery: 'merged', name: attachment.name,
      pages: attachment.pages, bytes: attachment.bytes, isActive: true,
    }]);
    setPick('');
  };

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t('contracts.attachments.none', 'No attachments.')}
        </p>
      ) : (
        <ol className="space-y-2">
          {value.map((row, index) => (
            <li key={row.attachmentId} className="rounded border border-neutral-200 dark:border-neutral-700 p-2 flex flex-wrap items-center gap-2">
              <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400 w-6">{index + 1}.</span>
              <span className="flex-1 min-w-[160px] text-sm">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{row.name}</span>
                <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('contracts.attachments.pages', '{{count}} pages', { count: row.pages })} · {formatAttachmentSize(row.bytes)}
                </span>
                {!row.isActive && (
                  <span className="ml-2 text-xs text-red-700 dark:text-red-400">
                    {t('contracts.attachments.archivedInLibrary', 'Archived in the library')}
                  </span>
                )}
              </span>
              <label htmlFor={`${idPrefix}-${row.attachmentId}-delivery`} className="sr-only">
                {t('contracts.attachments.delivery', 'Delivery')}
              </label>
              <select
                id={`${idPrefix}-${row.attachmentId}-delivery`}
                className={fieldClass}
                value={row.delivery}
                disabled={readOnly}
                onChange={(e) => onChange(value.map((r) => (r.attachmentId === row.attachmentId
                  ? { ...r, delivery: e.target.value as AttachmentDelivery } : r)))}
              >
                <option value="merged">{t('contracts.attachments.merged', 'In the contract PDF')}</option>
                <option value="separate">{t('contracts.attachments.separate', 'Separate file')}</option>
              </select>
              {!readOnly && (
                <div className="flex items-center gap-1">
                  <button type="button" className={iconButton} disabled={index === 0} onClick={() => move(index, -1)}
                    aria-label={t('contracts.templates.moveUp', 'Move up') as string}><ArrowUp className="w-3.5 h-3.5" /></button>
                  <button type="button" className={iconButton} disabled={index === value.length - 1} onClick={() => move(index, 1)}
                    aria-label={t('contracts.templates.moveDown', 'Move down') as string}><ArrowDown className="w-3.5 h-3.5" /></button>
                  <button type="button" className={iconButton}
                    onClick={() => onChange(value.filter((r) => r.attachmentId !== row.attachmentId))}
                    aria-label={t('contracts.templates.remove', 'Remove') as string}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('contracts.attachments.mergedHint', 'Attachments in the contract PDF come after the clauses, before the signature page.')}
      </p>
      {!readOnly && (
        <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-700">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor={`${idPrefix}-pick`} className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('contracts.attachments.pick', 'Attachment from the library')}
            </label>
            <select id={`${idPrefix}-pick`} className={`${fieldClass} w-full py-2`} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">—</option>
              {available.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <Button variant="outline" onClick={add} disabled={!pick}>
            <Plus className="w-4 h-4 mr-1" />{t('contracts.attachments.add', 'Add attachment')}
          </Button>
          <Link to="/admin/clients/contracts/attachments" className="text-sm underline text-neutral-700 dark:text-neutral-300 py-2">
            {t('contracts.attachments.manageLibrary', 'Manage the library')}
          </Link>
        </div>
      )}
    </div>
  );
};
