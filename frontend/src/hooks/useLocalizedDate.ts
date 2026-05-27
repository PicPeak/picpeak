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
  
  return {
    format,
    formatDistanceToNow,
    locale: getLocale(),
    dateFormat: settings?.general_date_format 
      ? convertDateFormat(
          typeof settings.general_date_format === 'string' 
            ? settings.general_date_format 
            : settings.general_date_format.format || 'PPP'
        )
      : 'PPP'
  };
};