/**
 * What the admin brief card and the portal's Agreements page share: a
 * field's label in the reader's language and a value as text.
 */
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import type { BriefFieldType, BriefPlace, BriefValue } from '../../services/briefs.service';

/** The label in `language` (a regional tag reads as its base), else the default. */
export const briefLabel = (field: { label: string; labels?: Partial<Record<string, string>> }, language: string): string =>
  field.labels?.[language.toLowerCase().split('-')[0]] || field.label;

/** A value as the reader sees it: dates and times in the instance's format. */
export function useBriefValueText(): (type: BriefFieldType, value: BriefValue) => string {
  const { t } = useTranslation();
  const { format, formatTime, formatWallClock } = useLocalizedDate();
  return (type, value) => {
    if (value === null || value === undefined || value === '') return '';
    switch (type) {
      case 'date':
      case 'project_date':
        return format(value as string);
      case 'time':
        return formatTime(value as string);
      case 'datetime':
        return formatWallClock(value as string);
      case 'place':
      case 'place_time': {
        const place = value as BriefPlace;
        return [place.time ? formatTime(place.time) : '', place.place, place.address].filter(Boolean).join(', ');
      }
      case 'yes_no':
        return value ? t('briefs.yes', 'Yes') : t('briefs.no', 'No');
      default:
        return String(value);
    }
  };
}
