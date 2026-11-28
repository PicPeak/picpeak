/**
 * What the builder does to the blocks of the open page (issue 2618): add one
 * (below the selected block, else at the end), duplicate one, remove one,
 * and the write to the draft they share.
 */
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../components/common/ConfirmDialog';
import { createBlock, newId } from './blocks';
import type { useWebsiteEditor } from './useWebsiteEditor';
import type { Block, BlockType, WebsitePage } from './types';

// Mirrors MAX_BLOCKS in backend/src/services/website/document.js.
export const MAX_BLOCKS = 60;

// One contact form a page (the server refuses a second): a page stored
// with more shows only the first.
export const firstContactFormId = (page: WebsitePage): string | undefined => page.blocks.find((b) => b.type === 'contact')?.id;

export interface BlockActionsInput {
  editor: Pick<ReturnType<typeof useWebsiteEditor>, 'update'>;
  page: WebsitePage;
  /** The block that is open in the panel, if one is. */
  block: Block | null;
  setBlockId: (id: string | null) => void;
  /** Opens or closes the "Add a block" dialog. */
  setAdding: (open: boolean) => void;
}

export function useBlockActions({ editor, page, block, setBlockId, setAdding }: BlockActionsInput) {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const setPageBlocks = (fn: (blocks: Block[]) => Block[], field?: string) => editor.update((d) => ({
    ...d, pages: d.pages.map((p) => (p.id === page.id ? { ...p, blocks: fn(p.blocks) } : p)),
  }), field);

  const addBlock = (type: BlockType) => {
    const created = createBlock(type, t);
    const at = block ? page.blocks.findIndex((b) => b.id === block.id) + 1 : page.blocks.length;
    setPageBlocks((blocks) => [...blocks.slice(0, at), created, ...blocks.slice(at)]);
    setBlockId(created.id);
    setAdding(false);
  };

  const duplicateBlock = (b: Block) => {
    // The server refuses a page over the limit; never build one.
    if (page.blocks.length >= MAX_BLOCKS) return;
    const copy = { ...structuredClone(b), id: newId() };
    setPageBlocks((blocks) => {
      const at = blocks.findIndex((x) => x.id === b.id) + 1;
      return [...blocks.slice(0, at), copy, ...blocks.slice(at)];
    });
    setBlockId(copy.id);
  };

  const deleteBlock = async (b: Block) => {
    const ok = await confirm({
      title: t('website.blocks.deleteTitle', 'Remove this block?'),
      message: t('website.blocks.deleteMessage', 'It is removed from the draft. Undo brings it back.'),
      confirmLabel: t('website.blocks.delete', 'Remove'),
      variant: 'danger',
    });
    if (!ok) return;
    setPageBlocks((blocks) => blocks.filter((x) => x.id !== b.id));
    setBlockId(null);
  };

  return { setPageBlocks, addBlock, duplicateBlock, deleteBlock };
}
