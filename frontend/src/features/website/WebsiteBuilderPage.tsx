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
  ArrowLeft, Copy, ExternalLink, FileText, Globe, Layers, Monitor, Palette, Plus, Redo2, Smartphone, Trash2, Undo2,
} from 'lucide-react';
import { Badge, Button, Modal, Notice, Tabs } from '../../components/common';
import { ErrorState } from '../../components/common/EmptyState';
import { Loading } from '../../components/common/Loading';
import { useConfirm } from '../../components/common/ConfirmDialog';
import { SectionPageHeader } from '../../components/admin/SectionPageHeader';
import { SettingsSaveBar } from '../../components/admin/SettingsSaveBar';
import { useFillViewport } from '../../components/admin/fillViewport';
import { usePermission } from '../../hooks/usePermission';
import { mediaKey, websiteService } from '../../services/website.service';
import { apiErrorText } from '../../utils/apiErrorText';
import { BLOCK_ICONS, BLOCK_TYPES, blockLabel, collectImageRefs, createBlock, moveItem, newId } from './blocks';
import { BlockEditor } from './BlockEditor';
import { WebsiteDocContext } from './LinkTargetField';
import { MediaUrlsContext } from './fields';
import { PagesPanel, slugProblem } from './PagesPanel';
import { PreviewFrame, mediaOriginDiffers, publicSiteUrl, type PreviewDevice } from './PreviewFrame';
import { SitePanel } from './SitePanel';
import { SortableList } from './SortableList';
import { EDITOR_QUERY_KEY, useWebsiteEditor } from './useWebsiteEditor';
import type { Block, BlockType, ValidationProblem, WebsiteDocument, WebsitePage } from './types';

type Panel = 'blocks' | 'pages' | 'site';

// Mirrors MAX_BLOCKS in backend/src/services/website/document.js.
const MAX_BLOCKS = 60;

