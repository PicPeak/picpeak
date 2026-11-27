/**
 * The website's menu (header) in the Design panel (issue 2618): its design,
 * and its items in their own order, independent of the page order. An item
 * leads to a page, a block, the booking page, a legal page or an address;
 * the server drops one that leads nowhere.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Switch } from '../../components/common';
import { ChoiceField, ColorField, TextField } from './fields';
import { LinkTargetField, WebsiteDocContext } from './LinkTargetField';
import { MAX_MENU_ITEMS } from './menu';
import { SortableList } from './SortableList';
import { moveItem, newId } from './blocks';
import type { MenuItem, WebsiteDocument, WebsiteMenu } from './types';

interface MenuSectionProps {
  doc: WebsiteDocument;
  update: (fn: (doc: WebsiteDocument) => WebsiteDocument, field?: string) => void;
  readOnly: boolean;
}

/** The label an item shows: its own, or its page's (renderer menuLabel). */
function shownLabel(item: MenuItem, doc: WebsiteDocument, t: ReturnType<typeof useTranslation>['t']): string {
  if (item.label) return item.label;
  if (item.target.kind === 'page') {
    const page = doc.pages.find((p) => p.id === (item.target as { pageId: string }).pageId);
    return page ? page.navLabel || page.title : '';
  }
  if (item.target.kind === 'legal') return t(`legal.${item.target.slug}`, item.target.slug);
  if (item.target.kind === 'booking') return t('website.menu.bookLabel', 'Book');
  return '';
}

export const MenuSection: React.FC<MenuSectionProps> = ({ doc, update, readOnly }) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const menu = doc.menu;
  const setMenu = (patch: Partial<WebsiteMenu>, field?: string) => update((d) => ({ ...d, menu: { ...d.menu, ...patch } }), field);
  const patchItem = (id: string, patch: Partial<MenuItem>, field?: string) => update((d) => ({
    ...d, menu: { ...d.menu, items: d.menu.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) },
  }), field ? `menu.${id}.${field}` : undefined);
  const addItem = () => {
    const item: MenuItem = { id: newId(), label: '', hidden: false, target: { kind: 'url', url: '' } };
    setMenu({ items: [...menu.items, item] });
    setEditing(item.id);
  };
  const current = menu.items.find((item) => item.id === editing);

  return (
    <WebsiteDocContext.Provider value={doc}>
      <section className="space-y-4 border-t border-line pt-5">
        <div>
          <h3 className="text-sm font-semibold text-heading">{t('website.menu.title', 'Menu')}</h3>
          <p className="text-xs text-muted">{t('website.menu.intro', 'The menu at the top of every page. Its order is its own; drag the items or use the arrows.')}</p>
        </div>

        <SortableList
          items={menu.items}
          getId={(item) => item.id}
          getLabel={(item) => shownLabel(item, doc, t) || t('website.menu.unnamed', 'Unnamed item')}
          selectedId={editing}
          readOnly={readOnly}
          onMove={(from, to) => setMenu({ items: moveItem(menu.items, from, to) })}
          renderItem={(item) => {
            const label = shownLabel(item, doc, t);
            return (
              <div className="flex items-center gap-1.5 min-w-0 px-1 py-1">
                <span data-menu-label className={`text-sm font-medium truncate ${label ? 'text-heading' : 'text-muted italic'}`}>
                  {label || t('website.menu.unnamed', 'Unnamed item')}
                </span>
                {item.hidden && <Badge tone="neutral" icon={<EyeOff className="w-3 h-3" />}>{t('website.pages.hidden', 'Hidden')}</Badge>}
                <span className="flex-1" />
                {!readOnly && (
                  <Button size="icon-sm" variant="ghost" onClick={() => setEditing(editing === item.id ? null : item.id)}
                    aria-label={t('website.menu.edit', 'Edit menu item {{name}}', { name: label }) as string}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                )}
              </div>
            );
          }}
        />

        {current && !readOnly && (
          <div className="rounded-lg border border-line p-3 space-y-3">
            <TextField label={t('website.menu.label', 'Label')} value={current.label} maxLength={60}
              placeholder={shownLabel({ ...current, label: '' }, doc, t)}
              helperText={current.target.kind === 'page' ? t('website.menu.labelHint', 'Empty: the page’s menu label or title.') : undefined}
              onChange={(label) => patchItem(current.id, { label }, 'label')} />
            <Switch checked={!current.hidden} onChange={(shown) => patchItem(current.id, { hidden: !shown })} label={t('website.menu.shown', 'Shown in the menu')} />
            <LinkTargetField value={current.target} onChange={(target) => { if (target) patchItem(current.id, { target }); }} />
            <Button size="sm" variant="ghost" leftIcon={<Trash2 className="w-4 h-4" />}
              onClick={() => { setMenu({ items: menu.items.filter((item) => item.id !== current.id) }); setEditing(null); }}>
              {t('website.menu.remove', 'Remove from the menu')}
            </Button>
          </div>
        )}

        {!readOnly && (
          <Button size="sm" variant="secondary" leftIcon={<Plus className="w-4 h-4" />} disabled={menu.items.length >= MAX_MENU_ITEMS} onClick={addItem}>
            {t('website.menu.add', 'Add menu item')}
          </Button>
        )}

        <fieldset disabled={readOnly} className="space-y-4">
          <legend className="sr-only">{t('website.menu.design', 'Menu design')}</legend>
          <ChoiceField label={t('website.menu.layout', 'Layout')} value={menu.layout}
            options={[{ value: 'left', label: t('website.menu.layoutLeft', 'Logo left') }, { value: 'center', label: t('website.menu.layoutCenter', 'Logo centred') }]}
            onChange={(layout) => setMenu({ layout: layout as WebsiteMenu['layout'] })} />
          <ChoiceField label={t('website.menu.style', 'Links')} value={menu.style}
            options={[
              { value: 'plain', label: t('website.menu.stylePlain', 'Plain') },
              { value: 'underline', label: t('website.menu.styleUnderline', 'Underlined') },
              { value: 'pill', label: t('website.menu.stylePill', 'Pill') },
            ]}
            onChange={(style) => setMenu({ style: style as WebsiteMenu['style'] })} />
          <ChoiceField label={t('website.menu.mobile', 'On a phone')} value={menu.mobile}
            options={[{ value: 'dropdown', label: t('website.menu.mobileDropdown', 'Small list') }, { value: 'panel', label: t('website.menu.mobilePanel', 'Full width') }]}
            onChange={(mobile) => setMenu({ mobile: mobile as WebsiteMenu['mobile'] })} />
          <Switch checked={menu.sticky} onChange={(sticky) => setMenu({ sticky })}
            label={t('website.menu.sticky', 'Stays at the top while scrolling')} />
          <Switch checked={menu.transparent} onChange={(transparent) => setMenu({ transparent })}
            label={t('website.menu.transparent', 'Transparent over a full-picture hero')}
            description={t('website.menu.transparentHint', 'Only on pages that start with a hero in the “Text on image” style; there the menu scrolls away with the picture.')} />
          <ColorField label={t('website.menu.background', 'Menu background')} value={menu.background}
            emptyLabel={t('website.menu.fromPage', 'Like the page')} onChange={(background) => setMenu({ background }, 'menuBackground')} />
          <ColorField label={t('website.menu.text', 'Menu text')} value={menu.text}
            emptyLabel={t('website.menu.fromPage', 'Like the page')} onChange={(text) => setMenu({ text }, 'menuText')} />
        </fieldset>
      </section>
    </WebsiteDocContext.Provider>
  );
};
