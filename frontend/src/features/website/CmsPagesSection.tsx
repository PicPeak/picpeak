/**
 * The legal and system pages in the website's Pages panel (issue 2618): the
 * CMS pages (Impressum, privacy policy, terms; the not-found and gallery-
 * not-found pages) that the galleries, the website's footer and its unknown
 * addresses show. Edited here through the CMS page editor, not copied; while
 * the website is on, this is the only place that edits them.
 * `?cms=<slug>` (the CMS tab's links) opens that page's editor.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { FileWarning, Scale } from 'lucide-react';
import { Modal, useConfirm } from '../../components/common';
import { CmsPageEditor } from '../../components/admin/cms/CmsPageEditor';
import { useCmsPageTitle } from '../../components/admin/cms/cmsPageTitle';
import { cmsService, isLegalPageSlug, LEGAL_PAGE_SLUGS, type CMSPage } from '../../services/cms.service';

// The order an operator thinks of them in, not the CMS's alphabetical one.
const SYSTEM_ORDER = ['not-found', 'gallery-not-found'];
const byOrder = (order: readonly string[]) => (a: CMSPage, b: CMSPage) => {
  const rank = (slug: string) => (order.includes(slug) ? order.indexOf(slug) : order.length);
  return rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug);
};

export const CmsPagesSection: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(searchParams.get('cms'));
  const [dirty, setDirty] = useState(false);
  const { data: pages = [] } = useQuery({ queryKey: ['cms-pages'], queryFn: cmsService.getPages });
  const legal = pages.filter((p) => isLegalPageSlug(p.slug)).sort(byOrder(LEGAL_PAGE_SLUGS));
  const system = pages.filter((p) => !isLegalPageSlug(p.slug)).sort(byOrder(SYSTEM_ORDER));
  const pageTitle = useCmsPageTitle();
  const title = (slug: string) => pageTitle(slug, pages.find((p) => p.slug === slug));
  const open = editing && pages.some((p) => p.slug === editing) ? editing : null;
  const close = () => { setDirty(false); setEditing(null); };
  // Closing (backdrop, Escape, the close button) drops unsaved edits: ask
  // first, as the CMS tab does when switching pages.
  const requestClose = async () => {
    if (dirty && !(await confirm({
      message: t('cms.discardOnSwitch', 'Discard your unsaved changes to this page?'),
      variant: 'danger',
      confirmLabel: t('common.discard', 'Discard'),
    }))) return;
    close();
  };

  const group = (label: string, list: CMSPage[], Icon: typeof Scale) => (
    <ul aria-label={label} className="space-y-1.5">
      {list.map((page) => (
        <li key={page.slug}>
          <button type="button" disabled={readOnly} onClick={() => setEditing(page.slug)}
            className="w-full flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-left hover:bg-hover disabled:opacity-60 disabled:hover:bg-transparent">
            <Icon className="w-4 h-4 text-soft" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-heading">{title(page.slug)}</span>
              <span className="block text-xs text-muted">/{page.slug}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="space-y-3 border-t border-line pt-5">
      <h3 className="text-sm font-semibold text-heading">{t('website.cmsPages.title', 'Legal & system pages')}</h3>
      <p className="text-xs text-muted">
        {t('website.cmsPages.hint', 'Shown in the website’s design while it is live; the galleries link the same pages.')}
      </p>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{t('website.cmsPages.legal', 'Legal pages')}</h4>
      {group(t('website.cmsPages.legal', 'Legal pages'), legal, Scale)}
      {system.length > 0 && (
        <>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{t('website.cmsPages.system', 'System pages')}</h4>
          {group(t('website.cmsPages.system', 'System pages'), system, FileWarning)}
        </>
      )}
      <Modal open={!!open} onClose={() => { void requestClose(); }} size="xl" title={open ? title(open) : ''}>
        {open && <CmsPageEditor slug={open} saveMode="inline" onDirtyChange={setDirty} onSaved={close} />}
      </Modal>
    </section>
  );
};
