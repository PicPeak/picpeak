/**
 * "Insert text block" picker for the quote intro / outro (#1451). Appends
 * the block's text; its {{placeholders}} resolve when the quote is saved.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { QuoteTextBlock } from '../../../services/quoteCatalog.service';

interface Props {
  blocks: QuoteTextBlock[];
  onPick: (body: string) => void;
  id: string;
}

/** Append a block to existing text, separated by a blank line. */
export function appendTextBlock(current: string, body: string) {
  return current && current.trim() ? `${current.replace(/\s+$/, '')}\n\n${body}` : body;
}

export const TextBlockPicker: React.FC<Props> = ({ blocks, onPick, id }) => {
  const { t } = useTranslation();
  if (blocks.length === 0) return null;
  return (
    <select
      id={id}
      aria-label={t('quotes.textBlocks.insert', 'Insert text block…') as string}
      defaultValue=""
      onChange={(e) => {
        const block = blocks.find((b) => b.id === Number(e.target.value));
        if (block) onPick(block.body);
        e.target.value = '';
      }}
      className="text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-2 py-1"
    >
      <option value="" disabled>{t('quotes.textBlocks.insert', 'Insert text block…')}</option>
      {blocks.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </select>
  );
};