function blockSummary(block: Block): string {
  if ('heading' in block && block.heading) return block.heading;
  if (block.type === 'text') return new DOMParser().parseFromString(block.body, 'text/html').body.textContent?.slice(0, 60) || '';
  if (block.type === 'gallery' || block.type === 'instagram') return `${block.images.length} ×`;
  return '';
}

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
  const editor = useWebsiteEditor();
  const queryClient = useQueryClient();
  // Shown at the site root or not: an action like Publish, taken at once.
  const visibility = useMutation({
    mutationFn: (enabled: boolean) => websiteService.setVisibility(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EDITOR_QUERY_KEY }),
    onError: (err) => toast.error(apiErrorText(err)),
  });
  const { draft, server } = editor;
  // ?panel=pages opens on the Pages panel (Settings › CMS links its legal pages there).
  const [searchParams] = useSearchParams();
  const [panel, setPanel] = useState<Panel>(searchParams.get('panel') === 'pages' ? 'pages' : 'blocks');
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

  // Ctrl/Cmd+Z outside a text field steps through the draft's history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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

  const setPageBlocks = (fn: (blocks: Block[]) => Block[], field?: string) => editor.update((d) => ({
    ...d, pages: d.pages.map((p) => (p.id === page.id ? { ...p, blocks: fn(p.blocks) } : p)),
  }), field);

  const addBlock = (type: BlockType) => {
    const created = createBlock(type, t);
    const at = block ? page.blocks.findIndex((b) => b.id === block.id) + 1 : page.blocks.length;
    setPageBlocks((blocks) => [...blocks.slice(0, at), created, ...blocks.slice(at)]);
    setBlockId(created.id);
    setAdding(false);
  };

  const duplicateBlock = (b: Block) => {
    // The server refuses a page over the limit; never build one.
    if (page.blocks.length >= MAX_BLOCKS) return;
    const copy = { ...structuredClone(b), id: newId() };
    setPageBlocks((blocks) => {
      const at = blocks.findIndex((x) => x.id === b.id) + 1;
      return [...blocks.slice(0, at), copy, ...blocks.slice(at)];
    });
    setBlockId(copy.id);
  };

  const deleteBlock = async (b: Block) => {
    const ok = await confirm({
      title: t('website.blocks.deleteTitle', 'Remove this block?'),
      message: t('website.blocks.deleteMessage', 'It is removed from the draft. Undo brings it back.'),
      confirmLabel: t('website.blocks.delete', 'Remove'),
      variant: 'danger',
    });
    if (!ok) return;
    setPageBlocks((blocks) => blocks.filter((x) => x.id !== b.id));
    setBlockId(null);
  };

  // Every page's address, the home page's too: the server checks them all.
  const localProblem = draft.pages.some((p) => slugProblem(draft, p));
  // One write at a time: a save and a publish both act on the draft's revision.
  const busy = editor.save.isPending || editor.publish.isPending;

  const onSaveError = (err: unknown) => {
    const data = (err as { response?: { data?: { code?: string; details?: unknown } } })?.response?.data;
    if (data?.code === 'WEBSITE_GALLERY_NOT_ON_WEBSITE') {
      const names = (Array.isArray(data.details) ? data.details as Array<{ name?: string }> : [])
        .map((d) => d.name).filter(Boolean).join(', ');
      toast.error(t('website.galleryOff', '{{names}} is not on the website. Remove the pick, or switch the gallery on in its settings or in the image picker.', { names }));
      return;
    }
    const details = data?.details as ValidationProblem[] | undefined;
    if (Array.isArray(details)) {
      setProblems(details);
      setPanel('pages');
      const firstPage = details.find((d) => d.pageId)?.pageId;
      if (firstPage) setPageId(firstPage);
    }
    toast.error(apiErrorText(err));
  };

  const save = () => {
    if (busy) return;
    editor.save.mutate(undefined, {
      onSuccess: () => { setProblems([]); toast.success(t('website.saved', 'Draft saved')); },
      onError: onSaveError,
    });
  };

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

  const takeOffline = async () => {
    const ok = await confirm({
      title: t('website.takeOfflineTitle', 'Take the website offline?'),
      message: t('website.takeOfflineMessage', 'Visitors no longer see it at the site root; `/` leads to the gallery code page instead. The website and its draft stay as they are.'),
      confirmLabel: t('website.takeOfflineConfirm', 'Take the website offline'),
      variant: 'danger',
    });
    if (ok) visibility.mutate(false);
  };

  const status = !server.published
    ? <Badge tone="neutral">{t('website.status.notPublished', 'Not published yet')}</Badge>
    : server.hasUnpublishedChanges || editor.isDirty
      ? <Badge tone="warning" dot>{t('website.status.changes', 'Unpublished changes')}</Badge>
      : <Badge tone="success" dot>{t('website.status.live', 'Published')}</Badge>;

  const blocksPanel = block ? (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" leftIcon={<ArrowLeft className="w-4 h-4" />} onClick={() => setBlockId(null)}>
          {t('website.blocks.back', 'All blocks')}
        </Button>
        <span className="flex-1 min-w-0 text-sm font-semibold text-heading truncate">{blockLabel(t, block.type)}</span>
        {canEdit && (
          <>
            <Button size="icon-sm" variant="ghost" onClick={() => duplicateBlock(block)} disabled={page.blocks.length >= MAX_BLOCKS}
              aria-label={t('website.blocks.duplicate', 'Duplicate block') as string}
              title={page.blocks.length >= MAX_BLOCKS ? t('website.blocks.full', 'A page holds at most 60 blocks.') as string : undefined}>
              <Copy className="w-4 h-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => deleteBlock(block)} aria-label={t('website.blocks.delete', 'Remove') as string}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </>
        )}
      </div>
      {/* Sections are anchored as #b-<block id>: a button or text link can point here. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-subtle border border-line px-3 py-2">
        <span className="text-xs text-muted">{t('website.blocks.anchor', 'Link to this block')}</span>
        <code className="text-xs text-body">{`#b-${block.id}`}</code>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={t('website.blocks.copyAnchor', 'Copy the link to this block') as string}
          onClick={() => {
            navigator.clipboard.writeText(`#b-${block.id}`)
              .then(() => toast.success(t('website.blocks.anchorCopied', 'Link copied. Paste it as a button or text link.')))
              .catch(() => toast.error(t('website.blocks.anchorCopyFailed', 'Could not copy the link.')));
          }}>
          <Copy className="w-4 h-4" />
        </Button>
      </div>
      <fieldset disabled={!canEdit}>
        <WebsiteDocContext.Provider value={draft}>
          <BlockEditor
            block={block}
            brandColors={server.brandColors}
            onChange={(next, field) => setPageBlocks((blocks) => blocks.map((b) => (b.id === next.id ? next : b)), field ? `${next.id}.${field}` : undefined)}
          />
        </WebsiteDocContext.Provider>
      </fieldset>
    </div>
  ) : (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-heading">{t('website.blocks.title', 'Blocks on “{{name}}”', { name: page.title })}</h3>
        {canEdit && (
          <Button size="sm" variant="secondary" leftIcon={<Plus className="w-4 h-4" />} onClick={() => setAdding(true)} disabled={page.blocks.length >= MAX_BLOCKS}>
            {t('website.blocks.add', 'Add block')}
          </Button>
        )}
      </div>
      {page.blocks.length === 0 ? (
        <p className="text-sm text-muted py-6 text-center">{t('website.blocks.empty', 'This page has no blocks yet.')}</p>
      ) : (
        <SortableList
          items={page.blocks}
          getId={(b) => b.id}
          getLabel={(b) => blockLabel(t, b.type)}
          readOnly={!canEdit}
          onMove={(from, to) => { if (canEdit) setPageBlocks((blocks) => moveItem(blocks, from, to)); }}
          renderItem={(b) => {
            const Icon = BLOCK_ICONS[b.type];
            return (
              <button type="button" className="w-full flex items-center gap-2.5 px-1 py-1 text-left" onClick={() => setBlockId(b.id)}>
                <span className="inline-flex w-8 h-8 flex-none items-center justify-center rounded-md bg-inset text-soft"><Icon className="w-4 h-4" aria-hidden="true" /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-heading">{blockLabel(t, b.type)}</span>
                  {blockSummary(b) && <span className="block text-xs text-muted truncate">{blockSummary(b)}</span>}
                </span>
              </button>
            );
          }}
        />
      )}
      <p className="text-xs text-muted">{t('website.blocks.hint', 'Click a block here or in the preview to edit it. Drag to change the order.')}</p>
    </div>
  );

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
              {canEdit && server.publicSiteEnabled && (
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
        {!canEdit && <Notice tone="neutral" size="sm">{t('website.readOnly', 'You can see the website but not change it.')}</Notice>}
        {editor.query.isError && (
          <Notice
            tone="warning"
            size="sm"
            action={(
              <Button size="sm" variant="secondary" isLoading={editor.query.isFetching} onClick={() => { void editor.query.refetch(); }}>
                {t('common.retry', 'Try again')}
              </Button>
            )}
          >
            {t('website.refreshFailed', 'Could not refresh the website. Your changes here are kept.')}
          </Notice>
        )}
        {editor.conflict && (
          <Notice
            tone="warning"
            size="sm"
            action={(
              <Button size="sm" variant="secondary" onClick={() => { void editor.reloadLatest().then(() => setProblems([])); }}>
                {t('website.conflictReload', 'Load the latest version')}
              </Button>
            )}
          >
            {t('website.conflict', 'Someone else saved the website since you opened it, so your changes were not saved. Load the latest version to continue from theirs; your unsaved changes here are then dropped.')}
          </Notice>
        )}
        {server.legacyImportRefused && (
          <Notice tone="warning" size="sm">
            {t('website.importRefused', 'Your landing page is too long for a custom HTML block ({{length}} of {{max}} characters), so it was not copied into the builder; nothing of it was cut. It stays live at the site root until you publish here. To keep it, shorten it and paste it into a custom HTML block.', server.legacyImportRefused)}
          </Notice>
        )}
        {server.legacyLandingLive && (
          <Notice tone="info" size="sm">
            {t('website.legacyImported', 'Your previous landing page was imported here. Visitors still see it unchanged at the site root; review it and publish when you are ready, and the website takes its place.')}
          </Notice>
        )}
        {!server.publicSiteEnabled && (
          <Notice tone="warning" size="sm"
            action={canEdit ? (
              <Button size="sm" variant="secondary" isLoading={visibility.isPending} onClick={() => visibility.mutate(true)}>
                {t('website.showAtRoot', 'Show it at the site root')}
              </Button>
            ) : undefined}>
            {t('website.siteOff', 'The website is not shown at the site root yet: `/` leads to the gallery code page instead.')}
          </Notice>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[400px_minmax(0,1fr)] gap-6 lg:flex-1 lg:min-h-0">
          {/* The frame stays put; only its content scrolls, inside the border. */}
          <aside className="min-w-0 lg:min-h-0 flex flex-col rounded-xl border border-line bg-panel overflow-hidden">
            <div className="px-4 pt-4">
              <Tabs<Panel>
                value={panel}
                onChange={setPanel}
                items={[
                  { id: 'pages', label: t('website.tabs.pages', 'Pages'), icon: <FileText className="w-4 h-4" />, dirty: problems.length > 0 || localProblem },
                  { id: 'blocks', label: t('website.tabs.blocks', 'Blocks'), icon: <Layers className="w-4 h-4" /> },
                  { id: 'site', label: t('website.tabs.site', 'Design'), icon: <Palette className="w-4 h-4" /> },
                ]}
              />
            </div>
            <div className="panel-scroll lg:flex-1 lg:min-h-0 lg:overflow-y-auto px-4 pt-4 pb-8 space-y-4">
              {panel === 'blocks' && blocksPanel}
              {panel === 'pages' && (
                <PagesPanel doc={draft} pageId={page.id} onSelectPage={(id) => { setPageId(id); setBlockId(null); }}
                  update={editor.update} serverProblems={problems} readOnly={!canEdit} />
              )}
              {panel === 'site' && <SitePanel doc={draft} update={editor.update} readOnly={!canEdit} />}
            </div>
          </aside>

          <section className="min-w-0 flex flex-col gap-3 lg:min-h-0">
            <div className="flex flex-wrap items-center gap-2">
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
              onSelectBlock={(id) => { setPanel('blocks'); setBlockId(id); }} />
          </section>
        </div>

        <Modal open={adding} onClose={() => setAdding(false)} size="xl" title={t('website.blocks.addTitle', 'Add a block')}
          description={t('website.blocks.addDescription', 'It is added below the selected block, or at the end of the page.')}>
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {BLOCK_TYPES.map((type) => {
              const Icon = BLOCK_ICONS[type];
              return (
                <li key={type}>
                  <button type="button" onClick={() => addBlock(type)}
                    className="w-full h-full text-left rounded-xl border border-line p-3 hover:border-accent hover:bg-hover-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <Icon className="w-5 h-5 text-soft mb-2" aria-hidden="true" />
                    <span className="block text-sm font-medium text-heading">{blockLabel(t, type)}</span>
                    <span className="block text-xs text-muted mt-0.5">{t(`website.blocks.${type}.description`)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Modal>

        {canEdit && (
          <SettingsSaveBar
            isDirty={editor.isDirty}
            // Publish saves first: neither a second save nor a discard may
            // run against the revision it is writing.
            isSaving={busy}
            onSave={save}
            onDiscard={() => { editor.discard(); setProblems([]); }}
            canSave={!localProblem}
            saveLabel={t('website.saveDraft', 'Save draft')}
          />
        )}
      </div>
    </MediaUrlsContext.Provider>
  );
};
