/**
 * Website builder (issue 2618): pages built from blocks, previewed with the
 * server's own markup, edited as a draft and published in one step.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  ExternalLink, FileText, Globe, Layers, Monitor, Palette, PanelLeftClose, PanelLeftOpen, Redo2, Smartphone, Undo2,
} from 'lucide-react';
import { Badge, Button, Notice, Tabs } from '../../components/common';
import { ErrorState } from '../../components/common/EmptyState';
import { Loading } from '../../components/common/Loading';
import { useConfirm } from '../../components/common/ConfirmDialog';
import { SectionPageHeader } from '../../components/admin/SectionPageHeader';
import { SettingsSaveBar } from '../../components/admin/SettingsSaveBar';
import { useFillViewport } from '../../components/admin/fillViewport';
import { usePermission } from '../../hooks/usePermission';
import { mediaKey, websiteService } from '../../services/website.service';
import { apiErrorCode, apiErrorDetails, apiErrorText } from '../../utils/apiErrorText';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { collectImageRefs } from './blocks';
import { AddBlockModal } from './AddBlockModal';
import { BlocksPanel } from './BlocksPanel';
import { EditorNotices } from './EditorNotices';
import { useContactSettingsDraft } from './contactSettingsDraft';
import { MediaUrlsContext } from './fields';
import { PagesPanel, slugProblem } from './PagesPanel';
import { PreviewFrame, mediaOriginDiffers, publicSiteUrl, type PreviewDevice } from './PreviewFrame';
import { SitePanel } from './SitePanel';
import { EDITOR_QUERY_KEY, useWebsiteEditor } from './useWebsiteEditor';
import type { ValidationProblem, WebsiteDocument, WebsitePage } from './types';

type Panel = 'blocks' | 'pages' | 'site';

// Numbers the documents sent for preview, across mounts, so a query key never
// names an older document's preview.
let previewRun = 0;

// The editor's image URLs (in the preview and the thumbnails) work for one
// to two hours (backend media.js editorBase): both are fetched again well
// before, on a timer and when the tab comes back after that long.
const EDITOR_URL_REFRESH_MS = 45 * 60 * 1000;

/**
 * The server-rendered preview of `doc`, as a query (`website-preview`), so a
 * change that is not in the document (a gallery taken off the website) can
 * invalidate it.
 */
function usePreview(doc: WebsiteDocument | null, pageId: string) {
  const [sent, setSent] = useState<{ run: number; doc: WebsiteDocument; pageId: string } | null>(null);
  useEffect(() => {
    if (!doc || !pageId) return undefined;
    // Typing re-renders on a pause, not on every key.
    const timer = window.setTimeout(() => { previewRun += 1; setSent({ run: previewRun, doc, pageId }); }, 350);
    return () => window.clearTimeout(timer);
  }, [doc, pageId]);
  const preview = useQuery({
    queryKey: ['website-preview', sent?.run],
    queryFn: () => websiteService.preview(sent!.doc, sent!.pageId, { videoAsPoster: mediaOriginDiffers() }),
    enabled: !!sent,
    staleTime: EDITOR_URL_REFRESH_MS,
    refetchInterval: EDITOR_URL_REFRESH_MS,
    refetchOnWindowFocus: true,
    gcTime: 0,
    retry: false,
  });
  // The last good preview stays while the next renders, or if it fails.
  const lastGood = useRef<string | null>(null);
  if (preview.data !== undefined) lastGood.current = preview.data;
  const waiting = !!doc && !!pageId && (sent?.doc !== doc || sent?.pageId !== pageId);
  return {
    html: lastGood.current,
    loading: waiting || preview.isFetching,
    // The shown preview is an older one: the latest render failed.
    stale: preview.isError && !preview.isFetching,
    retry: () => { void preview.refetch(); },
  };
}

