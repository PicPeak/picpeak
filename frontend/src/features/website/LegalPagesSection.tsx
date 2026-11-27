/**
 * The legal pages (Impressum, privacy policy, terms) in the website's Pages
 * panel (issue 2618). They are the CMS pages the galleries and the website
 * footer link to: edited here through the CMS page editor, not copied.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { Modal } from '../../components/common';
import { CmsPageEditor } from '../../components/admin/cms/CmsPageEditor';
import { cmsService, LEGAL_PAGE_SLUGS } from '../../services/cms.service';

export const LegalPagesSection: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const { data: pages } = useQuery({ queryKey: ['cms-pages'], queryFn: cmsService.getPages });
  const legal = (pages || []).filter((page) => LEGAL_PAGE_SLUGS.includes(page.slug));
  const title = (slug: string) => t(`legal.${slug}`, { defaultValue: legal.find((p) => p.slug === slug)?.title_en || slug });

  return (
    <section className="space-y-2 border-t border-line pt-5">
      <h3 className="text-sm font-semibold text-heading">{t('website.legal.title', 'Legal pages')}</h3>
      <p className="text-xs text-muted">
        {t('website.legal.hint', 'Linked in the website’s footer and the galleries’. The same pages as in Settings › CMS.')}
      </p>
      <ul className="space-y-1.5">
        {legal.map((page) => (
          <li key={page.slug}>
            <button type="button" disabled={readOnly} onClick={() => setEditing(page.slug)}
              className="w-full flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-left hover:bg-hover disabled:opacity-60 disabled:hover:bg-transparent">
              <Scale className="w-4 h-4 text-soft" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-heading">{title(page.slug)}</span>
                <span className="block text-xs text-muted">/{page.slug}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Modal open={!!editing} onClose={() => setEditing(null)} size="xl" title={editing ? title(editing) : ''}>
        {editing && <CmsPageEditor slug={editing} saveMode="inline" onSaved={() => setEditing(null)} />}
      </Modal>
    </section>
  );
};
