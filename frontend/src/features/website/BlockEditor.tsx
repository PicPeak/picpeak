/**
 * The form of one block in the website builder (issue 2618).
 */
import React, { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { Button, Notice, Switch } from '../../components/common';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePermission } from '../../hooks/usePermission';
import { websiteService } from '../../services/website.service';
import { BLOCK_VARIANTS, newId, variantLabel } from './blocks';
import {
  BackgroundField, ChoiceField, ImageField, ImageListField, LinkField, RichTextField, TextArea, TextField, VideoField,
} from './fields';
import { SearchField, useDebounced } from './search';
import { CtaButtonsField, FaqItemsField, LogosField, SocialLinksField, StepsField } from './itemForms';
import { LinkTargetField } from './LinkTargetField';
import { loadFailure } from './loadFailure';
import type { Block, Testimonial, WebsiteGallery } from './types';

interface BlockEditorProps {
  block: Block;
  onChange: (next: Block, field?: string) => void;
  /** The branding's colours, offered for a custom background. */
  brandColors?: string[];
}

export const BlockEditor: React.FC<BlockEditorProps> = ({ block, onChange, brandColors }) => {
  const { t } = useTranslation();
  // Every field edit goes through here, typed per block so a field name is checked.
  const set = <B extends Block>(b: B, patch: Partial<B>, field?: string) => onChange({ ...b, ...patch }, field);

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
      {block.type !== 'customHtml' && <BackgroundField block={block} brandColors={brandColors} onChange={(next) => onChange(next)} />}
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
        <LinkTargetField label={t('website.fields.buttonUrl', 'Button link')} value={block.buttonTarget ?? null} onChange={(buttonTarget) => set(block, { buttonTarget }, 'buttonTarget')} />
      </>
    );
    break;
  case 'text':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        {block.variant === 'columns' ? (
          <>
            <RichTextField key="body" label={t('website.fields.leftColumn', 'Left column')} value={block.body} onChange={(body) => set(block, { body }, 'body')} />
            <RichTextField key="bodyRight" label={t('website.fields.rightColumn', 'Right column')} value={block.bodyRight || ''}
              helperText={t('website.fields.rightColumnHint', 'Leave it empty and the left text flows over both columns.')}
              onChange={(bodyRight) => set(block, { bodyRight }, 'bodyRight')} />
          </>
        ) : (
          <RichTextField key="body" label={t('website.fields.body', 'Text')} value={block.body} onChange={(body) => set(block, { body }, 'body')} />
        )}
      </>
    );
    break;
  case 'imageText':
    fields = (
      <>
        <ImageField label={t('website.fields.image', 'Image')} value={block.image} onChange={(image) => set(block, { image })} />
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <RichTextField label={t('website.fields.body', 'Text')} value={block.body} onChange={(body) => set(block, { body }, 'body')} />
        <TextField label={t('website.fields.buttonLabel', 'Button text')} value={block.buttonLabel} maxLength={60} onChange={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} />
        <LinkTargetField label={t('website.fields.buttonUrl', 'Button link')} value={block.buttonTarget ?? null} onChange={(buttonTarget) => set(block, { buttonTarget }, 'buttonTarget')} />
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
        <LinkField label={t('website.fields.profileUrl', 'Profile link')} value={block.profileUrl} placeholder="https://www.instagram.com/…"
          hint={t('website.fields.profileUrlHint', 'The address of your profile, which the block links to.')}
          onChange={(profileUrl) => set(block, { profileUrl }, 'profileUrl')} />
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
        <LinkTargetField label={t('website.fields.buttonUrl', 'Button link')} value={block.buttonTarget ?? null} onChange={(buttonTarget) => set(block, { buttonTarget }, 'buttonTarget')} />
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
        <BookingTarget serviceId={block.serviceId} onChange={(serviceId) => set(block, { serviceId })} />
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <TextArea label={t('website.fields.body', 'Text')} value={block.text} rows={3} maxLength={1000} onChange={(text) => set(block, { text }, 'text')} />
        <TextField label={t('website.fields.buttonLabel', 'Button text')} value={block.buttonLabel} maxLength={60} onChange={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} />
      </>
    );
    break;
  case 'spacer':
    fields = <Switch checked={block.divider} onChange={(divider) => set(block, { divider })} label={t('website.fields.divider', 'Show a line')} />;
    break;
  case 'faq':
    fields = (
      <>
        <TextField label={t('website.fields.headingOptional', 'Heading (optional)')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <FaqItemsField value={block.items} onChange={(items, field) => set(block, { items }, field)} />
      </>
    );
    break;
  case 'steps':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <StepsField value={block.items} withIcons={block.variant === 'icons'} onChange={(items, field) => set(block, { items }, field)} />
      </>
    );
    break;
  case 'cta':
    fields = (
      <>
        <TextField label={t('website.fields.heading', 'Heading')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <RichTextField label={t('website.fields.body', 'Text')} value={block.text} onChange={(text) => set(block, { text }, 'text')} />
        <CtaButtonsField value={block.buttons} onChange={(buttons, field) => set(block, { buttons }, field)} />
      </>
    );
    break;
  case 'logos':
    fields = (
      <>
        <TextField label={t('website.fields.headingOptional', 'Heading (optional)')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <Switch checked={block.grayscale} onChange={(grayscale) => set(block, { grayscale })} label={t('website.fields.grayscale', 'Show logos in grey, in colour on hover')} />
        <LogosField value={block.items} onChange={(items, field) => set(block, { items }, field)} />
      </>
    );
    break;
  case 'social':
    fields = (
      <>
        <TextField label={t('website.fields.headingOptional', 'Heading (optional)')} value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading }, 'heading')} />
        <SocialLinksField value={block.links} onChange={(links, field) => set(block, { links }, field)} />
      </>
    );
    break;
  case 'divider':
    fields = (
      <>
        <ChoiceField label={t('website.fields.lineWidth', 'Width')} value={block.width}
          options={[{ value: 'full', label: t('website.fields.widthFull', 'Full') }, { value: 'short', label: t('website.fields.widthShort', 'Short') }]}
          onChange={(width) => set(block, { width: width as typeof block.width })} />
        <ChoiceField label={t('website.fields.spacing', 'Space around it')} value={block.spacing}
          options={(['none', 'small', 'medium', 'large'] as const).map((v) => ({ value: v, label: v === 'none' ? t('website.fields.spacingNone', 'None') : variantLabel(t, v) }))}
          onChange={(spacing) => set(block, { spacing: spacing as typeof block.spacing })} />
      </>
    );
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
        ? t('website.fields.contactNotice', 'Messages arrive in Messages › Customers and are mailed to the studio. Who gets them, a confirmation to the visitor and the spam check: Design › Contact form.')
        : t('website.fields.contactNoticeOff', 'Messages are stored in Messages › Customers, which is switched off. Turn on Messages under Settings › Features to read them.')}
    </Notice>
  );
};