export const WebsiteBuilderPage: React.FC = () => {
  const { t } = useTranslation();
  useFillViewport();
  const confirm = useConfirm();
  const canEdit = usePermission('cms.edit');
  // Showing the website at the site root is a site-wide switch (server: settings.edit too).
  const canSwitchSite = usePermission('settings.edit') && canEdit;
  const { formatDateTime } = useLocalizedDate();
  const editor = useWebsiteEditor();
  const queryClient = useQueryClient();
  // Shown at the site root or not: an action like Publish, taken at once.
  const visibility = useMutation({
    mutationFn: (enabled: boolean) => websiteService.setVisibility(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EDITOR_QUERY_KEY }),
    onError: (err) => toast.error(apiErrorText(err)),
  });
  const { draft, server } = editor;
  // The contact form settings' draft: here, not in the Design panel, so a
  // panel switch never drops it; saved through the same bar.
  const contactSettings = useContactSettingsDraft();
  // ?panel=pages opens on the Pages panel (Settings › CMS links its legal pages there).
  const [searchParams] = useSearchParams();
  const [panel, setPanel] = useState<Panel>(searchParams.get('panel') === 'pages' ? 'pages' : 'blocks');
  // The editing panel can be put away: on a laptop the preview beside it is
  // too narrow to read, and without it the preview has the whole width.
  const [panelOpen, setPanelOpen] = useState(true);
  const [pageId, setPageId] = useState('');
  const [blockId, setBlockId] = useState<string | null>(null);
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [adding, setAdding] = useState(false);
  const [problems, setProblems] = useState<ValidationProblem[]>([]);

  const page: WebsitePage | undefined = draft?.pages.find((p) => p.id === pageId) || draft?.pages.find((p) => p.isHome) || draft?.pages[0];
  useEffect(() => { if (page && page.id !== pageId) setPageId(page.id); }, [page, pageId]);
  const block = page?.blocks.find((b) => b.id === blockId) || null;

  const preview = usePreview(draft, page?.id || '');

  const refs = useMemo(() => (draft ? collectImageRefs(draft) : []), [draft]);
  const refsKey = useMemo(() => [...new Set(refs.map(mediaKey))].sort().join(','), [refs]);
  const media = useQuery({
    queryKey: ['website-media', refsKey],
    queryFn: () => websiteService.resolveMedia(refs),
    enabled: refs.length > 0,
    staleTime: EDITOR_URL_REFRESH_MS,
    refetchInterval: EDITOR_URL_REFRESH_MS,
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous,
  });

  // Ctrl/Cmd+Z outside text editing steps through the draft's history. A
  // field, a select or the rich text editor (contenteditable) has its own
  // undo, and a key a handler already used is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      e.preventDefault();
      if (e.shiftKey) editor.redo(); else editor.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);

  if (editor.query.isLoading || (!draft && !editor.query.isError)) return <Loading />;
  // The full error only before anything loaded: once the editor holds a
  // draft, a failed refresh must not unmount it (and the save bar's guard).
  if (!draft || !server || !page) {
    return <ErrorState onRetry={() => editor.query.refetch()} message={apiErrorText(editor.query.error)} />;
  }

  // Every page's address, the home page's too: the server checks them all.
  const localProblem = draft.pages.some((p) => slugProblem(draft, p));
  // One write at a time: a save and a publish both act on the draft's revision.
  const busy = editor.save.isPending || editor.publish.isPending;

  const onSaveError = (err: unknown) => {
    const code = apiErrorCode(err);
    const refused = apiErrorDetails(err);
    if (code === 'WEBSITE_GALLERY_NOT_ON_WEBSITE') {
      const names = (Array.isArray(refused) ? refused as Array<{ name?: string }> : [])
        .map((d) => d.name).filter(Boolean).join(', ');
      toast.error(t('website.galleryOff', '{{names}} is not on the website. Remove the pick, or switch the gallery on in its settings or in the image picker.', { names }));
      return;
    }
    const details = refused as ValidationProblem[] | undefined;
    if (code === 'WEBSITE_ONE_CONTACT_FORM' && Array.isArray(details) && details[0]?.pageId) {
      // Straight to the second form, where the notice says what to do.
      setPageId(details[0].pageId);
      setPanel('blocks');
      setBlockId(details[0].blockId || null);
      toast.error(apiErrorText(err));
      return;
    }
    if (Array.isArray(details)) {
      setProblems(details);
      setPanel('pages');
      const firstPage = details.find((d) => d.pageId)?.pageId;
      if (firstPage) setPageId(firstPage);
    }
    toast.error(apiErrorText(err));
  };

  // The bar saves what is unsaved: the website's draft, the contact form
  // settings (in effect at once), or both, each on its own request.
  const save = () => {
    if (busy) return;
    if (contactSettings.dirty) {
      contactSettings.save()
        .then(() => toast.success(t('website.contact.saved', 'Contact form settings saved')))
        .catch((err) => toast.error(apiErrorText(err)));
    }
    if (!editor.isDirty) return;
    editor.save.mutate(undefined, {
      onSuccess: () => { setProblems([]); toast.success(t('website.saved', 'Draft saved')); },
      onError: onSaveError,
    });
  };
  const saveLabel = !contactSettings.dirty
    ? t('website.saveDraft', 'Save draft')
    : (editor.isDirty ? t('website.saveAll', 'Save draft and contact settings') : t('website.contact.save', 'Save contact form settings'));

  const publish = async () => {
    if (busy) return;
    const ok = await confirm({
      title: t('website.publishTitle', 'Publish the website?'),
      message: server.publicSiteEnabled
        ? t('website.publishMessage', 'Visitors see this version right away. The draft is saved first.')
        : t('website.publishMessageOff', 'The website is not shown at the site root yet, so visitors will not see it until you show it there. The draft is saved first.'),
      confirmLabel: t('website.publish', 'Publish'),
    });
    if (!ok) return;
    editor.publish.mutate(undefined, {
      onSuccess: () => { setProblems([]); toast.success(t('website.published', 'Website published')); },
      onError: onSaveError,
    });
  };

  // What visitors see at the site root: the published website, or, until
  // the first publish, the landing page that was imported.
  const takeOffline = async () => {
    const ok = await confirm(server.published ? {
      title: t('website.takeOfflineTitle', 'Take the website offline?'),
      message: t('website.takeOfflineMessage', 'Visitors no longer see it at the site root; `/` leads to the gallery code page instead. The website and its draft stay as they are.'),
      confirmLabel: t('website.takeOfflineConfirm', 'Take the website offline'),
      variant: 'danger',
    } : {
      title: t('website.landingOfflineTitle', 'Take the landing page offline?'),
      message: t('website.landingOfflineMessage', 'Visitors no longer see it at the site root; `/` leads to the gallery code page instead. The draft here stays as it is.'),
      confirmLabel: t('website.landingOffline', 'Take the landing page offline'),
      variant: 'danger',
    });
    if (ok) visibility.mutate(false);
  };
  // One message in the save bar: the contact form settings apply as soon as
  // they are saved, which the draft does not.
  const unsavedHint = !contactSettings.dirty
    ? undefined
    : (editor.isDirty
      ? t('website.unsavedBoth', 'The draft and the contact form settings have unsaved changes. Contact form settings apply as soon as they are saved.')
      : t('website.contact.unsavedBar', 'Contact form settings are not saved yet. They apply as soon as they are saved.'));

  // When the version visitors see went out, as the status badge's tooltip.
  const publishedOn = server.published?.publishedAt
    ? t('website.status.publishedOn', 'Published on {{date}}', { date: formatDateTime(server.published.publishedAt) }) as string
    : undefined;
  const status = !server.published
    ? <Badge tone="neutral">{t('website.status.notPublished', 'Not published yet')}</Badge>
    : server.hasUnpublishedChanges || editor.isDirty
      ? <Badge tone="warning" dot title={publishedOn}>{t('website.status.changes', 'Unpublished changes')}</Badge>
      : <Badge tone="success" dot title={publishedOn}>{t('website.status.live', 'Published')}</Badge>;

  return (
    <MediaUrlsContext.Provider value={media.data || {}}>
      <div className="space-y-4 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
        <SectionPageHeader
          icon={Globe}
          title={t('website.title', 'Website')}
          description={t('website.description', 'Your public website, built from blocks. Edit the draft, then publish.')}
          feature="websiteBuilder"
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              {status}
              {canSwitchSite && server.publicSiteEnabled && server.published && (
                <Button size="sm" variant="ghost" isLoading={visibility.isPending} onClick={() => { void takeOffline(); }}>
                  {t('website.takeOffline', 'Take offline')}
                </Button>
              )}
              {server.published && (
                <a href={publicSiteUrl(server.publicUrl)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm inline-flex items-center gap-1.5">
                  <ExternalLink className="w-4 h-4" aria-hidden="true" />{t('website.openSite', 'Open site')}
                </a>
              )}
              {canEdit && (
                <Button variant="primary" onClick={publish} isLoading={editor.publish.isPending}
                  disabled={busy || localProblem || (!editor.isDirty && !server.hasUnpublishedChanges && !!server.published)}>
                  {t('website.publish', 'Publish')}
                </Button>
              )}
            </div>
          )}
        />
        <EditorNotices editor={editor} server={server} canEdit={canEdit} canSwitchSite={canSwitchSite} visibility={visibility}
          takeOffline={takeOffline} setProblems={setProblems} />

        <div className={`grid grid-cols-1 gap-6 lg:flex-1 lg:min-h-0 ${panelOpen ? 'lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]' : ''}`}>
          {/* The frame stays put; only its content scrolls, inside the border.
              Put away, it is hidden, not unmounted: what is open in it stays. */}
          <aside hidden={!panelOpen} className={`min-w-0 lg:min-h-0 flex-col rounded-xl border border-line bg-panel overflow-hidden ${panelOpen ? 'flex' : 'hidden'}`}>
            <div className="px-4 pt-4">
              <Tabs<Panel>
                value={panel}
                onChange={setPanel}
                items={[
                  { id: 'pages', label: t('website.tabs.pages', 'Pages'), icon: <FileText className="w-4 h-4" />, dirty: problems.length > 0 || localProblem },
                  { id: 'blocks', label: t('website.tabs.blocks', 'Blocks'), icon: <Layers className="w-4 h-4" /> },
                  { id: 'site', label: t('website.tabs.site', 'Design'), icon: <Palette className="w-4 h-4" />, dirty: contactSettings.dirty },
                ]}
              />
            </div>
            <div className="panel-scroll lg:flex-1 lg:min-h-0 lg:overflow-y-auto px-4 pt-4 pb-8 space-y-4">
              {panel === 'blocks' && (
                <BlocksPanel editor={editor} draft={draft} page={page} block={block} canEdit={canEdit} brandColors={server.brandColors}
                  setBlockId={setBlockId} setAdding={setAdding} />
              )}
              {panel === 'pages' && (
                <PagesPanel doc={draft} pageId={page.id} onSelectPage={(id) => { setPageId(id); setBlockId(null); }}
                  update={editor.update} serverProblems={problems} readOnly={!canEdit} />
              )}
              {panel === 'site' && <SitePanel doc={draft} contactSettings={contactSettings} update={editor.update} readOnly={!canEdit} />}
            </div>
          </aside>

          <section className="min-w-0 flex flex-col gap-3 lg:min-h-0">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="icon-sm" variant="ghost" aria-expanded={panelOpen} onClick={() => setPanelOpen((open) => !open)}
                aria-label={(panelOpen ? t('website.panel.hide', 'Hide the editing panel') : t('website.panel.show', 'Show the editing panel')) as string}
                title={(panelOpen ? t('website.panel.hide', 'Hide the editing panel') : t('website.panel.show', 'Show the editing panel')) as string}>
                {panelOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
              </Button>
              <label className="sr-only" htmlFor="website-page-select">{t('website.previewPage', 'Page in the preview')}</label>
              <select id="website-page-select" className="input w-auto min-w-0 max-w-[16rem]" value={page.id}
                onChange={(e) => { setPageId(e.target.value); setBlockId(null); }}>
                {draft.pages.map((p) => <option key={p.id} value={p.id}>{p.isHome ? `${p.title} (/)` : `${p.title} (/${p.slug})`}</option>)}
              </select>
              <div className="flex items-center gap-1">
                <Button size="icon-sm" variant="ghost" onClick={editor.undo} disabled={!editor.canUndo || !canEdit} aria-label={t('website.undo', 'Undo') as string}>
                  <Undo2 className="w-4 h-4" />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={editor.redo} disabled={!editor.canRedo || !canEdit} aria-label={t('website.redo', 'Redo') as string}>
                  <Redo2 className="w-4 h-4" />
                </Button>
              </div>
              <div className="ml-auto inline-flex rounded-lg border border-line p-0.5" role="group" aria-label={t('website.device', 'Preview size') as string}>
                {([['desktop', Monitor, t('website.desktop', 'Computer')], ['phone', Smartphone, t('website.phone', 'Phone')]] as const).map(([id, Icon, label]) => (
                  <button key={id} type="button" aria-pressed={device === id} onClick={() => setDevice(id)}
                    className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm ${device === id ? 'tile-selected' : 'text-body hover:bg-hover'}`}>
                    <Icon className="w-4 h-4" aria-hidden="true" />{label}
                  </button>
                ))}
              </div>
            </div>
            {preview.stale && (
              <Notice
                tone="warning"
                size="sm"
                action={<Button size="sm" variant="secondary" onClick={preview.retry}>{t('website.previewRetry', 'Refresh preview')}</Button>}
              >
                {t('website.previewStale', 'Preview out of date: it could not be refreshed.')}
              </Notice>
            )}
            <PreviewFrame html={preview.html} loading={preview.loading} device={device} selectedBlockId={block?.id || null}
              onSelectBlock={(id) => { setPanel('blocks'); setBlockId(id); setPanelOpen(true); }} />
          </section>
        </div>

        <AddBlockModal editor={editor} page={page} block={block} adding={adding} setAdding={setAdding} setBlockId={setBlockId} />

        {canEdit && (
          <SettingsSaveBar
            // The website's draft or the contact form settings: either one
            // arms the leave guard and the bar.
            isDirty={editor.isDirty || contactSettings.dirty}
            // Publish saves first: neither a second save nor a discard may
            // run against the revision it is writing.
            isSaving={busy || contactSettings.isSaving}
            onSave={save}
            onDiscard={() => { editor.discard(); contactSettings.discard(); setProblems([]); }}
            canSave={!localProblem}
            saveLabel={saveLabel}
            unsavedHint={unsavedHint}
          />
        )}
      </div>
    </MediaUrlsContext.Provider>
  );
};
