/**
 * The form of one block in the website builder (issue 2618): its layout and
 * background, then the fields of its type (blockForms.tsx).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { BLOCK_VARIANTS, variantLabel } from './blocks';
import { BLOCK_FORMS, type SetBlock } from './blockForms';
import { BackgroundField, ChoiceField } from './fields';
import type { Block } from './types';

interface BlockEditorProps {
  block: Block;
  onChange: (next: Block, field?: string) => void;
  /** The branding's colours, offered for a custom background. */
  brandColors?: string[];
}

export const BlockEditor: React.FC<BlockEditorProps> = ({ block, onChange, brandColors }) => {
  const { t } = useTranslation();
  // Every field edit goes through here, typed per block so a field name is checked.
  const set = <B extends Block>(b: B, patch: Partial<B>, field?: string) => onChange({ ...b, ...patch }, field);

  const common = (
    <>
      {BLOCK_VARIANTS[block.type].length > 1 && (
        <ChoiceField
          label={t('website.fields.layout', 'Layout')}
          value={block.variant}
          options={BLOCK_VARIANTS[block.type].map((v) => ({ value: v, label: variantLabel(t, v) }))}
          onChange={(variant) => onChange({ ...block, variant })}
        />
      )}
      {block.type !== 'customHtml' && <BackgroundField block={block} brandColors={brandColors} onChange={(next) => onChange(next)} />}
    </>
  );

  // One form per block type, with the fields of that block.
  const Form = BLOCK_FORMS[block.type] as React.FC<{ block: Block; set: SetBlock }>;
  return <div className="space-y-4">{common}<Form block={block} set={set} /></div>;
};