/**
 * Where the booking button leads (the public booking page, /book), whether
 * it shows at all (client booking on, something bookable) and which service
 * it opens with.
 */
const BookingTarget: React.FC<{ serviceId: number | null; onChange: (serviceId: number | null) => void }> = ({ serviceId, onChange }) => {
  const { t } = useTranslation();
  const id = useId();
  const options = useQuery({ queryKey: ['website-booking'], queryFn: websiteService.getBooking });
  const data = options.data;
  return (
    <div className="space-y-3">
      {data && !data.flagOn && (
        <Notice tone="warning" size="sm">
          {t('website.fields.bookingOff', 'Client booking is switched off, so this block is hidden on the website. Turn it on under Settings › Features.')}
        </Notice>
      )}
      {data && data.flagOn && !data.services.length && (
        <Notice tone="warning" size="sm">
          {t('website.fields.bookingNothing', 'Nothing can be booked yet, so this block is hidden on the website. Mark a service in the quote catalogue as bookable.')}
        </Notice>
      )}
      <div className="rounded-lg border border-line p-3 text-sm text-body space-y-1.5">
        <p>{t('website.fields.bookingTarget', 'Opens your booking page, /book, where visitors pick a service and a time and send a request.')}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <a href="/book" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            {t('website.fields.openBooking', 'Open the booking page')}<ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
          <Link to="/admin/clients/bookings" className="text-accent hover:underline">{t('website.fields.bookingSettings', 'Booking settings')}</Link>
        </div>
      </div>
      {data && data.services.length > 0 && (
        <div>
          <label htmlFor={id} className="block text-sm font-medium text-body mb-1.5">{t('website.fields.bookingService', 'Service')}</label>
          <select id={id} className="input" value={serviceId ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('website.fields.bookingAnyService', 'Let the visitor choose')}</option>
            {data.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}
    </div>
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
  // The answer kept from an earlier selection (keepPreviousData, or none
  // fetched once the selection is empty) still lists what was unchecked:
  // only the galleries chosen now are shown as chosen.
  const chosenRows = (chosenQuery.data?.galleries || []).filter((r) => chosenIds.includes(r.id));
  const answered = !!chosenQuery.data && !chosenQuery.isPlaceholderData;
  const rows = (available.data?.pages || []).flatMap((p) => p.galleries).filter((g) => g.eligible && !chosenIds.includes(g.id));
  const missing = chosenIds.length && answered ? value.filter((g) => !chosenRows.some((r) => r.id === g.id && r.eligible)) : [];
  // A chosen gallery that is deleted, archived or out of reach comes back
  // without a row: it still counts toward the limit, so it can be removed.
  const unavailable = answered ? chosenIds.filter((id) => !chosenRows.some((r) => r.id === id)) : [];
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
        // Keyed by the testimonial's id: removing one never hands its fields to the next.
        <div key={item.id || index} className="rounded-lg border border-line p-3 space-y-3">
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
        onClick={() => onChange([...value, { id: newId(), quote: '', author: '', role: '', image: null }])}>
        {t('website.fields.addTestimonial', 'Add testimonial')}
      </Button>
    </div>
  );
};
