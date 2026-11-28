/**
 * Form fields of the website builder's block and page editors.
 */
import React, { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { CMSEditor } from '../../components/admin/CMSEditor';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, ImageOff, ImagePlus, Pipette, Plus, RotateCcw, X } from 'lucide-react';
import { Button, Input } from '../../components/common';
import { mediaKey } from '../../services/website.service';
import { buildResourceUrl } from '../../utils/url';
import { moveItem } from './blocks';
import { ImagePicker } from './ImagePicker';
import type { Background, Block, ImageRef } from './types';

/** Thumbnail URLs of the document's images; null = not shown on the site. */
export const MediaUrlsContext = createContext<Record<string, string | null>>({});

export const labelClass = 'block text-sm font-medium text-body mb-1.5';

export const TextField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  placeholder?: string;
  helperText?: string;
  error?: string;
  type?: 'text' | 'password' | 'email';
}> = ({ label, value, onChange, maxLength, placeholder, helperText, error, type = 'text' }) => {
  const id = useId();
  return (
    <Input id={id} type={type} label={label} value={value} maxLength={maxLength} placeholder={placeholder}
      helperText={helperText} error={error} autoComplete={type === 'password' ? 'new-password' : undefined} onChange={(e) => onChange(e.target.value)} />
  );
};

export const TextArea: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  maxLength?: number;
  helperText?: string;
  mono?: boolean;
}> = ({ label, value, onChange, rows = 4, maxLength, helperText, mono }) => {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grows with its text from `rows` up, so a long text is read whole rather
  // than through a scrollbar inside the panel's own.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [value]);
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      <textarea ref={ref} id={id} className={`input min-h-0 resize-none ${mono ? 'font-mono text-xs' : ''}`} rows={rows} value={value}
        style={{ overflowY: 'hidden' }} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      {helperText && <p className="mt-1 text-xs text-muted">{helperText}</p>}
    </div>
  );
};

/** Rich text (the text block): the CMS editor's compact form, HTML out. */
export const RichTextField: React.FC<{ label: string; value: string; onChange: (value: string) => void; helperText?: string }> = ({ label, value, onChange, helperText }) => (
  <div>
    <span className={labelClass}>{label}</span>
    <CMSEditor compact content={value} onChange={onChange} />
    {helperText && <p className="mt-1 text-xs text-muted">{helperText}</p>}
  </div>
);

export const SelectField: React.FC<{
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
};

