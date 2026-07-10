import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { Card, Loading } from '../common';
import { guestsService } from '../../services/guests.service';
import { AuthenticatedImage } from '../common/AuthenticatedImage';
import { buildResourceUrl } from '../../utils/url';

interface GuestSelectionsAggregateProps {
  eventId: number;
}

/**
 * Shows photos sorted by the number of distinct guests who liked or
 * favorited them. Photos with zero picks are filtered server-side.
 */
export const GuestSelectionsAggregate: React.FC<GuestSelectionsAggregateProps> = ({ eventId }) => {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-guests-aggregate', eventId],
    queryFn: () => guestsService.getAggregatePicks(eventId),
  });

  if (isLoading) {
    return <Loading size="lg" text={t('admin.guests.loading', 'Loading...')} />;
  }

  const photos = data?.photos || [];

  if (photos.length === 0) {
    return (
      <Card>
        <div className="p-8 text-center text-neutral-500 dark:text-neutral-400">
          {t('admin.guests.aggregate.empty', 'No guest picks yet.')}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t(
          'admin.guests.aggregate.description',
          'Photos sorted by how many distinct guests liked or favorited them.'
        )}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {photos.map((p) => (
          <div key={p.id} className="relative group">
            <AuthenticatedImage
              src={buildResourceUrl(p.thumbnail_url)}
              alt={p.filename}
              className="w-full aspect-square object-cover rounded"
            />
            <div className="absolute top-2 right-2 bg-accent-dark text-white text-xs font-semibold px-2 py-1 rounded-full flex items-center gap-1 shadow">
              <Users className="w-3 h-3" />
              {p.picker_count}
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity text-white text-xs p-2 rounded-b">
              {p.original_filename || p.filename}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
