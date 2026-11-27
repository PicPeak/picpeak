/**
 * The photo editor (issue 2619): quick, non-destructive corrections in the
 * admin. Loaded on demand (AdminPhotoViewer imports it lazily), so neither
 * the admin nor the gallery bundle carries it.
 *
 * The preview runs on the GPU over the unedited photo at 1920 px
 * (renderer.ts); a slider move draws one frame and sends nothing. Saving
 * stores the parameters; the server renders the full-size photo and its
 * previews in the background, which the footer follows.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  ChevronLeft, ChevronRight, Copy, ClipboardPaste, Crop, FlipHorizontal2, FlipVertical2, Keyboard, Layers,
  RotateCcw, RotateCw, Save, SplitSquareHorizontal, Trash2, Wand2, X,
} from 'lucide-react';
import { Badge, Button, Switch, useConfirm } from '../../components/common';
import { pushDialogLayer } from '../../components/common/Modal';
import type { AdminPhoto } from '../../services/photos.service';
import { photoEditorService, type PhotoEditPreset } from '../../services/photoEditor.service';
import { isTypingTarget } from '../../utils/feedbackKeybinds';
import {
  type CropRect, type EditParams, type SliderKey, DEFAULT_PARAMS, SLIDERS, STRAIGHTEN_MAX, frameSize, isIdentity,
} from './editMath';
import { editorReducer, resolveEditorKey, SHORTCUTS, type EditorCommand } from './editorState';
import { EditRenderer, type ViewMode, type ViewSize } from './renderer';
import { CropOverlay } from './CropOverlay';
import { BatchCopyDialog } from './BatchCopyDialog';

export interface PhotoEditorProps {
  eventId: number;
  photos: AdminPhoto[];
  initialPhotoId: number;
  onClose: () => void;
  /** An edit was saved: the photo rows (thumbnails, sizes) are stale. */
  onChanged: () => void;
}

const CLIPBOARD_KEY = 'picpeak.photoEditor.clipboard';
const ASPECTS: Array<{ id: string; ratio: number | null | 'original' }> = [
  { id: 'free', ratio: null }, { id: 'original', ratio: 'original' }, { id: '1:1', ratio: 1 }, { id: '4:5', ratio: 4 / 5 },
  { id: '5:4', ratio: 5 / 4 }, { id: '3:2', ratio: 3 / 2 }, { id: '2:3', ratio: 2 / 3 }, { id: '16:9', ratio: 16 / 9 },
];
const LIGHT: SliderKey[] = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];
const COLOUR: SliderKey[] = ['temperature', 'tint', 'vibrance', 'saturation'];
const DETAIL: SliderKey[] = ['clarity', 'sharpen'];

const isVideo = (photo: AdminPhoto) => photo.media_type === 'video' || String(photo.mime_type || '').startsWith('video/');

