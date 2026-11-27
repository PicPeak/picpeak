/**
 * Pages of the website (issue 2618): order (= menu order), add, hide, home
 * page, clean address and the search/share texts of the selected page.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Home, EyeOff, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Switch } from '../../components/common';
import { useConfirm } from '../../components/common/ConfirmDialog';
import { SortableList } from './SortableList';
import { createPage, moveItem, slugWhileTyping } from './blocks';
import { ImageField, TextArea, TextField } from './fields';
import { CmsPagesSection } from './CmsPagesSection';
import type { ValidationProblem, WebsiteDocument, WebsitePage } from './types';

// A copy of backend/src/services/website/reservedSlugs.json, held to it by
// backend/__tests__/services/websiteReservedSlugs.test.js. The server is the
// gate; this only answers early.
export const RESERVED_SLUGS = new Set([
  'admin', 'agb', 'api', 'app', 'assets', 'book', 'cgi-bin', 'code', 'contract',
  'customer', 'datenschutz', 'favicon', 'fonts', 'gallery', 'health', 'impressum',
  'index', 'invite', 'login', 'logout', 'not-found', 'og', 'payment-check',
  'photo-checkout', 'photos', 'phpmyadmin', 'purchased-downloads', 'quote', 'robots',
  's', 'setup', 'site-media', 'sitemap', 'static', 'thumbnails', 'transfer',
  'transfer-upload', 'uploads', 'wp-admin', 'wp-content', 'wp-includes',
]);

export function slugProblem(doc: WebsiteDocument, page: WebsitePage): 'empty' | 'reserved' | 'duplicate' | null {
  if (!page.slug) return 'empty';
  if (RESERVED_SLUGS.has(page.slug)) return 'reserved';
  if (doc.pages.some((p) => p.id !== page.id && p.slug === page.slug)) return 'duplicate';
  return null;
}

interface PagesPanelProps {
  doc: WebsiteDocument;
  pageId: string;
  onSelectPage: (id: string) => void;
  update: (fn: (doc: WebsiteDocument) => WebsiteDocument, field?: string) => void;
  serverProblems: ValidationProblem[];
  readOnly: boolean;
}

export const PagesPanel: React.FC<PagesPanelProps> = ({ doc, pageId, onSelectPage, update, serverProblems, readOnly }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const page = doc.pages.find((p) => p.id === pageId) || doc.pages[0];

  const patchPage = (patch: Partial<WebsitePage>, field?: string) => update((d) => ({
    ...d, pages: d.pages.map((p) => (p.id === page.id ? { ...p, ...patch } : p)),
  }), field ? `page.${page.id}.${field}` : undefined);

  const addPage = () => {
    const created = createPage(t, doc.pages);
    update((d) => ({ ...d, pages: [...d.pages, created] }));
    onSelectPage(created.id);
  };

  const makeHome = () => update((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, isHome: p.id === page.id, hidden: p.id === page.id ? false : p.hidden })) }));

  const removePage = async () => {
    const ok = await confirm({
      title: t('website.pages.deleteTitle', 'Delete “{{name}}”?', { name: page.title }),
      message: t('website.pages.deleteMessage', 'The page and its blocks are removed from the draft. Undo brings it back until you leave the editor.'),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    });
    if (!ok) return;
    update((d) => ({ ...d, pages: d.pages.filter((p) => p.id !== page.id) }));
    onSelectPage(doc.pages.find((p) => p.id !== page.id)?.id || '');
  };

  const problem = slugProblem(doc, page);
  const serverProblem = serverProblems.find((p) => p.pageId === page.id);
  const slugError = problem === 'reserved' || serverProblem?.code === 'SLUG_RESERVED'
    ? t('website.pages.slugReserved', 'This address is used by PicPeak itself. Choose another.')
    : problem === 'duplicate' || serverProblem?.code === 'SLUG_DUPLICATE'
      ? t('website.pages.slugDuplicate', 'Another page already has this address.')
      : serverProblem?.code === 'SLUG_TAKEN_BY_CMS_PAGE'
        ? t('website.pages.slugCms', 'A legal or CMS page already uses this address.')
        : problem === 'empty' ? t('website.pages.slugEmpty', 'Enter an address.') : undefined;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-heading">{t('website.pages.title', 'Pages')}</h3>
          {!readOnly && <Button size="sm" variant="secondary" leftIcon={<Plus className="w-4 h-4" />} onClick={addPage} disabled={doc.pages.length >= 30}>{t('website.pages.add', 'Add page')}</Button>}
        </div>
        <p className="text-xs text-muted">{t('website.pages.orderHint', 'The order here is the order of the menu. Legal pages are added to the footer on their own.')}</p>
        <SortableList
          items={doc.pages}
          getId={(p) => p.id}
          getLabel={(p) => p.title}
          selectedId={page.id}
          readOnly={readOnly}
          onMove={(from, to) => { if (!readOnly) update((d) => ({ ...d, pages: moveItem(d.pages, from, to) })); }}
          renderItem={(p) => (
            <button type="button" className="w-full text-left px-1 py-1" onClick={() => onSelectPage(p.id)} aria-current={p.id === page.id}>
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm font-medium text-heading truncate">{p.title}</span>
                {p.isHome && <Badge tone="accent" icon={<Home className="w-3 h-3" />}>{t('website.pages.home', 'Home')}</Badge>}
                {p.hidden && <Badge tone="neutral" icon={<EyeOff className="w-3 h-3" />}>{t('website.pages.hidden', 'Hidden')}</Badge>}
              </span>
              <span className="block text-xs text-muted truncate">{p.isHome ? '/' : `/${p.slug}`}</span>
            </button>
          )}
        />
      </section>

      <CmsPagesSection readOnly={readOnly} />

      {page && (
        <fieldset disabled={readOnly} className="space-y-4 border-t border-line pt-5">
          <legend className="sr-only">{t('website.pages.settings', 'Page settings')}</legend>
          <h3 className="text-sm font-semibold text-heading">{t('website.pages.settingsOf', 'Settings of “{{name}}”', { name: page.title })}</h3>
          <TextField label={t('website.pages.pageTitle', 'Title')} value={page.title} maxLength={120} onChange={(title) => patchPage({ title }, 'title')} />
          <TextField label={t('website.pages.navLabel', 'Menu label (optional)')} value={page.navLabel} maxLength={60} onChange={(navLabel) => patchPage({ navLabel }, 'navLabel')} />
          {/* The home page keeps its address too: the server checks it, and
              /<address> leads to /, so a faulty one must stay fixable here. */}
          <TextField
            label={t('website.pages.slug', 'Address')}
            value={page.slug}
            maxLength={60}
            onChange={(slug) => patchPage({ slug: slugWhileTyping(slug) }, 'slug')}
            error={slugError}
            helperText={slugError ? undefined : page.isHome
              ? t('website.pages.slugHintHome', 'The home page is at the site root; yoursite.com/{{slug}} leads there too.', { slug: page.slug })
              : t('website.pages.slugHint', 'Shown as yoursite.com/{{slug}}', { slug: page.slug })}
          />
          <Switch checked={page.inNav} onChange={(inNav) => patchPage({ inNav })} label={t('website.pages.inNav', 'Show in the menu')} />
          {!page.isHome && (
            <Switch checked={!page.hidden} onChange={(visible) => patchPage({ hidden: !visible })}
              label={t('website.pages.visible', 'Published on the site')}
              description={t('website.pages.visibleHint', 'Off: the page stays in the draft but nobody can open it.')} />
          )}
          {!page.isHome && (
            <Button size="sm" variant="secondary" leftIcon={<Home className="w-4 h-4" />} onClick={makeHome}>{t('website.pages.makeHome', 'Make this the home page')}</Button>
          )}

          <div className="space-y-4 border-t border-line pt-5">
            <h4 className="text-sm font-semibold text-heading">{t('website.pages.seo', 'Search engines and sharing')}</h4>
            <TextField label={t('website.pages.seoTitle', 'Title in search results')} value={page.seo.title} maxLength={120}
              placeholder={page.title} onChange={(title) => patchPage({ seo: { ...page.seo, title } }, 'seoTitle')} />
            <TextArea label={t('website.pages.seoDescription', 'Description')} value={page.seo.description} rows={3} maxLength={300}
              helperText={t('website.pages.seoDescriptionHint', '{{count}}/300 — one or two sentences about this page.', { count: page.seo.description.length })}
              onChange={(description) => patchPage({ seo: { ...page.seo, description } }, 'seoDescription')} />
            <ImageField label={t('website.pages.seoImage', 'Image when shared (optional)')} value={page.seo.image}
              onChange={(image) => patchPage({ seo: { ...page.seo, image } })} />
          </div>

          {!page.isHome && (
            <div className="border-t border-line pt-5">
              <Button size="sm" variant="danger" leftIcon={<Trash2 className="w-4 h-4" />} onClick={removePage}>{t('website.pages.delete', 'Delete page')}</Button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
};
