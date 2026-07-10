import React from 'react';
import { AlertTriangle, Download } from 'lucide-react';
import Countdown from 'react-countdown';
import { parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';

interface ExpirationBannerProps {
  daysRemaining: number;
  expiresAt: string;
}

export const ExpirationBanner: React.FC<ExpirationBannerProps> = ({ 
  daysRemaining, 
  expiresAt 
}) => {
  const { t } = useTranslation();
  const expirationDate = parseISO(expiresAt);
  
  const countdownRenderer = ({ days, hours, minutes, completed }: any) => {
    if (completed) {
      return <span>{t('gallery.expired')}</span>;
    } else {
      return (
        <span className="font-mono">
          {days}d {hours}h {minutes}m
        </span>
      );
    }
  };

  const getBannerColor = () => {
    if (daysRemaining <= 1) return 'bg-red-600';
    if (daysRemaining <= 3) return 'bg-amber-600';
    return 'bg-amber-500';
  };

  return (
    <div className={`${getBannerColor()} text-white sticky top-0 z-50`}>
      <div className="container py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <AlertTriangle className="w-5 h-5 mr-2 animate-pulse" />
            <span className="font-medium">
              {t('gallery.expiresIn', { count: daysRemaining })} <Countdown date={expirationDate} renderer={countdownRenderer} />
            </span>
          </div>
          <div className="flex items-center text-sm">
            <Download className="w-4 h-4 mr-1" />
            <span>{t('gallery.downloadBefore')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};