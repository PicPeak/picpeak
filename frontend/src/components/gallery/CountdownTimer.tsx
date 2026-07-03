import React, { useState, useEffect } from 'react';
import { Clock, AlertCircle } from 'lucide-react';
import { differenceInSeconds } from 'date-fns';
import { useTranslation } from 'react-i18next';

interface CountdownTimerProps {
  expiresAt: string;
  className?: string;
}

export const CountdownTimer: React.FC<CountdownTimerProps> = ({ expiresAt, className = '' }) => {
  const { t } = useTranslation();
  const [timeLeft, setTimeLeft] = useState<{
    hours: number;
    minutes: number;
    seconds: number;
    isExpired: boolean;
  }>({ hours: 0, minutes: 0, seconds: 0, isExpired: false });

  useEffect(() => {
    const calculateTimeLeft = () => {
      const expirationDate = new Date(expiresAt);
      const now = new Date();
      
      if (expirationDate <= now) {
        setTimeLeft({ hours: 0, minutes: 0, seconds: 0, isExpired: true });
        return;
      }

      const totalSeconds = differenceInSeconds(expirationDate, now);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      setTimeLeft({ hours, minutes, seconds, isExpired: false });
    };

    calculateTimeLeft();
    const interval = setInterval(calculateTimeLeft, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  if (timeLeft.isExpired) {
    return (
      <div className={`flex items-center gap-2 text-red-600 ${className}`}>
        <AlertCircle className="w-5 h-5" />
        <span className="font-semibold">{t('gallery.expired')}</span>
      </div>
    );
  }

  // Only show countdown if less than 24 hours remain
  if (timeLeft.hours >= 24) {
    return null;
  }

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <Clock className="w-5 h-5 text-orange-600 animate-pulse" />
      <div className="flex items-center gap-1 font-mono text-lg">
        <div className="bg-orange-100 text-orange-900 px-2 py-1 rounded">
          {String(timeLeft.hours).padStart(2, '0')}
        </div>
        <span className="text-orange-600">:</span>
        <div className="bg-orange-100 text-orange-900 px-2 py-1 rounded">
          {String(timeLeft.minutes).padStart(2, '0')}
        </div>
        <span className="text-orange-600">:</span>
        <div className="bg-orange-100 text-orange-900 px-2 py-1 rounded">
          {String(timeLeft.seconds).padStart(2, '0')}
        </div>
      </div>
      <span className="text-sm text-orange-600 font-medium">{t('gallery.remaining')}</span>
    </div>
  );
};