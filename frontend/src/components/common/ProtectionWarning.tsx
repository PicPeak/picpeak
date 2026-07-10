import React from 'react';
import { Shield, AlertTriangle, X } from 'lucide-react';

interface ProtectionWarningProps {
  type: 'devtools' | 'screenshot' | 'violation' | 'general';
  message?: string;
  onClose?: () => void;
  severity?: 'low' | 'medium' | 'high';
  autoClose?: boolean;
  autoCloseDelay?: number;
}

export const ProtectionWarning: React.FC<ProtectionWarningProps> = ({
  type,
  message,
  onClose,
  severity = 'medium',
  autoClose = false,
  autoCloseDelay = 5000
}) => {
  // Auto close functionality
  React.useEffect(() => {
    if (autoClose && autoCloseDelay > 0 && onClose) {
      const timer = setTimeout(() => {
        onClose();
      }, autoCloseDelay);
      
      return () => clearTimeout(timer);
    }
  }, [autoClose, autoCloseDelay, onClose]);

  const getWarningConfig = () => {
    switch (type) {
      case 'devtools':
        return {
          icon: <AlertTriangle className="w-5 h-5" />,
          title: 'Developer Tools Detected',
          defaultMessage: 'Developer tools access has been detected. This action has been logged for security purposes.',
          bgColor: 'bg-red-500',
          textColor: 'text-white'
        };
      case 'screenshot':
        return {
          icon: <Shield className="w-5 h-5" />,
          title: 'Screenshot Attempt Detected',
          defaultMessage: 'A screenshot attempt has been detected. This gallery is protected from unauthorized copying.',
          bgColor: 'bg-orange-500',
          textColor: 'text-white'
        };
      case 'violation':
        return {
          icon: <Shield className="w-5 h-5" />,
          title: 'Protection Violation',
          defaultMessage: 'An unauthorized action has been detected and blocked.',
          bgColor: severity === 'high' ? 'bg-red-500' : severity === 'medium' ? 'bg-orange-500' : 'bg-yellow-500',
          textColor: 'text-white'
        };
      default:
        return {
          icon: <Shield className="w-5 h-5" />,
          title: 'Security Notice',
          defaultMessage: 'This content is protected. Unauthorized access attempts are monitored.',
          bgColor: 'bg-blue-500',
          textColor: 'text-white'
        };
    }
  };

  const config = getWarningConfig();

  return (
    <div className={`fixed top-4 right-4 ${config.bgColor} ${config.textColor} p-4 rounded-lg shadow-lg z-50 max-w-sm`}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          {config.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">
            {config.title}
          </div>
          <div className="text-xs mt-1 opacity-90">
            {message || config.defaultMessage}
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="flex-shrink-0 ml-2 -mr-1 -mt-1 p-1 rounded-full hover:bg-white/20 transition-colors"
            aria-label="Close warning"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      {autoClose && (
        <div 
          className="absolute bottom-0 left-0 h-0.5 bg-white/30 animate-pulse"
          style={{
            width: '100%',
            animation: `shrink ${autoCloseDelay}ms linear`
          }}
        />
      )}
      
      <style>{`
        @keyframes shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
};
