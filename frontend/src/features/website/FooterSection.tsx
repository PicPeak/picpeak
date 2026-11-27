/**
 * The website's footer in the Design panel (issue 2618): its columns in
 * their own order (the branding's name and texts, the pages, a list of
 * links, a text, contact details, social links), where the legal links go,
 * the copyright line and the background. A new website's footer is the one
 * the website always had: name and tagline, pages, legal links.
 */
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button, Notice } from '../../components/common';
import { ChoiceField, ColorField, RichTextField, TextArea, TextField, labelClass } from './fields';
import { SocialLinksField } from './itemForms';
import { LinkTargetField, WebsiteDocContext } from './LinkTargetField';
import { SortableList } from './SortableList';
import { moveItem, newId } from './blocks';
import type { FooterColumn, FooterColumnKind, LinkTarget, WebsiteDocument, WebsiteFooter } from './types';

const MAX_COLUMNS = 4;
const MAX_LINKS = 12;
const KINDS: FooterColumnKind[] = ['brand', 'pages', 'links', 'text', 'contact', 'social'];

interface FooterSectionProps {
  doc: WebsiteDocument;
  update: (fn: (doc: WebsiteDocument) => WebsiteDocument, field?: string) => void;
  readOnly: boolean;
}

function newColumn(kind: FooterColumnKind): FooterColumn {
  const id = newId();
  switch (kind) {
  case 'links': return { id, kind, heading: '', links: [] };
  case 'text': return { id, kind, heading: '', text: '' };
  case 'contact': return { id, kind, heading: '', email: '', phone: '', address: '' };
  case 'social': return { id, kind, heading: '', social: [] };
  default: return { id, kind, heading: '' };
  }
}

const LinksEditor: React.FC<{ links: { label: string; target: LinkTarget }[]; onChange: (links: { label: string; target: LinkTarget }[]) => void }> = ({ links, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {links.map((link, index) => (
        <div key={index} className="rounded-lg border border-line p-3 space-y-2">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextField label={t('website.footer.linkLabel', 'Link text')} value={link.label} maxLength={60}
                onChange={(label) => onChange(links.map((l, i) => (i === index ? { ...l, label } : l)))} />
            </div>
            <Button size="icon-sm" variant="ghost" aria-label={t('website.footer.removeLink', 'Remove link {{n}}', { n: index + 1 }) as string}
              onClick={() => onChange(links.filter((_, i) => i !== index))}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
          <LinkTargetField value={link.target} onChange={(target) => { if (target) onChange(links.map((l, i) => (i === index ? { ...l, target } : l))); }} />
        </div>
      ))}
      <Button size="sm" variant="secondary" leftIcon={<Plus className="w-4 h-4" />} disabled={links.length >= MAX_LINKS}
        onClick={() => onChange([...links, { label: '', target: { kind: 'url', url: '' } }])}>
        {t('website.footer.addLink', 'Add link')}
      </Button>
    </div>
  );
};

