/**
 * Where a button or menu item leads (issue 2618): a page, a block on a page
 * (its anchor, such as the contact form), the booking page, a legal page or
 * an address. Pages and blocks are chosen from the document being edited
 * (WebsiteDocContext), by id, so a renamed page keeps the link.
 */
import React, { createContext, useContext, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { blockLabel } from './blocks';
import { LinkField, labelClass } from './fields';
import type { Block, LinkTarget, WebsiteDocument } from './types';

export const WebsiteDocContext = createContext<WebsiteDocument | null>(null);

const KINDS = ['page', 'anchor', 'booking', 'legal', 'url'] as const;
const LEGAL = ['impressum', 'datenschutz', 'agb'] as const;

const Select: React.FC<{ label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }> = ({ label, value, onChange, children }) => {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
    </div>
  );
};

function blockName(t: ReturnType<typeof useTranslation>['t'], block: Block): string {
  const heading = 'heading' in block && block.heading ? `: ${block.heading}` : '';
  return `${blockLabel(t, block.type)}${heading}`;
}

export const LinkTargetField: React.FC<{
  label?: string;
  value: LinkTarget | null;
  onChange: (value: LinkTarget | null) => void;
}> = ({ label, value, onChange }) => {
  const { t } = useTranslation();
  const doc = useContext(WebsiteDocContext);
  const pages = doc?.pages || [];
  const firstPage = pages[0]?.id || '';
  const kindLabel: Record<(typeof KINDS)[number], string> = {
    page: t('website.link.page', 'A page'),
    anchor: t('website.link.anchor', 'A block on a page'),
    booking: t('website.link.booking', 'The booking page'),
    legal: t('website.link.legal', 'A legal page'),
    url: t('website.link.url', 'An address'),
  };
  const setKind = (kind: string) => {
    switch (kind) {
    case 'page': return onChange({ kind: 'page', pageId: firstPage });
    case 'anchor': return onChange({ kind: 'anchor', pageId: firstPage, blockId: '' });
    case 'booking': return onChange({ kind: 'booking' });
    case 'legal': return onChange({ kind: 'legal', slug: 'impressum' });
    case 'url': return onChange({ kind: 'url', url: '' });
    default: return onChange(null);
    }
  };
  const anchorPage = value?.kind === 'anchor' ? pages.find((p) => p.id === value.pageId) : undefined;

  return (
    <div className="space-y-2">
      <Select label={label || t('website.link.leadsTo', 'Leads to')} value={value?.kind || ''} onChange={setKind}>
        <option value="">{t('website.link.none', 'Nowhere yet')}</option>
        {KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel[kind]}</option>)}
      </Select>
      {(value?.kind === 'page' || value?.kind === 'anchor') && (
        <Select label={t('website.link.whichPage', 'Page')} value={value.pageId}
          onChange={(pageId) => onChange(value.kind === 'page' ? { kind: 'page', pageId } : { kind: 'anchor', pageId, blockId: '' })}>
          {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </Select>
      )}
      {value?.kind === 'anchor' && (
        <Select label={t('website.link.whichBlock', 'Block')} value={value.blockId} onChange={(blockId) => onChange({ ...value, blockId })}>
          <option value="">{t('website.link.chooseBlock', 'Choose a block')}</option>
          {(anchorPage?.blocks || []).map((b) => <option key={b.id} value={b.id}>{blockName(t, b)}</option>)}
        </Select>
      )}
      {value?.kind === 'legal' && (
        <Select label={t('website.link.whichLegal', 'Legal page')} value={value.slug} onChange={(slug) => onChange({ kind: 'legal', slug: slug as (typeof LEGAL)[number] })}>
          {LEGAL.map((slug) => <option key={slug} value={slug}>{t(`legal.${slug}`, slug)}</option>)}
        </Select>
      )}
      {value?.kind === 'url' && (
        <LinkField label={t('website.link.address', 'Address')} value={value.url} onChange={(url) => onChange({ kind: 'url', url })} />
      )}
      {value?.kind === 'anchor' && !value.blockId && (
        <p className="text-xs text-warning-text">{t('website.link.noBlock', 'Choose a block, or the button is not shown.')}</p>
      )}
    </div>
  );
};
