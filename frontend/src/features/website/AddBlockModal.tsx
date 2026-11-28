/**
 * The builder's "Add a block" dialog (issue 2618): every block type, with
 * what it is for.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/common';
import { BLOCK_ICONS, BLOCK_TYPES, blockLabel } from './blocks';
import { firstContactFormId, useBlockActions, type BlockActionsInput } from './useBlockActions';

export const AddBlockModal: React.FC<BlockActionsInput & { adding: boolean }> = ({ adding, ...input }) => {
  const { t } = useTranslation();
  const { setAdding } = input;
  const { addBlock } = useBlockActions(input);
  const firstContactId = firstContactFormId(input.page);
  return (
    <Modal open={adding} onClose={() => setAdding(false)} size="xl" title={t('website.blocks.addTitle', 'Add a block')}
      description={t('website.blocks.addDescription', 'It is added below the selected block, or at the end of the page.')}>
      <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {BLOCK_TYPES.map((type) => {
          const Icon = BLOCK_ICONS[type];
          const taken = type === 'contact' && !!firstContactId;
          return (
            <li key={type}>
              <button type="button" onClick={() => addBlock(type)} disabled={taken}
                className="w-full h-full text-left rounded-xl border border-line p-3 hover:border-accent hover:bg-hover-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 disabled:hover:border-line disabled:hover:bg-transparent disabled:cursor-not-allowed">
                <Icon className="w-5 h-5 text-soft mb-2" aria-hidden="true" />
                <span className="block text-sm font-medium text-heading">{blockLabel(t, type)}</span>
                <span className="block text-xs text-muted mt-0.5">
                  {taken ? t('website.blocks.contactTaken', 'This page already has a contact form.') : t(`website.blocks.${type}.description`)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
};
