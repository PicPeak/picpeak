import React, { useEffect, useState } from 'react';
import { WifiOff, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';

export const OfflineIndicator: React.FC = () => {
  const { t } = useTranslation();
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showIndicator, setShowIndicator] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // Show "back online" message briefly
      setShowIndicator(true);
      setTimeout(() => setShowIndicator(false), 3000);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setShowIndicator(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Check initial state
    if (!navigator.onLine) {
      setShowIndicator(true);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!showIndicator) return null;

  return (
    <div
      className={cn(
        'fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-auto z-50',
        'transition-all duration-300 ease-in-out',
        isOnline ? 'translate-y-0' : 'translate-y-0'
      )}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          'flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg',
          isOnline
            ? 'bg-green-50 border border-green-200 text-green-900'
            : 'bg-red-50 border border-red-200 text-red-900'
        )}
      >
        {isOnline ? (
          <>
            <Wifi className="w-5 h-5" />
            <span className="text-sm font-medium">{t('offline.backOnline')}</span>
          </>
        ) : (
          <>
            <WifiOff className="w-5 h-5" />
            <span className="text-sm font-medium">{t('offline.noConnection')}</span>
          </>
        )}
      </div>
    </div>
  );
};

// Hook to monitor online status
export const useOnlineStatus = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleStatusChange = () => {
      setIsOnline(navigator.onLine);
    };

    window.addEventListener('online', handleStatusChange);
    window.addEventListener('offline', handleStatusChange);

    return () => {
      window.removeEventListener('online', handleStatusChange);
      window.removeEventListener('offline', handleStatusChange);
    };
  }, []);

  return isOnline;
};