function readClipboard(): EditParams | null {
  try {
    const raw = sessionStorage.getItem(CLIPBOARD_KEY);
    return raw ? { ...DEFAULT_PARAMS, ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

/** One slider row: label, value, range. A double click puts it back to 0. */
const SliderRow: React.FC<{
  id: string; label: string; value: number; min: number; max: number; step: number; format?: (v: number) => string;
  onChange: (v: number) => void;
}> = ({ id, label, value, min, max, step, format, onChange }) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between gap-2 text-xs">
      <label htmlFor={id} className="text-body">{label}</label>
      <output htmlFor={id} className="tabular-nums text-muted">{format ? format(value) : value > 0 ? `+${value}` : value}</output>
    </div>
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={() => onChange(0)}
      className="w-full accent-[var(--ui-accent-strong)]"
    />
  </div>
);

const Section: React.FC<{ title: string; action?: React.ReactNode; children: React.ReactNode }> = ({ title, action, children }) => (
  <section className="space-y-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {action}
    </div>
    {children}
  </section>
);

const PhotoEditor: React.FC<PhotoEditorProps> = ({ eventId, photos, initialPhotoId, onClose, onChanged }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const editable = useMemo(() => photos.filter((p) => !isVideo(p)), [photos]);
  const [index, setIndex] = useState(() => Math.max(0, editable.findIndex((p) => p.id === initialPhotoId)));
  const photo = editable[index];

  const [params, dispatch] = useReducer(editorReducer, DEFAULT_PARAMS);
  const [saved, setSaved] = useState<EditParams>(DEFAULT_PARAMS);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cropMode, setCropMode] = useState(false);
  const [before, setBefore] = useState(false);
  const [aspect, setAspect] = useState('free');
  const [saving, setSaving] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [clipboard, setClipboard] = useState<EditParams | null>(readClipboard);
  const [presets, setPresets] = useState<PhotoEditPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [pending, setPending] = useState<number[]>([]);
  const [backend, setBackend] = useState<string>('');
  const [raw, setRaw] = useState(false);
  const [autoDevelop, setAutoDevelop] = useState<boolean | null>(null);
  const [developing, setDeveloping] = useState(false);
  const [view, setView] = useState<ViewSize | null>(null);
  const [display, setDisplay] = useState({ width: 0, height: 0 });

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EditRenderer | null>(null);
  const frameRef = useRef(0);
  const latest = useRef({ params, mode: 'edit' as ViewMode });
  const dirty = !sameParams(params, saved);

  // ---- loading a photo: its edit and the unedited base image.
  useEffect(() => {
    if (!photo) return undefined;
    const abort = new AbortController();
    setLoadState('loading');
    setCropMode(false);
    setBefore(false);
    (async () => {
      try {
        const state = await photoEditorService.get(eventId, photo.id);
        let renderer: EditRenderer | null = null;
        rendererRef.current?.dispose();
        rendererRef.current = null;
        // A RAW the server develops: its 16-bit linear develop, on WebGL2.
        // Without WebGL2 it falls back to the 8-bit base (the camera's preview).
        if (state.raw) {
          const develop = await photoEditorService.developPreview(eventId, photo.id, state.source_version, abort.signal);
          if (abort.signal.aborted || !canvasRef.current) return;
          try {
            renderer = new EditRenderer(canvasRef.current, develop);
          } catch {
            renderer = null;
          }
        }
        if (!renderer) {
          const blob = await photoEditorService.baseImage(eventId, photo.id, state.source_version, abort.signal);
          const bitmap = await createImageBitmap(blob);
          if (abort.signal.aborted || !canvasRef.current) return;
          renderer = new EditRenderer(canvasRef.current, bitmap);
        }
        rendererRef.current = renderer;
        setRaw(state.raw);
        setBackend(renderer.backend);
        const start = state.params ? { ...DEFAULT_PARAMS, ...state.params } : { ...DEFAULT_PARAMS };
        dispatch({ type: 'apply', params: start });
        setSaved(start);
        setLoadState('ready');
      } catch {
        if (!abort.signal.aborted) setLoadState('error');
      }
    })();
    return () => abort.abort();
  // The photo's id decides; a refetched row of the same photo is no reload.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, photo?.id]);

  useEffect(() => () => rendererRef.current?.dispose(), []);
  useEffect(() => {
    photoEditorService.listPresets().then(setPresets).catch(() => setPresets([]));
    photoEditorService.settings().then((s) => setAutoDevelop(s.auto_develop_raw)).catch(() => setAutoDevelop(null));
  }, []);

  // ---- drawing: at most one frame per animation frame, from the newest state.
  const mode: ViewMode = before ? 'before' : cropMode ? 'frame' : 'edit';
  latest.current = { params, mode };
  const draw = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const renderer = rendererRef.current;
      if (!renderer) return;
      setView(renderer.render(latest.current.params, latest.current.mode));
    });
  }, []);
  useEffect(() => { if (loadState === 'ready') draw(); }, [params, mode, loadState, draw]);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  // ---- the canvas is fitted into the stage by CSS size.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !view) return undefined;
    const fit = () => {
      const scale = Math.min(stage.clientWidth / view.width, stage.clientHeight / view.height);
      setDisplay({ width: Math.floor(view.width * scale), height: Math.floor(view.height * scale) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [view]);

  // ---- background progress of saved edits.
  useEffect(() => {
    if (!pending.length) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const status = await photoEditorService.status(eventId);
        const still = pending.filter((id) => status.pending_ids.includes(id) && !status.failed_ids.includes(id));
        if (still.length !== pending.length) onChanged();
        setPending(still);
      } catch {
        // Polled again on the next tick.
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [pending, eventId, onChanged]);

  const save = useCallback(async () => {
    if (!photo || !dirty || saving) return true;
    setSaving(true);
    try {
      // A RAW with any change is developed from its sensor data.
      const toSave = isIdentity(params) ? null : { ...params, develop: raw ? true : params.develop };
      const state = await photoEditorService.save(eventId, photo.id, toSave);
      const next = state.params ? { ...DEFAULT_PARAMS, ...state.params } : { ...DEFAULT_PARAMS };
      setSaved(next);
      setPending((prev) => [...new Set([...prev, photo.id])]);
      toast.success(isIdentity(next) ? t('photoEditor.toast.reset', 'Original restored') : t('photoEditor.toast.saved', 'Edit saved'));
      onChanged();
      return true;
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('photoEditor.toast.saveFailed', 'The edit could not be saved'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [photo, dirty, saving, eventId, params, raw, t, onChanged]);

  // Moving on keeps the work, as Lightroom does.
  const go = useCallback(async (step: 1 | -1) => {
    if (editable.length < 2) return;
    if (dirty && !(await save())) return;
    setIndex((i) => (i + step + editable.length) % editable.length);
  }, [dirty, save, editable.length]);

  const close = useCallback(async () => {
    if (dirty) {
      const keep = await confirm({
        title: t('photoEditor.close.title', 'Save the edit?'),
        message: t('photoEditor.close.message', 'This photo has changes that are not saved yet.'),
        confirmLabel: t('photoEditor.close.save', 'Save'),
        cancelLabel: t('photoEditor.close.discard', 'Discard'),
      });
      if (keep && !(await save())) return;
    }
    onClose();
  }, [dirty, confirm, save, onClose, t]);

  const copySettings = useCallback(() => {
    setClipboard(params);
    try { sessionStorage.setItem(CLIPBOARD_KEY, JSON.stringify(params)); } catch { /* the copy still lives in this window */ }
    toast.info(t('photoEditor.toast.copied', 'Settings copied'));
  }, [params, t]);
  const pasteSettings = useCallback(() => {
    if (!clipboard) return;
    dispatch({ type: 'apply', params: clipboard, parts: ['tone'] });
    toast.info(t('photoEditor.toast.pasted', 'Light, colour and detail pasted'));
  }, [clipboard, t]);
  const auto = useCallback(() => {
    const renderer = rendererRef.current;
    if (renderer) dispatch({ type: 'auto', stats: renderer.toneStats(), linear: renderer.linear });
  }, []);

  // ---- keyboard, as a layer of the dialog stack: a confirm on top keeps its keys.
  const commands = useRef<Record<EditorCommand, () => void>>({} as Record<EditorCommand, () => void>);
  commands.current = {
    previous: () => { void go(-1); },
    next: () => { void go(1); },
    beforeAfter: () => setBefore((b) => !b),
    crop: () => setCropMode((c) => !c),
    rotateLeft: () => dispatch({ type: 'rotate', direction: -1 }),
    rotateRight: () => dispatch({ type: 'rotate', direction: 1 }),
    auto,
    reset: () => dispatch({ type: 'resetAll' }),
    copy: copySettings,
    paste: pasteSettings,
    save: () => { void save(); },
    close: () => { if (shortcutsOpen) setShortcutsOpen(false); else void close(); },
    shortcuts: () => setShortcutsOpen((s) => !s),
  };
  useEffect(() => {
    const layer = pushDialogLayer();
    const onKey = (event: KeyboardEvent) => {
      if (!layer.isTop() || event.isComposing) return;
      const command = resolveEditorKey({
        key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
        inField: isTypingTarget(event.target) || (event.target instanceof HTMLInputElement && event.target.type === 'range'),
      });
      if (!command) return;
      event.preventDefault();
      commands.current[command]();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); layer.release(); };
  }, []);

  if (!photo) return null;

  const base = rendererRef.current;
  const frame = base ? frameSize(params, base.width, base.height) : null;
  const aspectRatio = (id: string): number | null => {
    const entry = ASPECTS.find((a) => a.id === id);
    if (!entry || entry.ratio === null || !base) return null;
    if (entry.ratio === 'original') return frame ? frame.width / frame.height : null;
    return entry.ratio;
  };
  const chooseAspect = (id: string) => {
    setAspect(id);
    const ratio = aspectRatio(id);
    if (ratio && base) dispatch({ type: 'aspect', ratio, width: base.width, height: base.height });
  };
  const effective: CropRect | null = cropMode && view && frame
    ? { x: view.crop.left / frame.width, y: view.crop.top / frame.height, w: view.crop.width / frame.width, h: view.crop.height / frame.height }
    : null;
  const overlayAspect = (() => {
    const ratio = aspectRatio(aspect);
    return ratio && frame ? ratio * (frame.height / frame.width) : null;
  })();
  const slider = (key: SliderKey) => {
    const [min, max, decimals] = SLIDERS[key];
    return (
      <SliderRow
        key={key}
        id={`photo-edit-${key}`}
        label={t(`photoEditor.sliders.${key}`)}
        value={params[key]}
        min={min}
        max={max}
        step={decimals ? 1 / 10 ** decimals : 1}
        format={key === 'exposure' ? (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV` : undefined}
        onChange={(value) => dispatch({ type: 'slider', key, value })}
      />
    );
  };
  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    try {
      const preset = await photoEditorService.createPreset(name, params);
      setPresets((prev) => [...prev, preset].sort((a, b) => a.name.localeCompare(b.name)));
      setPresetName('');
      toast.success(t('photoEditor.presets.saved', 'Preset saved'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('common.error'));
    }
  };
  const deletePreset = async (preset: PhotoEditPreset) => {
    if (!(await confirm({ message: t('photoEditor.presets.confirmDelete', { name: preset.name, defaultValue: 'Delete the preset “{{name}}”?' }), variant: 'danger' }))) return;
    await photoEditorService.deletePreset(preset.id).catch(() => toast.error(t('common.error')));
    setPresets((prev) => prev.filter((p) => p.id !== preset.id));
  };

  return (
    <div className="ui-dark fixed inset-0 z-50 flex flex-col bg-canvas text-body" role="dialog" aria-modal="true" aria-label={t('photoEditor.title', 'Edit photo')}>
      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-shell px-4 py-2">
        <Button variant="ghost" size="icon-sm" aria-label={t('photoEditor.actions.close', 'Close')} onClick={() => void close()}>
          <X className="w-4 h-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 truncate text-sm font-medium text-heading">
            <span className="truncate">{photo.original_filename || photo.filename}</span>
            {raw && <Badge tone="info" appearance="outline">RAW</Badge>}
          </h2>
          <p className="text-xs text-muted">
            {t('photoEditor.position', { current: index + 1, total: editable.length, defaultValue: '{{current}} of {{total}}' })}
            {dirty && <span className="ml-2 inline-flex items-center gap-1 text-warning-text"><span className="w-1.5 h-1.5 rounded-full bg-warning" />{t('photoEditor.unsaved', 'Not saved')}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={t('photoEditor.actions.previous', 'Previous photo')} onClick={() => void go(-1)}><ChevronLeft className="w-4 h-4" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('photoEditor.actions.next', 'Next photo')} onClick={() => void go(1)}><ChevronRight className="w-4 h-4" /></Button>
          <Button variant={before ? 'secondary' : 'ghost'} size="sm" aria-pressed={before} leftIcon={<SplitSquareHorizontal className="w-4 h-4" />} onClick={() => setBefore((b) => !b)}>
            {t('photoEditor.actions.beforeAfter', 'Before / after')}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('photoEditor.actions.copy', 'Copy settings')} title={t('photoEditor.actions.copy', 'Copy settings')} onClick={copySettings}><Copy className="w-4 h-4" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('photoEditor.actions.paste', 'Paste settings')} title={t('photoEditor.actions.paste', 'Paste settings')} disabled={!clipboard} onClick={pasteSettings}><ClipboardPaste className="w-4 h-4" /></Button>
          <Button variant="ghost" size="sm" leftIcon={<Layers className="w-4 h-4" />} onClick={() => setCopyOpen(true)}>
            {t('photoEditor.actions.copyTo', 'Copy to photos…')}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('photoEditor.actions.shortcuts', 'Keyboard shortcuts')} aria-expanded={shortcutsOpen} onClick={() => setShortcutsOpen((s) => !s)}><Keyboard className="w-4 h-4" /></Button>
          <Button variant="primary" size="sm" isLoading={saving} disabled={!dirty} leftIcon={<Save className="w-4 h-4" />} onClick={() => void save()}>
            {t('photoEditor.actions.save', 'Save')}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
        {/* Stage */}
        <div ref={stageRef} className="relative flex flex-1 min-h-[40vh] min-w-0 items-center justify-center p-4">
          <div className="relative" style={{ width: display.width || undefined, height: display.height || undefined }}>
            <canvas
              key={photo.id}
              ref={canvasRef}
              className="block w-full h-full"
              aria-label={before ? t('photoEditor.canvas.before', 'Original') : t('photoEditor.canvas.after', 'Edited preview')}
              data-backend={backend}
            />
            {cropMode && effective && !before && (
              <CropOverlay
                crop={params.crop}
                effective={effective}
                aspect={overlayAspect}
                onChange={(crop) => dispatch({ type: 'crop', crop })}
              />
            )}
          </div>
          {before && (
            <span className="absolute left-6 top-6 rounded-md bg-shell px-2 py-1 text-xs text-heading">{t('photoEditor.canvas.before', 'Original')}</span>
          )}
          {loadState === 'loading' && <p className="absolute text-sm text-muted">{t('photoEditor.loading', 'Loading photo…')}</p>}
          {loadState === 'error' && <p className="absolute text-sm text-danger-text">{t('photoEditor.loadError', 'The photo could not be loaded for editing.')}</p>}
          {shortcutsOpen && (
            <div className="absolute right-4 top-4 z-10 w-72 rounded-xl border border-line bg-panel p-4 shadow-large" role="region" aria-label={t('photoEditor.actions.shortcuts', 'Keyboard shortcuts')}>
              <h3 className="mb-2 text-sm font-medium text-heading">{t('photoEditor.actions.shortcuts', 'Keyboard shortcuts')}</h3>
              <dl className="space-y-1.5 text-xs">
                {SHORTCUTS.map(({ keys, command }) => (
                  <div key={command} className="flex items-center justify-between gap-3">
                    <dt className="text-body">{t(`photoEditor.shortcuts.${command}`)}</dt>
                    <dd className="flex gap-1">{keys.map((k) => <kbd key={k} className="rounded border border-line-strong bg-inset px-1.5 py-0.5 font-mono text-heading">{k}</kbd>)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>

        {/* Panel */}
        <aside className="w-full lg:w-80 shrink-0 overflow-y-auto border-t border-line bg-shell p-4 lg:border-l lg:border-t-0 space-y-4" aria-label={t('photoEditor.panel', 'Adjustments')}>
          <Section
            title={t('photoEditor.sections.crop', 'Crop and rotate')}
            action={<Button size="sm" variant={cropMode ? 'secondary' : 'ghost'} aria-pressed={cropMode} leftIcon={<Crop className="w-4 h-4" />} onClick={() => setCropMode((c) => !c)}>{cropMode ? t('photoEditor.crop.done', 'Done') : t('photoEditor.crop.start', 'Crop')}</Button>}
          >
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('photoEditor.crop.aspect', 'Aspect ratio')}>
              {ASPECTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={aspect === a.id}
                  onClick={() => chooseAspect(a.id)}
                  className={`rounded-lg px-2 py-1 text-xs ${aspect === a.id ? 'tile-selected' : 'border border-line text-body hover:bg-hover'}`}
                >
                  {a.id === 'free' ? t('photoEditor.crop.free', 'Free') : a.id === 'original' ? t('photoEditor.crop.original', 'Original') : a.id}
                </button>
              ))}
            </div>
            <SliderRow
              id="photo-edit-straighten"
              label={t('photoEditor.sliders.straighten', 'Straighten')}
              value={params.straighten}
              min={-STRAIGHTEN_MAX}
              max={STRAIGHTEN_MAX}
              step={0.1}
              format={(v) => `${v.toFixed(1)}°`}
              onChange={(value) => dispatch({ type: 'straighten', value })}
            />
            <div className="flex flex-wrap gap-1">
              <Button size="icon-sm" variant="ghost" aria-label={t('photoEditor.crop.rotateLeft', 'Rotate left')} title={t('photoEditor.crop.rotateLeft', 'Rotate left')} onClick={() => dispatch({ type: 'rotate', direction: -1 })}><RotateCcw className="w-4 h-4" /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={t('photoEditor.crop.rotateRight', 'Rotate right')} title={t('photoEditor.crop.rotateRight', 'Rotate right')} onClick={() => dispatch({ type: 'rotate', direction: 1 })}><RotateCw className="w-4 h-4" /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={t('photoEditor.crop.flipH', 'Flip horizontally')} title={t('photoEditor.crop.flipH', 'Flip horizontally')} onClick={() => dispatch({ type: 'flip', axis: 'h' })}><FlipHorizontal2 className="w-4 h-4" /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={t('photoEditor.crop.flipV', 'Flip vertically')} title={t('photoEditor.crop.flipV', 'Flip vertically')} onClick={() => dispatch({ type: 'flip', axis: 'v' })}><FlipVertical2 className="w-4 h-4" /></Button>
              {params.crop && <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'crop', crop: null })}>{t('photoEditor.crop.clear', 'Clear crop')}</Button>}
            </div>
          </Section>

          <Section
            title={t('photoEditor.sections.light', 'Light')}
            action={<Button size="sm" variant="ghost" leftIcon={<Wand2 className="w-4 h-4" />} onClick={auto}>{t('photoEditor.actions.auto', 'Auto')}</Button>}
          >
            {LIGHT.map(slider)}
          </Section>

          <Section title={t('photoEditor.sections.colour', 'Colour')}>
            {COLOUR.map(slider)}
            <Switch checked={params.bw} onChange={(value) => dispatch({ type: 'bw', value })} label={t('photoEditor.sliders.bw', 'Black & white')} size="sm" />
          </Section>

          <Section title={t('photoEditor.sections.detail', 'Detail')}>
            {DETAIL.map(slider)}
            {(backend === 'canvas' || backend === 'webgl') && <p className="text-xs text-muted">{t('photoEditor.detailNoPreview', 'This browser shows clarity and sharpening only in the saved photo.')}</p>}
          </Section>

          {raw && (
            <Section title={t('photoEditor.sections.raw', 'Camera RAW')}>
              {slider('nr')}
              <p className="text-xs text-muted">{t('photoEditor.raw.nrNote', 'Noise reduction is applied in the saved photo; the preview approximates it by leaving it out.')}</p>
              <Button
                size="sm"
                variant="secondary"
                isLoading={developing}
                onClick={async () => {
                  setDeveloping(true);
                  try {
                    const result = await photoEditorService.developRaw(eventId, { all: true });
                    setPending((prev) => [...new Set([...prev, ...result.photo_ids])]);
                    toast.success(t('photoEditor.raw.queued', { count: result.queued, defaultValue: '{{count}} RAW photos are being developed' }));
                  } catch (error: any) {
                    toast.error(error?.response?.data?.error || t('common.error'));
                  } finally {
                    setDeveloping(false);
                  }
                }}
              >
                {t('photoEditor.raw.developAll', 'Develop all unedited RAW photos')}
              </Button>
              {autoDevelop !== null && (
                <Switch
                  size="sm"
                  checked={autoDevelop}
                  onChange={async (next) => {
                    try {
                      setAutoDevelop((await photoEditorService.saveSettings({ auto_develop_raw: next })).auto_develop_raw);
                    } catch (error: any) {
                      toast.error(error?.response?.data?.error || t('common.error'));
                    }
                  }}
                  label={t('photoEditor.raw.auto', 'Develop new RAW uploads automatically')}
                  description={t('photoEditor.raw.autoNote', 'Uses server CPU for every RAW upload. Until a RAW is developed, guests see the camera’s own preview.')}
                />
              )}
            </Section>
          )}

          <Section title={t('photoEditor.sections.presets', 'Presets')}>
            {presets.length === 0 && <p className="text-xs text-muted">{t('photoEditor.presets.empty', 'No presets yet. Save the current settings as one.')}</p>}
            <ul className="space-y-1">
              {presets.map((preset) => (
                <li key={preset.id} className="flex items-center gap-1">
                  <button type="button" className="min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left text-sm text-body hover:bg-hover" onClick={() => dispatch({ type: 'apply', params: preset.params, parts: ['tone'] })}>
                    {preset.name}
                  </button>
                  <Button size="icon-sm" variant="ghost" aria-label={t('photoEditor.presets.delete', { name: preset.name, defaultValue: 'Delete {{name}}' })} onClick={() => void deletePreset(preset)}><Trash2 className="w-4 h-4" /></Button>
                </li>
              ))}
            </ul>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void savePreset(); }}>
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                maxLength={80}
                placeholder={t('photoEditor.presets.namePlaceholder', 'Preset name')}
                aria-label={t('photoEditor.presets.namePlaceholder', 'Preset name')}
                className="input min-w-0 flex-1 text-sm"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!presetName.trim()}>{t('photoEditor.presets.save', 'Save')}</Button>
            </form>
          </Section>

          <div className="border-t border-line pt-4">
            <Button size="sm" variant="ghost" leftIcon={<RotateCcw className="w-4 h-4" />} onClick={() => dispatch({ type: 'resetAll' })} disabled={isIdentity(params)}>
              {t('photoEditor.actions.reset', 'Reset to original')}
            </Button>
          </div>
        </aside>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-shell px-4 py-1.5 text-xs text-muted" aria-live="polite">
        <span>{pending.length
          ? t('photoEditor.status.pending', { count: pending.length, defaultValue: 'Updating previews and downloads for {{count}} photos…' })
          : t('photoEditor.status.idle', 'Guests see the saved edit; the original file stays untouched.')}</span>
        {backend && <span className="ml-auto">{t(`photoEditor.status.backend.${backend}`)}</span>}
      </footer>

      <BatchCopyDialog
        open={copyOpen}
        onClose={() => setCopyOpen(false)}
        eventId={eventId}
        photos={photos}
        sourceId={photo.id}
        params={params}
        onQueued={(ids) => setPending((prev) => [...new Set([...prev, ...ids])])}
      />
    </div>
  );
};

function sameParams(a: EditParams, b: EditParams): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default PhotoEditor;
