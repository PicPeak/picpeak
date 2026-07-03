import React, { useEffect, useRef } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { usePublicSettings } from '../hooks/usePublicSettings';

interface GlobalThemeProviderProps {
  children: React.ReactNode;
}

export const GlobalThemeProvider: React.FC<GlobalThemeProviderProps> = ({ children }) => {
  const { setTheme } = useTheme();
  const themeAppliedRef = useRef(false);
  const { data: settingsData } = usePublicSettings();

  // Apply global theme when settings are loaded (but not on gallery pages)
  useEffect(() => {
    // Skip if we're on a gallery page - gallery pages handle their own themes
    const isGalleryPage = window.location.pathname.includes('/gallery/');

    if (!themeAppliedRef.current && settingsData?.theme_config && !isGalleryPage) {
      themeAppliedRef.current = true;
      // Instance-wide force color mode is enforced inside ThemeContext.applyTheme.
      setTheme(settingsData.theme_config);
    }
  }, [settingsData, setTheme]);

  return <>{children}</>;
};