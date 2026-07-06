import React, { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePublicSettings } from '../hooks/usePublicSettings';
import { buildResourceUrl } from '../utils/url';

export const MaintenanceMode: React.FC = () => {
  const { t, i18n } = useTranslation();

  const { data: settings } = usePublicSettings({ retry: false });

  // Set language based on system settings
  useEffect(() => {
    if (settings?.default_language && settings.default_language !== i18n.language) {
      i18n.changeLanguage(settings.default_language);
    }
  }, [settings?.default_language, i18n]);

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col">
      {/* Header with branding - Always show, with PicPeak logo as fallback */}
      <div className="bg-white border-b border-neutral-200 py-4">
        <div className="container">
          <div className="flex items-center justify-center">
            <img 
              src={settings?.branding_logo_url ? 
                (settings.branding_logo_url.startsWith('http') 
                  ? settings.branding_logo_url 
                  : buildResourceUrl(settings.branding_logo_url))
                : '/picpeak-logo-transparent.png'
              } 
              alt={settings?.branding_company_name || 'PicPeak'}
              className="h-12 w-auto object-contain"
            />
            {settings?.branding_company_name && settings.branding_company_name !== 'PicPeak' && (
              <div className="ml-4 text-center">
                <h2 className="text-xl font-semibold text-neutral-800">{settings.branding_company_name}</h2>
                {settings.branding_company_tagline && (
                  <p className="text-sm text-neutral-600">{settings.branding_company_tagline}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-amber-100 rounded-full mb-6">
            <AlertTriangle className="w-10 h-10 text-amber-600" />
          </div>
          
          <h1 className="text-3xl font-bold text-neutral-900 mb-4">
            {t('maintenance.title')}
          </h1>
          
          <p className="text-lg text-neutral-600 mb-8">
            {t('maintenance.message')}
          </p>
          
          {settings?.branding_support_email && (
            <p className="text-sm text-neutral-500 mt-8">
              {t('maintenance.urgentMatters')}{' '}
              <a 
                href={`mailto:${settings.branding_support_email}`}
                className="text-primary-600 hover:text-primary-700"
              >
                {settings.branding_support_email}
              </a>
            </p>
          )}
        </div>
      </div>

      {/* Footer */}
      {settings?.branding_footer_text && (
        <footer className="py-4 border-t border-neutral-200">
          <div className="container text-center">
            <p className="text-sm text-neutral-500">
              {settings.branding_footer_text}
            </p>
          </div>
        </footer>
      )}
    </div>
  );
};
