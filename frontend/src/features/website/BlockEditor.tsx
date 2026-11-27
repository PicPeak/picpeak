/**
 * The form of one block in the website builder (issue 2618).
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Notice, Switch } from '../../components/common';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePermission } from '../../hooks/usePermission';
import { websiteService } from '../../services/website.service';
import { BLOCK_VARIANTS, variantLabel } from './blocks';
import {
  ChoiceField, ImageField, ImageListField, LinkField, TextArea, TextField, VideoField, useBackgroundOptions,
} from './fields';
import { SearchField, useDebounced } from './search';
import { loadFailure } from './loadFailure';
import type { Block, Testimonial, WebsiteGallery } from './types';

interface BlockEditorProps {
  block: Block;
  onChange: (next: Block, field?: string) => void;
}

const FORMAT_HINT = 'Blank line = new paragraph. **bold**, *italic*, [link text](https://…)';

export const BlockEditor: React.FC<BlockEditorProps> = ({ block, onChange }) => {
  const { t } = useTranslation();
  const backgrounds = useBackgroundOptions();
  // Every field edit goes through here, typed per block so a field name is checked.
  const set = <B extends Block>(b: B, patch: Partial<B>, field?: string) => onChange({ ...b, ...patch }, field);
  const formatHint = t('website.fields.formatHint', FORMAT_HINT);

  const common = (
    <>
      {BLOCK_VARIANTS[block.type].length > 1 && (
        <ChoiceField
          label={t('website.fields.layout', 'Layout')}
          value={block.variant}
          options={BLOCK_VARIANTS[block.type].map((v) => ({ value: v, label: variantLabel(t, v) }))}
          onChange={(variant) => onChange({ ...block, variant })}
        />
      )}
      {block.type !== 'customHtml' && (
        <ChoiceField
          label={t('website.fields.background', 'Background')}
          value={block.background}
          options={backgrounds}
          onChange={(background) => onChange({ ...block, background: background as Block['background'] })}
        />
      )}
    </>
  );

  let fields: React.ReactNode = null;
  switch (block.type) {
  case 'hero':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextArea label={t('website.fields.subheading', 'Text')} value={block.subheading} rows={3} maxLength={600} onChange={(subheading) => set(block, { subheading }, 'subheading')} />
        {block.variant === 'minimal' ? (
          // The page shows a minimal hero without a picture or video.
          <p className="text-xs text-muted">{t('website.fields.minimalNoImage', 'The “Text only” style shows no picture or video. Choose another style to add one.')}</p>
        ) : (
          <>
            <ImageField label={t('website.fields.image', 'Image')} value={block.image} onChange={(image) => set(block, { image })} />
            <VideoField value={block.video} onChange={(video) => set(block, { video })} />
          </>
        )}
        <TextField label={t('website.fields.buttonLabel', 'Button text')} value={block.buttonLabel} maxLength={60} onChange={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} />
        <LinkField label={t('website.fields.buttonUrl', 'Button link')} value={block.buttonUrl} onChange={(buttonUrl) => set(block, { buttonUrl }, 'buttonUrl')} />
      </>
    );
    break;
  case 'text':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextArea label={t('website.fields.body', 'Text')} value={block.body} rows={8} maxLength={10000} helperText={formatHint} onChange={(body) => set(block, { body }, 'body')} />
      </>
    );
    break;
  case 'imageText':
    fields = (
      <>
        <ImageField label={t('website.fields.image', 'Image')} value={block.image} onChange={(image) => set(block, { image })} />
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextArea label={t('website.fields.body', 'Text')} value={block.body} rows={6} maxLength={5000} helperText={formatHint} onChange={(body) => set(block, { body }, 'body')} />
        <TextField label={t('website.fields.buttonLabel', 'Button text')} value={block.buttonLabel} maxLength={60} onChange={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} />
        <LinkField label={t('website.fields.buttonUrl', 'Button link')} value={block.buttonUrl} onChange={(buttonUrl) => set(block, { buttonUrl }, 'buttonUrl')} />
      </>
    );
    break;
  case 'gallery':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <ChoiceField
          label={t('website.fields.columns', 'Columns on a computer')}
          value={String(block.columns)}
          options={[2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(columns) => set(block, { columns: Number(columns) })}
        />
        <ImageListField label={t('website.fields.images', 'Images')} value={block.images} onChange={(images) => set(block, { images })} />
      </>
    );
    break;
  case 'instagram':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextField label={t('website.fields.handle', 'Account name')} value={block.handle} maxLength={60} placeholder="@studio" onChange={(handle) => set(block, { handle }, 'handle')} />
        <LinkField label={t('website.fields.profileUrl', 'Profile link')} value={block.profileUrl} onChange={(profileUrl) => set(block, { profileUrl }, 'profileUrl')} />
        <ImageListField label={t('website.fields.images', 'Images')} value={block.images} max={12} onChange={(images) => set(block, { images })} />
        <p className="text-xs text-muted">{t('website.fields.instagramHint', 'Pick the photos yourself; nothing is loaded from Instagram.')}</p>
      </>
    );
    break;
  case 'featuredGalleries':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextArea label={t('website.fields.intro', 'Introduction')} value={block.intro} rows={2} maxLength={1000} onChange={(intro) => set(block, { intro }, 'intro')} />
        <FeaturedGalleriesField value={block.galleries} onChange={(galleries) => set(block, { galleries })} />
      </>
    );
    break;
  case 'testimonials':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TestimonialsField value={block.items} onChange={(items, field) => set(block, { items }, field)} />
      </>
    );
    break;
  case 'pricing':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextArea label={t('website.fields.intro', 'Introduction')} value={block.intro} rows={2} maxLength={1000} onChange={(intro) => set(block, { intro }, 'intro')} />
        <PackagesField value={block.packageIds} onChange={(packageIds) => set(block, { packageIds })} />
        <Switch checked={block.showPrices} onChange={(showPrices) => set(block, { showPrices })} label={t('website.fields.showPrices', 'Show prices')} />
        <TextField label={t('website.fields.buttonLabel', 'Button text')} value={block.buttonLabel} maxLength={60} onChange={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} />
        <LinkField label={t('website.fields.buttonUrl', 'Button link')} value={block.buttonUrl} onChange={(buttonUrl) => set(block, { buttonUrl }, 'buttonUrl')} />
      </>
    );
    break;
  case 'contact':
    fields = (
      <>
        <ContactNotice />
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextArea label={t('website.fields.intro', 'Introduction')} value={block.intro} rows={3} maxLength={1000} onChange={(intro) => set(block, { intro }, 'intro')} />
        <Switch checked={block.showPhone} onChange={(showPhone) => set(block, { showPhone })} label={t('website.fields.showPhone', 'Ask for a phone number')} />
        <Switch checked={block.showDate} onChange={(showDate) => set(block, { showDate })} label={t('website.fields.showDate', 'Ask for the event date')} />
        <TextField label={t('website.fields.submitLabel', 'Button text')} value={block.submitLabel} maxLength={60} placeholder={t('website.fields.submitDefault', 'Send message') as string} onChange={(submitLabel) => set(block, { submitLabel }, 'submitLabel')} />
        <TextField label={t('website.fields.successMessage', 'Thank-you message')} value={block.successMessage} maxLength={300} onChange={(successMessage) => set(block, { successMessage }, 'successMessage')} />
      </>
    );
    break;
  case 'booking':
    fields = (
      <>
        <BookingNotice />
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextArea label={t('website.fields.body', 'Text')} value={block.text} rows={3} maxLength={1000} onChange={(text) => set(block, { text }, 'text')} />
        <TextField label={t('website.fields.buttonLabel', 'Button text')} value={block.buttonLabel} maxLength={60} onChange={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} />
      </>
    );
    break;
  case 'spacer':
    fields = <Switch checked={block.divider} onChange={(divider) => set(block, { divider })} label={t('website.fields.divider', 'Show a line')} />;
    break;
  case 'customHtml':
    fields = (
      <>
        <Notice tone="neutral" size="sm">
          {t('website.fields.customHtmlNotice', 'For advanced use. Scripts, frames, forms and event handlers are removed when the page is shown; style it with the site’s custom CSS.')}
        </Notice>
        <TextArea label={t('website.fields.html', 'HTML')} value={block.html} rows={14} mono onChange={(html) => set(block, { html }, 'html')} />
      </>
    );
    break;
  default:
    break;
  }

  return <div className="space-y-4">{common}{fields}</div>;
};

const ContactNotice: React.FC = () => {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  return (
    <Notice tone={flags.messaging ? 'info' : 'warning'} size="sm">
      {flags.messaging
        ? t('website.fields.contactNotice', 'Messages arrive in Messages › Customers. Nothing is emailed to the visitor.')
        : t('website.fields.contactNoticeOff', 'Messages are stored in Messages › Customers, which is switched off. Turn on Messages under Settings › Features to read them.')}
    </Notice>
  );
};

const BookingNotice: React.FC = () => {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  if (flags.calendarBooking) return null;
  return (
    <Notice tone="warning" size="sm">
      {t('website.fields.bookingOff', 'Booking is switched off, so this block is hidden on the site. Turn on Booking under Settings › Features.')}
    </Notice>
  );
};

const FeaturedGalleriesField: React.FC<{
  value: { id: number; text: string }[];
  onChange: (value: { id: number; text: string }[]) => void;
}> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const chosenIds = value.map((g) => g.id);
  // The chosen ones by id, wherever they are in the paged list.
  const chosenQuery = useQuery({
    queryKey: ['website-galleries', 'chosen', chosenIds],
    queryFn: () => websiteService.listGalleries({ ids: chosenIds }),
    enabled: chosenIds.length > 0,
    placeholderData: keepPreviousData,
  });
  const available = useInfiniteQuery({
    queryKey: ['website-galleries', 'on-website', q],
    queryFn: ({ pageParam }) => websiteService.listGalleries({ page: pageParam, q, onWebsite: true }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasMore ? all.length + 1 : undefined),
    placeholderData: keepPreviousData,
  });
  const availableFailure = loadFailure(available, t);
  const chosenFailure = loadFailure(chosenQuery, t);
  const chosenRows = chosenQuery.data?.galleries || [];
  const rows = (available.data?.pages || []).flatMap((p) => p.galleries).filter((g) => g.eligible && !chosenIds.includes(g.id));
  const missing = chosenIds.length && chosenQuery.data ? value.filter((g) => !chosenRows.some((r) => r.id === g.id && r.eligible)) : [];
  // A chosen gallery that is deleted, archived or out of reach comes back
  // without a row: it still counts toward the limit, so it can be removed.
  const unavailable = chosenQuery.data ? chosenIds.filter((id) => !chosenRows.some((r) => r.id === id)) : [];
  const toggle = (id: number, on: boolean) => onChange(on ? [...value, { id, text: '' }] : value.filter((x) => x.id !== id));
  const row = (g: WebsiteGallery, checked: boolean) => (
    <li key={g.id}>
      <label className="flex items-center gap-2 text-sm text-body">
        <input type="checkbox" className="rounded border-line-strong" checked={checked} disabled={!checked && value.length >= 24}
          onChange={(e) => toggle(g.id, e.target.checked)} />
        {g.name}
      </label>
    </li>
  );
  return (
    <fieldset className="space-y-2">
      <legend className="block text-sm font-medium text-body mb-1.5">{t('website.fields.galleries', 'Galleries')}</legend>
      {chosenFailure.blocking || chosenFailure.notice}
      {(chosenRows.length > 0 || unavailable.length > 0) && (
        <ul className="space-y-1">
          {chosenRows.map((g) => row(g, true))}
          {unavailable.map((id) => (
            <UnavailableEntry key={`missing-${id}`} label={t('website.fields.galleryUnavailable', 'Gallery no longer available')}
              removeLabel={t('website.fields.removeUnavailableGallery', 'Remove the unavailable gallery')}
              onRemove={() => onChange(value.filter((x) => x.id !== id))} />
          ))}
        </ul>
      )}
      <SearchField value={search} onChange={setSearch} label={t('website.picker.searchGalleries', 'Search galleries by name')} />
      {availableFailure.blocking || availableFailure.notice}
      {rows.length === 0 && !available.isLoading && !availableFailure.blocking && (
        <p className="text-sm text-muted">{q
          ? t('website.picker.noMatch', 'No gallery on the website matches.')
          : t('website.fields.noGalleries', 'No gallery is on the website yet. Put one on the website from the image picker’s Galleries tab.')}</p>
      )}
      <ul className="space-y-1">{rows.map((g) => row(g, false))}</ul>
      {available.hasNextPage && (
        <Button size="sm" variant="secondary" isLoading={available.isFetchingNextPage} onClick={() => available.fetchNextPage()}>
          {t('website.picker.more', 'Show more')}
        </Button>
      )}
      {chosenRows.filter((r) => !r.hasPassword).map((r) => (
        <p key={`open-${r.id}`} className="text-xs text-warning-text">
          {t('website.fields.galleryOpen', '{{name}} has no password: its card links to it, so every visitor of the website can open the whole gallery.', { name: r.name })}
        </p>
      ))}
      {missing.length > 0 && (
        <p className="text-xs text-warning-text">
          {t('website.fields.galleriesMissing', '{{count}} chosen galleries are no longer on the website and are not shown.', { count: missing.length })}
        </p>
      )}
    </fieldset>
  );
};

const PackagesField: React.FC<{ value: number[]; onChange: (value: number[]) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  // The catalogue is the quotes' (quotes.view, as the server checks).
  const canSeeCatalogue = usePermission('quotes.view');
  const packages = useQuery({ queryKey: ['website-packages'], queryFn: websiteService.listPackages, enabled: canSeeCatalogue });
  const failure = loadFailure(packages, t);
  if (!canSeeCatalogue) {
    return (
      <Notice tone="neutral" size="sm">
        {t('website.fields.packagesNeedQuotes', 'The packages come from the quote catalogue: choosing them needs the permission to view quotes.')}
      </Notice>
    );
  }
  if (packages.isLoading) return null;
  // Not loaded: say so, and call no chosen package unavailable on a guess.
  if (failure.blocking) return failure.blocking;
  const list = packages.data?.available ? packages.data.packages : [];
  // A chosen package that was archived (or the whole catalogue, with quotes
  // off) is gone from the list but still counts toward the limit.
  const unavailable = value.filter((id) => !list.some((p) => p.id === id));
  const unavailableRows = unavailable.map((id) => (
    <UnavailableEntry key={`missing-${id}`} label={t('website.fields.packageUnavailable', 'Package no longer in the catalogue')}
      removeLabel={t('website.fields.removeUnavailablePackage', 'Remove the unavailable package')}
      onRemove={() => onChange(value.filter((x) => x !== id))} />
  ));
  if (!packages.data?.available) {
    return (
      <div className="space-y-2">
        <Notice tone="warning" size="sm">
          {t('website.fields.packagesOff', 'Packages come from the quote catalogue, which needs Quotes under Settings › Features.')}
        </Notice>
        {unavailableRows.length > 0 && <ul className="space-y-1">{unavailableRows}</ul>}
      </div>
    );
  }
  return (
    <fieldset>
      <legend className="block text-sm font-medium text-body mb-1.5">{t('website.fields.packages', 'Packages from your catalogue')}</legend>
      {failure.notice}
      {list.length === 0 && (
        <p className="text-sm text-muted">{t('website.fields.noPackages', 'The catalogue has no packages yet.')}</p>
      )}
      <ul className="space-y-1">
        {list.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2 text-sm text-body">
              <input type="checkbox" className="rounded border-line-strong" checked={value.includes(p.id)}
                // One a quote could not be made from is not offered for a new pick.
                disabled={!value.includes(p.id) && (value.length >= 12 || !!p.unavailable)}
                onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((id) => id !== p.id))} />
              {p.name}
              {p.unavailable && (
                <span className="text-xs text-warning-text">
                  {p.unavailable === 'archived_items'
                    ? t('website.fields.packageArchivedItems', 'Contains archived items, not shown')
                    : t('website.fields.packageNotShown', 'Cannot be quoted, not shown')}
                </span>
              )}
            </label>
          </li>
        ))}
        {unavailableRows}
      </ul>
      <p className="mt-1 text-xs text-muted">{t('website.fields.packagesHint', 'Names, descriptions and prices are edited in the catalogue and stay in step.')}</p>
    </fieldset>
  );
};

/** A chosen gallery or package that no longer exists: shown so it can be removed. */
const UnavailableEntry: React.FC<{ label: string; removeLabel: string; onRemove: () => void }> = ({ label, removeLabel, onRemove }) => (
  <li className="flex items-center gap-2 text-sm text-warning-text">
    <span className="flex-1 min-w-0">{label}</span>
    <Button size="icon-sm" variant="ghost" aria-label={removeLabel} onClick={onRemove}>
      <Trash2 className="w-4 h-4" />
    </Button>
  </li>
);

