/**
 * Fields and notices of block forms that ask the server (issue 2618): the
 * galleries on the website, the packages of the quote catalogue, the
 * services that can be booked, and whether messages are read.
 */
import React, { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ExternalLink, Trash2 } from 'lucide-react';
import { Button, Notice } from '../../components/common';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePermission } from '../../hooks/usePermission';
import { websiteService } from '../../services/website.service';
import { SearchField, useDebounced } from './search';
import { loadFailure } from './loadFailure';
import type { WebsiteGallery } from './types';

// As many as the backend takes (document.js: MAX_ITEMS galleries, 12 packages).
const MAX_FEATURED_GALLERIES = 24;
const MAX_PACKAGES = 12;

export const ContactNotice: React.FC = () => {
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
export const BookingTarget: React.FC<{ serviceId: number | null; onChange: (serviceId: number | null) => void }> = ({ serviceId, onChange }) => {
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

export const FeaturedGalleriesField: React.FC<{
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
  // Chosen galleries anyone can open in full from their card.
  const open = chosenRows.filter((r) => !r.hasPassword);
  const toggle = (id: number, on: boolean) => onChange(on ? [...value, { id, text: '' }] : value.filter((x) => x.id !== id));
  const row = (g: WebsiteGallery, checked: boolean) => (
    <li key={g.id}>
      <label className="flex items-center gap-2 text-sm text-body">
        <input type="checkbox" className="rounded border-line-strong" checked={checked} disabled={!checked && value.length >= MAX_FEATURED_GALLERIES}
          onChange={(e) => toggle(g.id, e.target.checked)} />
        {g.name}
      </label>
    </li>
  );
  return (
    <fieldset className="space-y-2">
      <legend className="block text-sm font-medium text-body mb-1.5">{t('website.fields.galleries', 'Galleries')}</legend>
      <SearchField value={search} onChange={setSearch} label={t('website.picker.searchGalleries', 'Search galleries by name')} />
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
      {open.length > 0 && (
        <p className="text-xs text-warning-text">
          {open.length === 1
            ? t('website.fields.galleryOpen', '{{name}} has no password: its card links to it, so every visitor of the website can open the whole gallery.', { name: open[0].name })
            : t('website.fields.galleriesOpen', '{{names}} have no password: their cards link to them, so every visitor of the website can open these galleries in full.', { names: open.map((r) => r.name).join(', ') })}
        </p>
      )}
      {missing.length > 0 && (
        <p className="text-xs text-warning-text">
          {t('website.fields.galleriesMissing', '{{count}} chosen galleries are no longer on the website and are not shown.', { count: missing.length })}
        </p>
      )}
    </fieldset>
  );
};

export const PackagesField: React.FC<{ value: number[]; onChange: (value: number[]) => void }> = ({ value, onChange }) => {
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
                disabled={!value.includes(p.id) && (value.length >= MAX_PACKAGES || !!p.unavailable)}
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
