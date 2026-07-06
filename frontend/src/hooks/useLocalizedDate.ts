import { useTranslation } from 'react-i18next';
import { format as dateFnsFormat, formatDistanceToNow as dateFnsFormatDistanceToNow } from 'date-fns';
import { de, enUS, ptBR, fr } from 'date-fns/locale';
import { usePublicSettings } from './usePublicSettings';

// Convert old date format strings to new date-fns format
const convertDateFormat = (format: string): string => {
  return format
    .replace(/DD/g, 'dd')    // Days: DD -> dd
    .replace(/YYYY/g, 'yyyy') // Years: YYYY -> yyyy
    .replace(/YY/g, 'yy');    // Short years: YY -> yy
};

export const useLocalizedDate = () => {
  const { i18n } = useTranslation();
  
  const { data: settings } = usePublicSettings();
  
  const getLocale = () => {
    switch (i18n.language) {
      case 'de':
        return de;
      case 'pt':
      case 'pt-BR':
        return ptBR;
      case 'fr':
        return fr;
      default:
        return enUS;
    }
  };
  
  const format = (date: Date | string, formatStr?: string) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    // Use admin-configured date format if available and no format string provided
    let dateFormat = formatStr;
    if (!dateFormat && settings?.general_date_format) {
      // Handle both string and object formats
      dateFormat = typeof settings.general_date_format === 'string' 
        ? settings.general_date_format 
        : settings.general_date_format.format || 'PPP';
    }
    dateFormat = dateFormat || 'PPP';
    
    // Convert old format to new format
    dateFormat = convertDateFormat(dateFormat);
    
    return dateFnsFormat(dateObj, dateFormat, { locale: getLocale() });
  };
  
  const formatDistanceToNow = (date: Date | string, options?: { addSuffix?: boolean }) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateFnsFormatDistanceToNow(dateObj, { ...options, locale: getLocale() });
  };

  // Time-format pattern: '24h' → 'HH:mm' (e.g. 14:32), '12h' →
  // 'h:mm a' (e.g. 2:32 PM). Defaults to 24h when the setting is
  // missing or unrecognised — matches the operator's CH/DE locale.
  const timeFormatToken = settings?.general_time_format === '12h' ? 'h:mm a' : 'HH:mm';

  /**
   * Time only — respects the admin-configured `general_time_format`
   * (24-hour HH:mm by default; 12-hour h:mm AM/PM when toggled).
   *
   * Accepts a Date, an ISO string, OR a bare "HH:MM" / "HH:MM:SS"
   * clock string (e.g. "09:00" from a stored startTime/endTime).
   * The bare-time path constructs an arbitrary epoch date with the
   * given hours/minutes so date-fns can format the time half — the
   * date half is discarded by the output pattern.
   */
  const formatTime = (date: Date | string) => {
    if (typeof date === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(date)) {
      const [h, m] = date.split(':');
      const d = new Date(2000, 0, 1, parseInt(h, 10), parseInt(m, 10));
      return dateFnsFormat(d, timeFormatToken, { locale: getLocale() });
    }
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateFnsFormat(dateObj, timeFormatToken, { locale: getLocale() });
  };

  /**
   * Date + time, respecting both `general_date_format` for the date
   * half and `general_time_format` for the time half. Examples with
   * 24h time format:
   *   DD.MM.YYYY → "20.05.2026 14:32"
   *   YYYY-MM-DD → "2026-05-20 14:32"
   * With 12h time format:
   *   DD.MM.YYYY → "20.05.2026 2:32 PM"
   *
   * Pass `formatStr` to override the date half (same shape as `format()`).
   */
  const formatDateTime = (date: Date | string, formatStr?: string) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    let dateFormat = formatStr;
    if (!dateFormat && settings?.general_date_format) {
      dateFormat = typeof settings.general_date_format === 'string'
        ? settings.general_date_format
        : settings.general_date_format.format || 'PPP';
    }
    dateFormat = dateFormat || 'PPP';
    dateFormat = convertDateFormat(dateFormat);
    return dateFnsFormat(dateObj, `${dateFormat} ${timeFormatToken}`, { locale: getLocale() });
  };

  return {
    format,
    formatTime,
    formatDateTime,
    formatDistanceToNow,
    locale: getLocale(),
    dateFormat: settings?.general_date_format
      ? convertDateFormat(
          typeof settings.general_date_format === 'string'
            ? settings.general_date_format
            : settings.general_date_format.format || 'PPP'
        )
      : 'PPP',
    /** '12h' or '24h' — exposed so components can decide between
     *  rendering a native <input type="time"> (always 24h value
     *  internally) vs a custom 12h-styled control if needed. */
    timeFormat: (settings?.general_time_format === '12h' ? '12h' : '24h') as '12h' | '24h',
    /** BCP-47 language tag to pin on `<input type="date">` so the
     *  browser-rendered placeholder + parsing match the admin's
     *  configured `general_date_format`. Chrome/Edge honour this;
     *  Safari/Firefox follow OS locale regardless (no way around it
     *  without a custom date-picker component).
     *
     *  Mapping derives from the format string's first token:
     *    DD/dd  → de-DE  (renders TT.MM.JJJJ)
     *    YYYY/yyyy → en-CA  (renders YYYY-MM-DD)
     *    MM     → en-US  (renders MM/DD/YYYY)
     *    fallback → i18n.language. */
    dateInputLang: (() => {
      const raw = settings?.general_date_format;
      const fmt = typeof raw === 'string' ? raw : raw?.format;
      if (fmt) {
        const head = fmt.trim().slice(0, 2).toUpperCase();
        if (head === 'DD') return 'de-DE';
        if (head === 'YY') return 'en-CA';
        if (head === 'MM') return 'en-US';
      }
      return i18n.language || 'en';
    })(),
  };
};