/** A row of mutually exclusive choices (layout variant, background). */
export const ChoiceField: React.FC<{
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => (
  <fieldset>
    <legend className={labelClass}>{label}</legend>
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 h-8 rounded-lg text-sm border ${value === o.value ? 'tile-selected border-transparent' : 'border-line text-body hover:bg-hover'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  </fieldset>
);

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A colour picker with a reset: `value` null means "not set here" (the
 * branding's colour, or automatic), which `emptyLabel` says.
 */
export const ColorField: React.FC<{
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  emptyLabel?: string;
  resetLabel?: string;
}> = ({ label, value, onChange, emptyLabel, resetLabel }) => {
  const { t } = useTranslation();
  const id = useId();
  const set = !!value && HEX.test(value);
  return (
    <div className="flex items-center gap-3">
      {/* Not set: an "automatic" chip, with the picker lying invisibly over
          it. The native swatch would be black, a colour the page may not use. */}
      <span className="relative h-9 w-12 shrink-0">
        {!set && (
          <span data-colour-auto aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center rounded-md border border-dashed border-line-strong bg-panel text-muted">
            <Pipette className="w-4 h-4" />
          </span>
        )}
        <input id={id} type="color" aria-label={label}
          className={`absolute inset-0 h-full w-full cursor-pointer rounded-md border border-line-strong bg-panel p-1 ${set ? '' : 'opacity-0'}`}
          value={set && value ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
      </span>
      <div className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-body">{label}</span>
        <span className="block text-xs text-muted">{value || emptyLabel || t('website.site.fromBranding', 'From branding')}</span>
      </div>
      {value && (
        <Button size="icon-sm" variant="ghost" onClick={() => onChange(null)}
          aria-label={resetLabel || t('website.site.resetColor', 'Use the branding colour for {{name}}', { name: label }) as string}>
          <RotateCcw className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
};

// Neutrals offered next to the branding's colours for a custom background.
const NEUTRALS = ['#ffffff', '#f5f5f4', '#e7e5e4', '#57534e', '#1c1917'];

/**
 * A block's background: page, light, dark, or a custom colour from the
 * branding swatches, a few neutrals or the picker. The text colour follows
 * for contrast unless one is set (backend renderer customBackgroundStyle).
 */
export const BackgroundField: React.FC<{ block: Block; brandColors?: string[]; onChange: (next: Block) => void }> = ({ block, brandColors = [], onChange }) => {
  const { t } = useTranslation();
  const swatches = [...new Set([...brandColors, ...NEUTRALS])];
  const options: { value: Background; label: string }[] = [
    { value: 'default', label: t('website.background.default', 'Page') },
    { value: 'light', label: t('website.background.light', 'Light') },
    { value: 'dark', label: t('website.background.dark', 'Dark') },
    { value: 'custom', label: t('website.background.custom', 'Custom') },
  ];
  const choose = (background: string) => onChange(background === 'custom'
    ? { ...block, background: 'custom', backgroundColor: block.backgroundColor || swatches[0], textColor: block.textColor ?? null }
    : { ...block, background: background as Background, backgroundColor: undefined, textColor: undefined });
  return (
    <div className="space-y-3">
      <ChoiceField label={t('website.fields.background', 'Background')} value={block.background} options={options} onChange={choose} />
      {block.background === 'custom' && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="flex flex-wrap gap-1.5">
            {swatches.map((colour) => (
              <button key={colour} type="button" onClick={() => onChange({ ...block, backgroundColor: colour })}
                aria-label={t('website.background.useColour', 'Use colour {{colour}}', { colour }) as string}
                aria-pressed={block.backgroundColor === colour}
                className={`h-7 w-7 rounded-md border ${block.backgroundColor === colour ? 'ring-2 ring-accent ring-offset-1' : 'border-line-strong'}`}
                style={{ backgroundColor: colour }} />
            ))}
          </div>
          <ColorField label={t('website.background.colour', 'Background colour')} value={block.backgroundColor || null}
            onChange={(backgroundColor) => onChange({ ...block, backgroundColor: backgroundColor || swatches[0] })} />
          <ColorField label={t('website.background.textColour', 'Text colour')} value={block.textColor || null}
            emptyLabel={t('website.background.textAutomatic', 'Automatic, for contrast')}
            resetLabel={t('website.background.textReset', 'Pick the text colour automatically') as string}
            onChange={(textColor) => onChange({ ...block, textColor })} />
        </div>
      )}
    </div>
  );
};

/**
 * Same rule as the backend's safeUrl: http(s), mailto, tel, a path on this
 * site or an anchor. Anything else is dropped on save, so say so here.
 */
export function isSafeUrl(value: string): boolean {
  const url = value.trim();
  if (!url) return true;
  if (/[\s\\]/.test(url) && !/^tel:/i.test(url)) return false;
  if (url.startsWith('#')) return /^#[A-Za-z0-9_-]{0,80}$/.test(url);
  if (url.startsWith('/')) return !url.startsWith('//');
  if (/^tel:\+?[0-9 ()./-]{3,40}$/i.test(url)) return true;
  if (/^mailto:/i.test(url)) return true;
  if (/^https?:\/\//i.test(url)) {
    try { return !!new URL(url).hostname; } catch { return false; }
  }
  return false;
}

export const LinkField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** What this address is for, when the general hint would not say. */
  hint?: string;
  placeholder?: string;
}> = ({ label, value, onChange, hint, placeholder = '/contact, https://…, mailto:…' }) => {
  const { t } = useTranslation();
  return (
    <TextField
      label={label}
      value={value}
      onChange={onChange}
      maxLength={500}
      placeholder={placeholder}
      error={isSafeUrl(value) ? undefined : t('website.fields.badLink', 'Use https://, mailto:, tel:, a page like /about or an anchor like #contact.')}
      helperText={isSafeUrl(value) ? hint || t('website.fields.linkHint', 'A page like /about, a section like #contact, or https://, mailto:, tel:') : undefined}
    />
  );
};

const Thumb: React.FC<{ refValue: ImageRef | { source: 'asset'; id: string }; className?: string }> = ({ refValue, className = '' }) => {
  const { t } = useTranslation();
  const urls = useContext(MediaUrlsContext);
  const key = mediaKey(refValue);
  const url = urls[key];
  if (url === null) {
    return (
      <span className={`flex flex-col items-center justify-center gap-1 bg-warning-soft text-warning-text text-[11px] text-center p-1 ${className}`}
        title={t('website.fields.notShown', 'Not shown on the site: its gallery is no longer on the website.') as string}>
        <ImageOff className="w-4 h-4" aria-hidden="true" />
        {t('website.fields.notShownShort', 'Not shown')}
      </span>
    );
  }
  if (!url) return <span className={`block bg-fill animate-pulse ${className}`} />;
  // Root-relative /site-media paths live on the backend's resource origin.
  if (/\/video$/.test(url)) return <video src={buildResourceUrl(url)} muted className={`object-cover ${className}`} />;
  return <img src={buildResourceUrl(url)} alt="" loading="lazy" className={`object-cover ${className}`} />;
};

/** One image with its alt text. */
export const ImageField: React.FC<{
  label: string;
  value: ImageRef | null;
  onChange: (value: ImageRef | null) => void;
}> = ({ label, value, onChange }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <span className={labelClass}>{label}</span>
      {value ? (
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <Thumb refValue={value} className="w-24 h-16 rounded-lg flex-none" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{t('website.fields.replace', 'Replace')}</Button>
              <Button size="sm" variant="ghost" onClick={() => onChange(null)}>{t('website.fields.remove', 'Remove')}</Button>
            </div>
          </div>
          <TextField label={t('website.fields.alt', 'Description for screen readers')} value={value.alt || ''} maxLength={300}
            onChange={(alt) => onChange({ ...value, alt })} />
        </div>
      ) : (
        <Button size="sm" variant="secondary" leftIcon={<ImagePlus className="w-4 h-4" />} onClick={() => setOpen(true)}>
          {t('website.fields.chooseImage', 'Choose image')}
        </Button>
      )}
      <ImagePicker open={open} onClose={() => setOpen(false)} onSelect={([ref]) => onChange({ ...ref, alt: value?.alt || '' })} />
    </div>
  );
};

/** A hero video upload (the image stays as its poster). */
export const VideoField: React.FC<{
  value: { source: 'asset'; id: string } | null;
  onChange: (value: { source: 'asset'; id: string } | null) => void;
}> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <span className={labelClass}>{t('website.fields.video', 'Background video (optional)')}</span>
      <div className="flex flex-wrap items-center gap-2">
        {value && <Thumb refValue={value} className="w-24 h-16 rounded-lg" />}
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {value ? t('website.fields.replace', 'Replace') : t('website.fields.chooseVideo', 'Choose video')}
        </Button>
        {value && <Button size="sm" variant="ghost" onClick={() => onChange(null)}>{t('website.fields.remove', 'Remove')}</Button>}
      </div>
      <ImagePicker open={open} kind="video" onClose={() => setOpen(false)}
        onSelect={([ref]) => { if (ref.source === 'asset') onChange({ source: 'asset', id: ref.id }); }} />
    </div>
  );
};

// A button on a picture tile: shown on hover or keyboard focus, and always
// where there is no hovering (a touch screen).
const tileButton = 'inline-flex w-6 h-6 items-center justify-center rounded-full bg-panel text-soft shadow opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 disabled:hidden';

/** An ordered list of images (grid, strip): add, remove, move earlier or later. */
export const ImageListField: React.FC<{
  label: string;
  value: ImageRef[];
  onChange: (value: ImageRef[]) => void;
  max?: number;
}> = ({ label, value, onChange, max = 60 }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <span className={labelClass}>{label}</span>
      <ul className="grid grid-cols-4 gap-1.5">
        {value.map((ref, index) => (
          <li key={`${mediaKey(ref)}-${index}`} className="relative group">
            <Thumb refValue={ref} className="w-full aspect-square rounded-md" />
            <button type="button" onClick={() => onChange(value.filter((_, i) => i !== index))}
              className={`absolute top-1 right-1 ${tileButton}`}
              aria-label={t('website.fields.removeImage', 'Remove image {{n}}', { n: index + 1 }) as string}>
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button type="button" disabled={index === 0} onClick={() => onChange(moveItem(value, index, index - 1))}
              className={`absolute bottom-1 left-1 ${tileButton}`}
              aria-label={t('website.fields.moveImageEarlier', 'Move image {{n}} earlier', { n: index + 1 }) as string}>
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button type="button" disabled={index === value.length - 1} onClick={() => onChange(moveItem(value, index, index + 1))}
              className={`absolute bottom-1 right-1 ${tileButton}`}
              aria-label={t('website.fields.moveImageLater', 'Move image {{n}} later', { n: index + 1 }) as string}>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {value.length < max && (
          <li>
            <button type="button" onClick={() => setOpen(true)}
              className="flex w-full aspect-square items-center justify-center rounded-md border-2 border-dashed border-line-strong text-muted hover:text-body hover:border-accent"
              aria-label={t('website.fields.addImages', 'Add images') as string}>
              <Plus className="w-5 h-5" aria-hidden="true" />
            </button>
          </li>
        )}
      </ul>
      <p className="mt-1 text-xs text-muted">{t('website.fields.imageCount', '{{count}} of {{max}} images', { count: value.length, max })}</p>
      <ImagePicker open={open} multiple onClose={() => setOpen(false)}
        onSelect={(refs) => onChange([...value, ...refs.map((r) => ({ ...r, alt: '' }))].slice(0, max))} />
    </div>
  );
};