const TestimonialsField: React.FC<{ value: Testimonial[]; onChange: (value: Testimonial[], field?: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const patch = (index: number, item: Partial<Testimonial>, field?: string) =>
    onChange(value.map((x, i) => (i === index ? { ...x, ...item } : x)), field ? `item${index}.${field}` : undefined);
  return (
    <div className="space-y-3">
      {value.map((item, index) => (
        // Testimonials have no id of their own; the index is their identity.
        <div key={index} className="rounded-lg border border-line p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">{t('website.fields.testimonial', 'Testimonial {{n}}', { n: index + 1 })}</span>
            <Button size="icon-sm" variant="ghost" aria-label={t('website.fields.removeTestimonial', 'Remove testimonial {{n}}', { n: index + 1 }) as string}
              onClick={() => onChange(value.filter((_, i) => i !== index))}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
          <TextArea label={t('website.fields.quote', 'Quote')} value={item.quote} rows={3} maxLength={1200} onChange={(quote) => patch(index, { quote }, 'quote')} />
          {!item.quote.trim() && (
            <p className="text-xs text-warning-text">{t('website.fields.testimonialIncomplete', 'Incomplete: without a quote this testimonial is not shown on the page.')}</p>
          )}
          <TextField label={t('website.fields.author', 'Name')} value={item.author} maxLength={120} onChange={(author) => patch(index, { author }, 'author')} />
          <TextField label={t('website.fields.role', 'Detail (optional)')} value={item.role} maxLength={120} placeholder={t('website.fields.rolePlaceholder', 'Wedding, June 2026') as string} onChange={(role) => patch(index, { role }, 'role')} />
          <ImageField label={t('website.fields.portrait', 'Photo (optional)')} value={item.image} onChange={(image) => patch(index, { image })} />
        </div>
      ))}
      <Button size="sm" variant="secondary" leftIcon={<Plus className="w-4 h-4" />} disabled={value.length >= 24}
        onClick={() => onChange([...value, { quote: '', author: '', role: '', image: null }])}>
        {t('website.fields.addTestimonial', 'Add testimonial')}
      </Button>
    </div>
  );
};
