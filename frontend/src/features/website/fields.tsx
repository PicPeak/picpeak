/**
 * Form fields of the website builder's block and page editors.
 */
import React, { createContext, useContext, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff, ImagePlus, Plus, X } from 'lucide-react';
import { Button, Input } from '../../components/common';
import { mediaKey } from '../../services/website.service';
import { ImagePicker } from './ImagePicker';
import type { Background, ImageRef } from './types';

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
}> = ({ label, value, onChange, maxLength, placeholder, helperText, error }) => {
  const id = useId();
  return (
    <Input id={id} label={label} value={value} maxLength={maxLength} placeholder={placeholder}
      helperText={helperText} error={error} onChange={(e) => onChange(e.target.value)} />
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
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      <textarea id={id} className={`input min-h-0 ${mono ? 'font-mono text-xs' : ''}`} rows={rows} value={value}
        maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      {helperText && <p className="mt-1 text-xs text-muted">{helperText}</p>}
    </div>
  );
};

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

export function useBackgroundOptions(): { value: Background; label: string }[] {
  const { t } = useTranslation();
  return [
    { value: 'default', label: t('website.background.default', 'Page') },
    { value: 'light', label: t('website.background.light', 'Light') },
    { value: 'dark', label: t('website.background.dark', 'Dark') },
  ];
}

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

export const LinkField: React.FC<{ label: string; value: string; onChange: (value: string) => void }> = ({ label, value, onChange }) => {
  const { t } = useTranslation();
  return (
    <TextField
      label={label}
      value={value}
      onChange={onChange}
      maxLength={500}
      placeholder="/contact, https://…, mailto:…"
      error={isSafeUrl(value) ? undefined : t('website.fields.badLink', 'Use https://, mailto:, tel:, a page like /about or an anchor like #contact.')}
      helperText={isSafeUrl(value) ? t('website.fields.linkHint', 'A page like /about, a section like #contact, or https://, mailto:, tel:') : undefined}
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
  if (/\/video$/.test(url)) return <video src={url} muted className={`object-cover ${className}`} />;
  return <img src={url} alt="" loading="lazy" className={`object-cover ${className}`} />;
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

/** An ordered list of images (grid, strip). */
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
            <button
              type="button"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              className="absolute top-1 right-1 inline-flex w-6 h-6 items-center justify-center rounded-full bg-panel text-soft shadow opacity-0 group-hover:opacity-100 focus:opacity-100"
              aria-label={t('website.fields.removeImage', 'Remove image {{n}}', { n: index + 1 }) as string}
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
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
