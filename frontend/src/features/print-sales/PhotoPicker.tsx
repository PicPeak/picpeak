import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthenticatedImage } from '../../components/common/AuthenticatedImage';
import type { Photo } from '../../types';
import { photoName, photoSource } from './shopping';

export function PhotoPicker({ photos, slug, selected, onToggle, limit }: {
  photos: Photo[]; slug: string; selected: number[]; onToggle: (id: number) => void; limit: number;
}) {
  const { t } = useTranslation(), [search, setSearch] = useState(''), [visible, setVisible] = useState(24);
  const matches = photos.filter(p => photoName(p).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="space-y-4">
    <label className="block">{t('printSales.searchPhotos', 'Find a photograph')}<input className="input w-full mt-1" type="search" value={search}
      onChange={e => { setSearch(e.target.value); setVisible(24); }} /></label>
    <p role="status" className="text-sm text-muted">{selected.length} / {limit} · {t('printSales.pickerHint', 'Selected photos stay selected when you search. Review a separate crop for each one next.')}</p>
    {selected.length > limit && <p role="alert">{t('printSales.tooManyPhotos', 'An order can contain up to 20 photo items. Deselect some photographs before continuing.')}</p>}
    <div className="print-photo-grid">{matches.slice(0, visible).map(p => <button type="button" key={p.id} aria-pressed={selected.includes(p.id)}
      disabled={!selected.includes(p.id) && selected.length >= limit} className="print-photo-tile" onClick={() => onToggle(p.id)}>
      <AuthenticatedImage src={photoSource(p)} slug={slug} isGallery alt="" className="aspect-square w-full object-cover" />
      <span className="print-photo-check" aria-hidden="true">{selected.includes(p.id) ? '✓' : '+'}</span><span className="block truncate p-2">{photoName(p)}</span>
    </button>)}</div>
    {!matches.length && <p>{t('printSales.noMatches', 'No matching photographs.')}</p>}
    {matches.length > visible && <button type="button" className="print-text-button" onClick={() => setVisible(n => n + 24)}>{t('printSales.showMorePhotos', 'Show more photographs')}</button>}
  </section>;
}
