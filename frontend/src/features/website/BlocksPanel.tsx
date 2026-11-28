/**
 * The builder's Blocks panel (issue 2618): the blocks of the open page, in
 * order, or the form of the one that is open.
 */
import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { ArrowLeft, Copy, Plus, Trash2 } from 'lucide-react';
import { Button, Notice } from '../../components/common';
import { BLOCK_ICONS, blockLabel, moveItem } from './blocks';
import { BlockEditor } from './BlockEditor';
import { WebsiteDocContext } from './LinkTargetField';
import { SortableList } from './SortableList';
import { MAX_BLOCKS, firstContactFormId, useBlockActions, type BlockActionsInput } from './useBlockActions';
import type { Block, WebsiteDocument } from './types';

function blockSummary(block: Block): string {
  if ('heading' in block && block.heading) return block.heading;
  if (block.type === 'text') return new DOMParser().parseFromString(block.body, 'text/html').body.textContent?.slice(0, 60) || '';
  if (block.type === 'gallery' || block.type === 'instagram') return `${block.images.length} ×`;
  return '';
}

interface BlocksPanelProps extends BlockActionsInput {
  draft: WebsiteDocument;
  canEdit: boolean;
  /** The branding's colours, offered for a custom background. */
  brandColors?: string[];
}

export const BlocksPanel: React.FC<BlocksPanelProps> = ({ draft, canEdit, brandColors, ...input }) => {
  const { t } = useTranslation();
  const duplicateHintId = useId();
  const { page, block, setBlockId, setAdding } = input;
  const { setPageBlocks, duplicateBlock, deleteBlock } = useBlockActions(input);

  const isExtraContact = block?.type === 'contact' && block.id !== firstContactFormId(page);

  // Why the open block cannot be duplicated, if it cannot.
  const duplicateBlocked = block?.type === 'contact'
    ? t('website.blocks.duplicateContact', 'A page has one contact form, so this block cannot be duplicated.') as string
    : (page.blocks.length >= MAX_BLOCKS ? t('website.blocks.full', 'A page holds at most 60 blocks.') as string : undefined);

  return block ? (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" leftIcon={<ArrowLeft className="w-4 h-4" />} onClick={() => setBlockId(null)}>
          {t('website.blocks.back', 'All blocks')}
        </Button>
        <span className="flex-1" />
        {canEdit && (
          <>
            {/* On a wrapper: a disabled button shows no tooltip of its own everywhere. */}
            <span title={duplicateBlocked}>
              <Button size="icon-sm" variant="ghost" onClick={() => duplicateBlock(block)} disabled={!!duplicateBlocked}
                aria-label={t('website.blocks.duplicate', 'Duplicate block') as string}
                aria-describedby={duplicateBlocked ? duplicateHintId : undefined}>
                <Copy className="w-4 h-4" />
              </Button>
              {duplicateBlocked && <span id={duplicateHintId} className="sr-only">{duplicateBlocked}</span>}
            </span>
            <Button size="icon-sm" variant="ghost" onClick={() => deleteBlock(block)} aria-label={t('website.blocks.delete', 'Remove') as string}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </>
        )}
      </div>
      {/* On its own line: next to the buttons a longer name was cut off. */}
      <h3 className="text-sm font-semibold text-heading">{blockLabel(t, block.type)}</h3>
      {/* Sections are anchored as #b-<block id>: a button or text link can point here. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-subtle border border-line px-3 py-2">
        <span className="text-xs text-muted">{t('website.blocks.anchor', 'Link to this block')}</span>
        <code className="text-xs text-body">{`#b-${block.id}`}</code>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={t('website.blocks.copyAnchor', 'Copy the link to this block') as string}
          onClick={() => {
            navigator.clipboard.writeText(`#b-${block.id}`)
              .then(() => toast.success(t('website.blocks.anchorCopied', 'Link copied. Paste it as a button or text link.')))
              .catch(() => toast.error(t('website.blocks.anchorCopyFailed', 'Could not copy the link.')));
          }}>
          <Copy className="w-4 h-4" />
        </Button>
      </div>
      {isExtraContact && (
        <Notice tone="warning" size="sm">
          {t('website.blocks.extraContact', 'Only one contact form per page is shown, and the draft cannot be saved with two. Remove this one, or move it to another page.')}
        </Notice>
      )}
      <fieldset disabled={!canEdit}>
        <WebsiteDocContext.Provider value={draft}>
          {/* Keyed by page and block: each block gets fresh fields, and the rich
              text editor a fresh undo history (Ctrl+Z in one block never
              brings back another's text). */}
          <BlockEditor
            key={`${page.id}:${block.id}`}
            block={block}
            brandColors={brandColors}
            onChange={(next, field) => setPageBlocks((blocks) => blocks.map((b) => (b.id === next.id ? next : b)), field ? `${next.id}.${field}` : undefined)}
          />
        </WebsiteDocContext.Provider>
      </fieldset>
    </div>
  ) : (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-heading">{t('website.blocks.title', 'Blocks on “{{name}}”', { name: page.title })}</h3>
        {canEdit && (
          <Button size="sm" variant="secondary" leftIcon={<Plus className="w-4 h-4" />} onClick={() => setAdding(true)} disabled={page.blocks.length >= MAX_BLOCKS}>
            {t('website.blocks.add', 'Add block')}
          </Button>
        )}
      </div>
      {page.blocks.length === 0 ? (
        <p className="text-sm text-muted py-6 text-center">{t('website.blocks.empty', 'This page has no blocks yet.')}</p>
      ) : (
        <SortableList
          items={page.blocks}
          getId={(b) => b.id}
          getLabel={(b) => blockLabel(t, b.type)}
          readOnly={!canEdit}
          onMove={(from, to) => { if (canEdit) setPageBlocks((blocks) => moveItem(blocks, from, to)); }}
          renderItem={(b) => {
            const Icon = BLOCK_ICONS[b.type];
            return (
              <button type="button" className="w-full flex items-center gap-2.5 px-1 py-1 text-left" onClick={() => setBlockId(b.id)}>
                <span className="inline-flex w-8 h-8 flex-none items-center justify-center rounded-md bg-inset text-soft"><Icon className="w-4 h-4" aria-hidden="true" /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-heading">{blockLabel(t, b.type)}</span>
                  {blockSummary(b) && <span className="block text-xs text-muted truncate">{blockSummary(b)}</span>}
                </span>
              </button>
            );
          }}
        />
      )}
      <p className="text-xs text-muted">{t('website.blocks.hint', 'Click a block here or in the preview to edit it. Drag to change the order.')}</p>
    </div>
  );
};
