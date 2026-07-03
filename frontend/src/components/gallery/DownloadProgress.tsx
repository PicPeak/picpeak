import React from 'react';
import { Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DownloadProgressProps {
  isDownloading: boolean;
  progress?: number;
  fileName?: string;
  onCancel?: () => void;
}

export const DownloadProgress: React.FC<DownloadProgressProps> = ({
  isDownloading,
  progress = 0,
  fileName,
  onCancel,
}) => {
  const { t } = useTranslation();
  
  if (!isDownloading) return null;

  return (
    <div className="fixed bottom-4 right-4 bg-surface rounded-lg shadow-lg border border-surface p-4 min-w-[300px] z-50">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <Download className="w-5 h-5 text-accent animate-bounce" />
          <div>
            <p className="text-sm font-medium text-theme">{t('download.downloading')}</p>
            {fileName && (
              <p className="text-xs text-muted-theme truncate max-w-[200px]">{fileName}</p>
            )}
          </div>
        </div>
        {onCancel && (
          <button
            onClick={onCancel}
            className="p-1 hover:bg-black/10 rounded transition-colors"
          >
            <X className="w-4 h-4 text-muted-theme" />
          </button>
        )}
      </div>
      
      <div className="w-full bg-black/10 rounded-full h-2">
        <div
          className="bg-accent-dark h-2 rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      
      {progress > 0 && (
        <p className="text-xs text-muted-theme mt-1">{Math.round(progress)}{t('download.percentComplete')}</p>
      )}
    </div>
  );
};