import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { Card, Loading, Notice, useConfirm } from '../../components/common';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { CmsPageEditor } from '../../components/admin/cms/CmsPageEditor';
import { cmsService } from '../../services/cms.service';
import { SectionPageHeader } from '../../components/admin/SectionPageHeader';

/**
 * Settings › CMS: the CMS pages (legal pages, error pages). The single-page
 * landing editor that used to sit here moved into the website builder
 * (issue 2618). While the website is on, its Pages panel edits all of them
 * (the same data, the same editor) and this tab links each one there.
 */
export const CMSPage: React.FC = () => {
  const { t } = useTranslation();
  const websiteBuilderOn = useFeatureEnabled('websiteBuilder');
  const confirm = useConfirm();
  const [selected, setSelected] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const { data: pages, isLoading } = useQuery({
    queryKey: ['cms-pages'],
    queryFn: cmsService.getPages,
  });
  const listed = pages || [];
  const selectedPage = selected && listed.some((p) => p.slug === selected) ? selected : listed[0]?.slug || null;
  const pageTitle = (page: { slug: string; title_en: string }) => t(`legal.${page.slug}`, { defaultValue: page.title_en || page.slug });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('cms.loadingPages')} />
      </div>
    );
  }

  return (
    <div>
      <SectionPageHeader
        icon={FileText}
        title={t('cms.title')}
        description={t('cms.subtitle')}
      />

      {websiteBuilderOn && (
        <Card padding="md">
          <Notice tone="info" size="sm">
            {t('cms.managedInWebsite', 'These pages are managed under Website › Pages while the website is on, and shown in its design.')}
          </Notice>
          <ul className="mt-4 space-y-2">
            {listed.map((page) => (
              <li key={page.slug}>
                <Link to={`/admin/website?panel=pages&cms=${page.slug}`}
                  className="flex items-center gap-3 rounded-lg border border-line px-4 py-3 hover:bg-hover">
                  <FileText className="w-5 h-5 flex-shrink-0 text-soft" aria-hidden="true" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-heading truncate">{pageTitle(page)}</span>
                    <span className="block text-sm text-muted">/{page.slug}</span>
                  </span>
                  <span className="text-sm font-medium text-accent">{t('cms.editInWebsite', 'Edit in Website')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!websiteBuilderOn && selectedPage && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Page Selection */}
          <div className="lg:col-span-1">
            <Card padding="md">
              <h2 className="text-lg font-semibold text-heading mb-4">{t('cms.pages')}</h2>
              <div className="space-y-2">
                {listed.map((page) => (
                  <button
                    key={page.slug}
                    onClick={async () => {
                      if (page.slug === selectedPage) return;
                      // Switching pages drops the edits to this one: ask first.
                      if (hasUnsavedChanges && !(await confirm({
                        message: t('cms.discardOnSwitch', 'Discard your unsaved changes to this page?'),
                        variant: 'danger',
                        confirmLabel: t('cms.discardAndSwitch', 'Discard and switch'),
                      }))) return;
                      setSelected(page.slug);
                    }}
                    className={`w-full text-left px-4 py-3 rounded-lg transition-colors flex items-center gap-3 border ${
                      selectedPage === page.slug
                        ? 'tile-selected'
                        : 'bg-panel border-line hover:bg-hover text-heading'
                    }`}
                  >
                    <FileText className="w-5 h-5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      {/* Fall back to the page's own English title for slugs
                          that don't have a fixed translation key (e.g. the new
                          not-found / gallery-not-found error pages). */}
                      <p className="font-medium truncate">
                        {pageTitle(page)}
                      </p>
                      <p className="text-sm text-muted">/{page.slug}</p>
                    </div>
                    {selectedPage === page.slug && hasUnsavedChanges && (
                      <div className="w-2 h-2 bg-warning rounded-full flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            </Card>

            <Card padding="md" className="mt-4">
              <h3 className="text-sm font-semibold text-heading mb-3">{t('cms.previewLinks')}</h3>
              <div className="space-y-2 text-sm">
                <a
                  href={`${window.location.origin}/${selectedPage}?lang=en`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-accent hover:opacity-80"
                >
                  <Globe className="w-4 h-4" />
                  {t('cms.englishVersion')}
                </a>
                <a
                  href={`${window.location.origin}/${selectedPage}?lang=de`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-accent hover:opacity-80"
                >
                  <Globe className="w-4 h-4" />
                  {t('cms.germanVersion')}
                </a>
              </div>
            </Card>
          </div>

          {/* Editor */}
          <div className="lg:col-span-3">
            <Card padding="md">
              <CmsPageEditor key={selectedPage} slug={selectedPage} onDirtyChange={setHasUnsavedChanges} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
};
