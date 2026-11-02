import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Heart, Bookmark, Star, MessageCircle, Smile, Palette, ExternalLink } from 'lucide-react';
import { Loading, Modal } from '../common';
import { guestsService, AdminGuest, type AdminGuestFavoriteList } from '../../services/guests.service';
import { AuthenticatedImage } from '../common/AuthenticatedImage';
import { buildResourceUrl } from '../../utils/url';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

interface AdminGuestDetailProps {
  eventId: number;
  guest: AdminGuest;
  onClose: () => void;
}

type Tab = 'all' | 'liked' | 'favorited' | 'rated' | 'commented' | 'reacted' | 'labeled';

export const AdminGuestDetail: React.FC<AdminGuestDetailProps> = ({ eventId, guest, onClose }) => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const [tab, setTab] = useState<Tab>('all');

  // Badges are plain strings in this grid, so a colour label shows as its
  // name rather than a swatch — which also keeps it readable for anyone who
  // can't tell the five colours apart.
  const colorBadge = (color: string) => t(`feedback.colorLabels.${color}`, color);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-guest-detail', eventId, guest.id],
    queryFn: () => guestsService.getGuestDetail(eventId, guest.id),
  });

  const selections = data?.selections;
  const liked = selections?.liked || [];
  const favorited = selections?.favorited || [];
  const rated = selections?.rated || [];
  const commented = selections?.commented || [];
  const reacted = selections?.reacted || [];
  const labeled = selections?.labeled || [];
  // Named favourite lists (issue 2303). A photo in two lists is one favourite
  // in the count, and shows under each list in the Favorites tab.
  const favoriteLists = data?.favorite_lists || [];
  const hasNamedLists = favoriteLists.some((list) => list.id !== null);
  const favoriteCount = new Set(favorited.map((p) => p.id)).size;
  const listLabel = (list: AdminGuestFavoriteList) => list.name ?? t('admin.guests.detail.defaultList', 'Default list');
  // The admin photo grid, narrowed to this list (adminPhotos favorite_list).
  const photosLink = (list: AdminGuestFavoriteList) => {
    const params = new URLSearchParams({
      tab: 'photos',
      favorite_list: list.id === null ? 'default' : String(list.id),
      favorite_guest: String(guest.id),
      favorite_label: `${guest.name}: ${listLabel(list)}`,
    });
    return `?${params.toString()}`;
  };

  // "all" view combines the three visual selection types.
  type GridItem = { photo: { id: number; filename: string; thumbnail_url: string }; badges: string[] };
  const allItems: GridItem[] = [];
  const seen = new Map<number, GridItem>();
  const add = (photo: { id: number; filename: string; thumbnail_url: string }, badge: string) => {
    if (!seen.has(photo.id)) {
      const item: GridItem = { photo, badges: [badge] };
      seen.set(photo.id, item);
      allItems.push(item);
    } else {
      seen.get(photo.id)!.badges.push(badge);
    }
  };
  liked.forEach((p) => add(p, 'like'));
  favorited.forEach((p) => {
    // Once per photo, whatever lists hold it.
    if (!seen.get(p.id)?.badges.includes('favorite')) add(p, 'favorite');
  });
  rated.forEach((r) => add(r.photo, 'rating'));
  reacted.forEach((r) => add(r.photo, r.reaction));
  labeled.forEach((r) => add(r.photo, colorBadge(r.color_label)));

  const visibleItems: GridItem[] =
    tab === 'all'
      ? allItems
      : tab === 'liked'
      ? liked.map((p) => ({ photo: p, badges: ['like'] }))
      : tab === 'favorited'
      ? favorited.filter((p, i) => favorited.findIndex((q) => q.id === p.id) === i).map((p) => ({ photo: p, badges: ['favorite'] }))
      : tab === 'rated'
      ? rated.map((r) => ({ photo: r.photo, badges: [`${r.rating}★`] }))
      : tab === 'reacted'
      ? reacted.map((r) => ({ photo: r.photo, badges: [r.reaction] }))
      : tab === 'labeled'
      ? labeled.map((r) => ({ photo: r.photo, badges: [colorBadge(r.color_label)] }))
      : [];

  return (
    <Modal
      open
      onClose={onClose}
      title={guest.name}
      description={guest.email || undefined}
      size="2xl"
    >
      {isLoading ? (
        <div className="py-4">
          <Loading size="lg" text={t('admin.guests.loadingDetail', 'Loading selections...')} />
        </div>
      ) : (
        <div>
          {/* Stats */}
          <div className="grid grid-cols-5 gap-2 mb-4">
            <div className="p-3 bg-subtle rounded text-center">
              <div className="text-2xl font-semibold text-heading">
                {liked.length}
              </div>
              <div className="text-xs text-muted flex items-center justify-center gap-1">
                <Heart className="w-3 h-3" />
                {t('admin.guests.columns.likes', 'Likes')}
              </div>
            </div>
            <div className="p-3 bg-subtle rounded text-center">
              <div className="text-2xl font-semibold text-heading">
                {favoriteCount}
              </div>
              <div className="text-xs text-muted flex items-center justify-center gap-1">
                <Bookmark className="w-3 h-3" />
                {t('admin.guests.columns.favorites', 'Favorites')}
              </div>
            </div>
            <div className="p-3 bg-subtle rounded text-center">
              <div className="text-2xl font-semibold text-heading">
                {rated.length}
              </div>
              <div className="text-xs text-muted flex items-center justify-center gap-1">
                <Star className="w-3 h-3" />
                {t('admin.guests.columns.ratings', 'Ratings')}
              </div>
            </div>
            <div className="p-3 bg-subtle rounded text-center">
              <div className="text-2xl font-semibold text-heading">
                {commented.length}
              </div>
              <div className="text-xs text-muted flex items-center justify-center gap-1">
                <MessageCircle className="w-3 h-3" />
                {t('admin.guests.columns.comments', 'Comments')}
              </div>
            </div>
            <div className="p-3 bg-subtle rounded text-center">
              <div className="text-2xl font-semibold text-heading">
                {reacted.length}
              </div>
              <div className="text-xs text-muted flex items-center justify-center gap-1">
                <Smile className="w-3 h-3" />
                {t('admin.guests.columns.reactions', 'Reactions')}
              </div>
            </div>
            <div className="p-3 bg-subtle rounded text-center">
              <div className="text-2xl font-semibold text-heading">
                {labeled.length}
              </div>
              <div className="text-xs text-muted flex items-center justify-center gap-1">
                <Palette className="w-3 h-3" />
                {t('admin.guests.columns.colorLabels', 'Color labels')}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-line mb-4">
            {(['all', 'liked', 'favorited', 'rated', 'commented', 'reacted', 'labeled'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition ${
                  tab === k
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted hover:text-heading'
                }`}
              >
                {t(`admin.guests.detail.${k}`, k)}
              </button>
            ))}
          </div>

          {/* The guest's favourite lists (issue 2303) */}
          {hasNamedLists && (tab === 'all' || tab === 'favorited') && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-heading mb-2">
                {t('admin.guests.detail.favoriteLists', 'Favorite lists')}
              </h3>
              <ul className="divide-y divide-line border border-line rounded">
                {favoriteLists.map((list) => (
                  <li key={list.id ?? 'default'} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="font-medium text-heading min-w-0 truncate">{listLabel(list)}</span>
                    <span className="text-muted">
                      {t('admin.guests.detail.listCount', { count: list.count, defaultValue: '{{count}} photos' })}
                    </span>
                    {list.updated_at && (
                      <span className="text-muted">
                        {t('admin.guests.detail.listUpdated', { date: fmtDateTime(String(list.updated_at)), defaultValue: 'Updated {{date}}' })}
                      </span>
                    )}
                    {list.count > 0 && (
                      <Link
                        to={photosLink(list)}
                        onClick={onClose}
                        className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        {t('admin.guests.detail.showInPhotos', 'Show in photos')}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Content */}
          {tab === 'favorited' && hasNamedLists ? (
            <div className="space-y-4">
              {favoriteLists.filter((list) => list.count > 0).map((list) => (
                <div key={list.id ?? 'default'}>
                  <h4 className="text-xs font-medium text-muted mb-2">{listLabel(list)}</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                    {favorited
                      .filter((p) => (p.favorite_list_id ?? null) === list.id)
                      .map((p) => (
                        <div key={p.id} className="relative group">
                          <AuthenticatedImage
                            src={buildResourceUrl(p.thumbnail_url)}
                            alt={p.filename}
                            className="w-full aspect-square object-cover rounded"
                          />
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity text-white text-xs p-2 rounded-b">
                            {p.filename}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          ) : tab === 'commented' ? (
            commented.length === 0 ? (
              <div className="text-sm text-muted text-center py-8">
                {t('admin.guests.detail.noComments', 'No comments')}
              </div>
            ) : (
              <div className="space-y-3">
                {commented.map((c, idx) => (
                  <div key={idx} className="flex gap-3 p-3 bg-subtle rounded">
                    <AuthenticatedImage
                      src={buildResourceUrl(c.photo.thumbnail_url)}
                      alt={c.photo.filename}
                      className="w-16 h-16 object-cover rounded flex-shrink-0"
                    />
                    <div className="flex-1">
                      <div className="text-xs text-muted">
                        {c.photo.filename} · {fmtDateTime(c.created_at)}
                      </div>
                      <p className="text-sm text-heading mt-1">{c.comment}</p>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : visibleItems.length === 0 ? (
            <div className="text-sm text-muted text-center py-8">
              {t('admin.guests.detail.empty', 'No selections in this category')}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
              {visibleItems.map((item) => (
                <div key={item.photo.id} className="relative group">
                  <AuthenticatedImage
                    src={buildResourceUrl(item.photo.thumbnail_url)}
                    alt={item.photo.filename}
                    className="w-full aspect-square object-cover rounded"
                  />
                  <div className="absolute top-1 right-1 flex gap-1">
                    {item.badges.map((b, i) => (
                      <span
                        key={i}
                        className="bg-black/60 text-white text-xs px-1.5 py-0.5 rounded"
                      >
                        {b === 'like' ? '♥' : b === 'favorite' ? '★' : b}
                      </span>
                    ))}
                  </div>
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity text-white text-xs p-2 rounded-b">
                    {item.photo.filename}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
