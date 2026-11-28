/**
 * The editor of one CMS page (legal pages, error pages): title and content
 * per language, an external URL override, the footer switch and a page logo.
 * Used by Settings › CMS and, for the legal pages, by the website builder's
 * Pages panel (issue 2618): the same data through the same editor.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Image as ImageIcon, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Notice } from '../../common';
import { CMSEditor } from '../CMSEditor';
import { SettingsSaveBar } from '../SettingsSaveBar';
import { cmsService, LEGAL_PAGE_SLUGS, type CMSPage } from '../../../services/cms.service';
import { useCmsPageTitle } from './cmsPageTitle';
import { buildResourceUrl } from '../../../utils/url';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../../hooks';
import { useUnsavedChanges } from '../../../contexts/UnsavedChangesContext';

interface CmsPageEditorProps {
  slug: string;
  /** 'bar': the page's save bar (Settings › CMS); 'inline': Save and Discard here (a dialog). */
  saveMode?: 'bar' | 'inline';
  onDirtyChange?: (dirty: boolean) => void;
  /** After a save, in inline mode (a dialog closes). */
  onSaved?: () => void;
}

export const CmsPageEditor: React.FC<CmsPageEditorProps> = ({ slug, saveMode = 'bar', onDirtyChange, onSaved }) => {
  const { t } = useTranslation();
  const pageTitle = useCmsPageTitle();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [editingLang, setEditingLang] = useState<'en' | 'de'>('en');
  const [editForm, setEditForm] = useState<Partial<CMSPage>>({});
  const [hasUnsavedChanges, setHasUnsavedChangesState] = useState(false);
  const setHasUnsavedChanges = (dirty: boolean) => {
    setHasUnsavedChangesState(dirty);
    onDirtyChange?.(dirty);
  };

  const { data: pages } = useQuery({ queryKey: ['cms-pages'], queryFn: cmsService.getPages });
  const currentPage = pages?.find((p) => p.slug === slug);

  const updateMutation = useMutation({
    mutationFn: ({ data }: { data: Partial<CMSPage> }) => cmsService.updatePage(slug, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cms-pages'] });
      setHasUnsavedChanges(false);
      toast.success(t('cms.pageUpdated'));
      onSaved?.();
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    },
  });

  // Load the page into the form when the selection changes. A refetch of the
  // same page while it has unsaved edits (the logo upload invalidates the
  // list) takes only the new logo: the typed text stays, and so does the
  // save bar. There is no autosave to bound such a loss any more.
  const hydratedSlug = useRef<string | null>(null);
  const unsavedRef = useRef(false);
  unsavedRef.current = hasUnsavedChanges;
  useEffect(() => {
    if (!currentPage) return;
    if (hydratedSlug.current === slug && unsavedRef.current) {
      setEditForm((prev) => ({ ...prev, logo_url: currentPage.logo_url }));
      return;
    }
    hydratedSlug.current = slug;
    setEditForm(currentPage);
    setHasUnsavedChanges(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setHasUnsavedChanges only reports to the parent
  }, [currentPage, slug]);

  const handleSave = () => updateMutation.mutate({ data: editForm });
  const discard = () => {
    if (currentPage) setEditForm(currentPage);
    setHasUnsavedChanges(false);
  };
  // The leave guard (reload, tab close, browser Back): SettingsSaveBar
  // registers the edits in bar mode; the inline editor (the website
  // builder's dialog) has no save bar, so it registers them itself.
  useUnsavedChanges(saveMode === 'inline' && hasUnsavedChanges, discard);
  const change = (patch: Partial<CMSPage>) => {
    setEditForm((prev) => ({ ...prev, ...patch }));
    setHasUnsavedChanges(true);
  };

  // Inline URL validation. Empty input while typing is not an error
  // (avoid flagging mid-edit). Backend re-validates on save regardless.
  const externalUrlError = useMemo(() => {
    if (!editForm.use_external_url) return null;
    const v = (editForm.external_url || '').trim();
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:') return t('cms.externalUrlInvalid');
      return null;
    } catch {
      return t('cms.externalUrlInvalid');
    }
  }, [editForm.use_external_url, editForm.external_url, t]);

  // Per-page logo upload (#324). Only meaningful for the customisable
  // error pages right now, but harmless if exposed for any slug.
  const logoInputRef = useRef<HTMLInputElement>(null);
  const uploadLogoMutation = useMutation({
    mutationFn: async (file: File) => cmsService.uploadPageLogo(slug, file),
    onSuccess: ({ logo_url }) => {
      setEditForm((prev) => ({ ...prev, logo_url }));
      queryClient.invalidateQueries({ queryKey: ['cms-pages'] });
      toast.success(t('cms.logoUploaded', 'Logo uploaded'));
    },
    onError: () => toast.error(t('toast.uploadError')),
  });
  const clearLogoMutation = useMutationWithToast({
    mutationFn: async () => cmsService.clearPageLogo(slug),
    successMessage: t('cms.logoCleared', 'Logo cleared'),
    errorMessage: () => t('toast.saveError'),
    invalidateKeys: [['cms-pages']],
    onSuccess: () => {
      setEditForm((prev) => ({ ...prev, logo_url: null }));
    },
  });

  const langTab = (lang: 'en' | 'de', label: string) => (
    <button
      type="button"
      onClick={() => setEditingLang(lang)}
      className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
        editingLang === lang
          ? 'bg-accent-dark/15 text-accent-dark'
          : 'bg-inset text-body hover:bg-neutral-200 dark:hover:bg-neutral-600'
      }`}
    >
      {label}
    </button>
  );

  // In the website builder's dialog: the dialog names the page, and only the
  // options that apply to the page are offered. A legal page has an external
  // address and a place in the gallery footer; the website shows its
  // not-found page under its own header, so that page has no logo either.
  const inDialog = saveMode === 'inline';
  const legalPage = LEGAL_PAGE_SLUGS.includes(slug);
  const showLegalOptions = !inDialog || legalPage;
  const showLogo = !inDialog || slug !== 'not-found';

  return (
    <div>
      <div className={`flex items-center mb-6 gap-4 ${inDialog ? 'justify-end' : 'justify-between'}`}>
        {!inDialog && (
          <h2 className="text-lg font-semibold text-heading">
            {t('cms.editPage', { page: pageTitle(slug, currentPage) })}
          </h2>
        )}
        <div className="flex gap-2">
          {langTab('en', 'English')}
          {langTab('de', 'Deutsch')}
        </div>
      </div>

      <div className="space-y-4">
        {/* External URL override */}
        {showLegalOptions && (
        <div className="rounded-lg border border-line p-4 bg-neutral-50 dark:bg-neutral-800/40">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-line-strong text-accent focus:ring-accent"
              checked={!!editForm.use_external_url}
              onChange={(e) => change({ use_external_url: e.target.checked })}
            />
            <span className="flex-1">
              <span className="block text-sm font-medium text-heading">{t('cms.useExternalUrl')}</span>
              <span className="block text-xs text-muted mt-1">{t('cms.useExternalUrlHelp')}</span>
            </span>
          </label>
          {!!editForm.use_external_url && (
            <div className="mt-3">
              <Input
                type="url"
                label={t('cms.externalUrl')}
                value={editForm.external_url || ''}
                onChange={(e) => change({ external_url: e.target.value })}
                placeholder={t('cms.externalUrlPlaceholder')}
                error={externalUrlError || undefined}
              />
              <p className="text-xs text-muted mt-2">{t('cms.externalUrlActive')}</p>
            </div>
          )}
        </div>
        )}

        {/* Footer visibility (#441). Lets admins hide a CMS page
            from the gallery footer when their jurisdiction
            doesn't require it. Defaults to true on existing rows. */}
        {showLegalOptions && (
        <div className="rounded-lg border border-line p-4 bg-neutral-50 dark:bg-neutral-800/40">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-line-strong text-accent focus:ring-accent"
              checked={editForm.show_in_footer !== false}
              onChange={(e) => change({ show_in_footer: e.target.checked })}
            />
            <span className="flex-1">
              <span className="block text-sm font-medium text-heading">{t('cms.showInFooter', 'Show in gallery footer')}</span>
              <span className="block text-xs text-muted mt-1">
                {t('cms.showInFooterHelp', 'When off, this page is hidden from the public gallery footer. The page itself remains accessible at its direct URL.')}
              </span>
            </span>
          </label>
        </div>
        )}

        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-body mb-1">
            {t('cms.pageTitle')} ({editingLang === 'en' ? 'English' : 'German'})
          </label>
          <Input
            value={editingLang === 'en' ? editForm.title_en || '' : editForm.title_de || ''}
            onChange={(e) => change(editingLang === 'de' ? { title_de: e.target.value } : { title_en: e.target.value })}
            placeholder={t('cms.pageTitlePlaceholder')}
          />
        </div>

        {/* Content */}
        <div>
          <label className="block text-sm font-medium text-body mb-1">
            {t('cms.pageContent')} ({editingLang === 'en' ? 'English' : 'German'})
          </label>
          <CMSEditor
            content={editingLang === 'en' ? editForm.content_en || '' : editForm.content_de || ''}
            onChange={(content) => change(editingLang === 'de' ? { content_de: content } : { content_en: content })}
            onSave={inDialog ? undefined : handleSave}
            isSaving={updateMutation.isPending}
          />
        </div>

        {/* Per-page logo override (#324) */}
        {showLogo && (
        <div>
          <label className="block text-sm font-medium text-body mb-1">{t('cms.pageLogo', 'Page Logo')}</label>
          <p className="text-xs text-muted mb-3">
            {t('cms.pageLogoHelp', 'Optional. If set, used in place of the global branding logo on this page.')}
          </p>
          <div className="flex items-center gap-4">
            {editForm.logo_url ? (
              <img
                src={buildResourceUrl(editForm.logo_url)}
                alt="Page logo"
                className="h-16 w-auto object-contain bg-inset rounded border border-line px-3 py-1"
              />
            ) : (
              <div className="h-16 w-32 flex items-center justify-center bg-inset rounded border border-dashed border-line-strong text-xs text-muted">
                {t('cms.noLogo', 'no override')}
              </div>
            )}
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadLogoMutation.mutate(file);
                if (logoInputRef.current) logoInputRef.current.value = '';
              }}
            />
            <Button
              variant="outline"
              size="sm"
              leftIcon={<ImageIcon className="w-4 h-4" />}
              onClick={() => logoInputRef.current?.click()}
              isLoading={uploadLogoMutation.isPending}
            >
              {editForm.logo_url ? t('cms.replaceLogo', 'Replace Logo') : t('cms.uploadLogo', 'Upload Logo')}
            </Button>
            {editForm.logo_url && (
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Trash2 className="w-4 h-4" />}
                onClick={() => clearLogoMutation.mutate()}
                isLoading={clearLogoMutation.isPending}
              >
                {t('cms.clearLogo', 'Use site default')}
              </Button>
            )}
          </div>
        </div>
        )}
      </div>

      {currentPage?.updated_at && (
        <p className="text-xs text-muted mt-4">
          {t('cms.lastUpdated')} {fmtDateTime(currentPage.updated_at)}
        </p>
      )}

      {saveMode === 'bar' ? (
        <SettingsSaveBar isDirty={hasUnsavedChanges} isSaving={updateMutation.isPending} onSave={handleSave} onDiscard={discard} />
      ) : (
        <>
        <Notice tone="info" size="sm" className="mt-4">
          {t('cms.savedAtOnce', 'Changes to legal and system pages apply as soon as they are saved. They are not part of the website draft.')}
        </Notice>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={discard} disabled={!hasUnsavedChanges || updateMutation.isPending}>
            {t('common.discard', 'Discard')}
          </Button>
          <Button variant="primary" onClick={handleSave} isLoading={updateMutation.isPending} disabled={!hasUnsavedChanges}>
            {t('common.save', 'Save')}
          </Button>
        </div>
        </>
      )}
    </div>
  );
};