export const FooterSection: React.FC<FooterSectionProps> = ({ doc, update, readOnly }) => {
  const { t } = useTranslation();
  const newKindId = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<FooterColumnKind>('links');
  const footer = doc.footer;
  const setFooter = (patch: Partial<WebsiteFooter>, field?: string) => update((d) => ({ ...d, footer: { ...d.footer, ...patch } }), field);
  const patchColumn = (id: string, patch: Partial<FooterColumn>, field?: string) => update((d) => ({
    ...d, footer: { ...d.footer, columns: d.footer.columns.map((c) => (c.id === id ? { ...c, ...patch } as FooterColumn : c)) },
  }), field ? `footer.${id}.${field}` : undefined);
  const kindName: Record<FooterColumnKind, string> = {
    brand: t('website.footer.kindBrand', 'Company and tagline'),
    pages: t('website.footer.kindPages', 'Pages'),
    links: t('website.footer.kindLinks', 'Links'),
    text: t('website.footer.kindText', 'Text'),
    contact: t('website.footer.kindContact', 'Contact details'),
    social: t('website.footer.kindSocial', 'Social links'),
  };
  const current = footer.columns.find((c) => c.id === editing);

  return (
    <WebsiteDocContext.Provider value={doc}>
      <section className="space-y-4 border-t border-line pt-5">
        <div>
          <h3 className="text-sm font-semibold text-heading">{t('website.footer.title', 'Footer')}</h3>
          <p className="text-xs text-muted">{t('website.footer.intro', 'Up to four columns at the bottom of every page, then the copyright line.')}</p>
        </div>

        <SortableList
          items={footer.columns}
          getId={(c) => c.id}
          getLabel={(c) => c.heading || kindName[c.kind]}
          selectedId={editing}
          readOnly={readOnly}
          onMove={(from, to) => setFooter({ columns: moveItem(footer.columns, from, to) })}
          renderItem={(c) => (
            <div className="flex items-center gap-1.5 min-w-0 px-1 py-1">
              <span className="min-w-0">
                <span data-footer-column className="block text-sm font-medium text-heading truncate">{c.heading || kindName[c.kind]}</span>
                {c.heading && <span className="block text-xs text-muted">{kindName[c.kind]}</span>}
              </span>
              <span className="flex-1" />
              {!readOnly && (
                <Button size="icon-sm" variant="ghost" onClick={() => setEditing(editing === c.id ? null : c.id)}
                  aria-label={t('website.footer.edit', 'Edit column {{name}}', { name: c.heading || kindName[c.kind] }) as string}>
                  <Pencil className="w-4 h-4" />
                </Button>
              )}
            </div>
          )}
        />

        {current && !readOnly && (
          <div className="rounded-lg border border-line p-3 space-y-3">
            <TextField label={t('website.footer.heading', 'Column heading (optional)')} value={current.heading} maxLength={80}
              onChange={(heading) => patchColumn(current.id, { heading }, 'heading')} />
            {current.kind === 'brand' && (
              <p className="text-xs text-muted">{t('website.footer.brandHint', 'Your company name, tagline and footer text from the branding settings.')}</p>
            )}
            {current.kind === 'pages' && (
              <p className="text-xs text-muted">{t('website.footer.pagesHint', 'Every published page, in page order.')}</p>
            )}
            {current.kind === 'text' && (
              <RichTextField label={t('website.fields.body', 'Text')} value={current.text} onChange={(text) => patchColumn(current.id, { text }, 'text')} />
            )}
            {current.kind === 'links' && (
              <LinksEditor links={current.links} onChange={(links) => patchColumn(current.id, { links })} />
            )}
            {current.kind === 'contact' && (
              <>
                <TextField label={t('website.footer.email', 'E-mail')} value={current.email} maxLength={254} onChange={(email) => patchColumn(current.id, { email }, 'email')} />
                <TextField label={t('website.footer.phone', 'Phone')} value={current.phone} maxLength={40} onChange={(phone) => patchColumn(current.id, { phone }, 'phone')} />
                <TextArea label={t('website.footer.address', 'Address')} value={current.address} rows={3} maxLength={300} onChange={(address) => patchColumn(current.id, { address }, 'address')} />
              </>
            )}
            {current.kind === 'social' && (
              <SocialLinksField value={current.social} onChange={(social) => patchColumn(current.id, { social })} />
            )}
            <Button size="sm" variant="ghost" leftIcon={<Trash2 className="w-4 h-4" />}
              onClick={() => { setFooter({ columns: footer.columns.filter((c) => c.id !== current.id) }); setEditing(null); }}>
              {t('website.footer.removeColumn', 'Remove column')}
            </Button>
          </div>
        )}

        {!readOnly && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor={newKindId} className={labelClass}>{t('website.footer.newColumn', 'New column')}</label>
              <select id={newKindId} className="input" value={newKind} onChange={(e) => setNewKind(e.target.value as FooterColumnKind)}>
                {KINDS.map((kind) => <option key={kind} value={kind}>{kindName[kind]}</option>)}
              </select>
            </div>
            <Button size="sm" variant="secondary" leftIcon={<Plus className="w-4 h-4" />} disabled={footer.columns.length >= MAX_COLUMNS}
              onClick={() => { const column = newColumn(newKind); setFooter({ columns: [...footer.columns, column] }); setEditing(column.id); }}>
              {t('website.footer.addColumn', 'Add column')}
            </Button>
          </div>
        )}

        <fieldset disabled={readOnly} className="space-y-4">
          <legend className="sr-only">{t('website.footer.design', 'Footer settings')}</legend>
          <ChoiceField label={t('website.footer.legal', 'Legal links')} value={footer.legal}
            options={[
              { value: 'column', label: t('website.footer.legalColumn', 'As a column') },
              { value: 'bottom', label: t('website.footer.legalBottom', 'Next to the copyright') },
              { value: 'off', label: t('website.footer.legalOff', 'Not shown') },
            ]}
            onChange={(legal) => setFooter({ legal: legal as WebsiteFooter['legal'] })} />
          {footer.legal === 'off' && (
            <Notice tone="warning" size="sm">
              {t('website.footer.legalOffWarning', 'In many countries a website must link its legal notice and privacy policy on every page. Link them in the menu or a links column then.')}
            </Notice>
          )}
          <TextField label={t('website.footer.copyright', 'Copyright line')} value={footer.copyright} maxLength={200}
            placeholder={t('website.footer.copyrightPlaceholder', '© {year} Your company') as string}
            helperText={t('website.footer.copyrightHint', 'Empty: © year and company name. {year} is replaced with the current year.')}
            onChange={(copyright) => setFooter({ copyright }, 'copyright')} />
          <ChoiceField label={t('website.footer.background', 'Background')} value={footer.background}
            options={[
              { value: 'default', label: t('website.footer.bgDefault', 'Light') },
              { value: 'dark', label: t('website.background.dark', 'Dark') },
              { value: 'custom', label: t('website.background.custom', 'Custom') },
            ]}
            onChange={(background) => setFooter(background === 'custom'
              ? { background: 'custom', backgroundColor: footer.backgroundColor || '#1c1917', textColor: footer.textColor ?? null }
              : { background: background as WebsiteFooter['background'] })} />
          {footer.background === 'custom' && (
            <>
              <ColorField label={t('website.footer.bgColor', 'Footer colour')} value={footer.backgroundColor || null}
                onChange={(backgroundColor) => setFooter(backgroundColor ? { backgroundColor } : { background: 'default' })} />
              <ColorField label={t('website.background.textColour', 'Text colour')} value={footer.textColor ?? null}
                emptyLabel={t('website.background.textAutomatic', 'Automatic, for contrast')} onChange={(textColor) => setFooter({ textColor })} />
            </>
          )}
        </fieldset>
      </section>
    </WebsiteDocContext.Provider>
  );
};
