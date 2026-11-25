import { useEffect, useState } from 'react';
import { cssTemplatesService } from '../services/cssTemplates.service';

/**
 * Loads a gallery's custom CSS and injects it into the document.
 * @param slug - Gallery slug
 */
export function useGalleryCustomCss(slug: string): void {
  const [customCss, setCustomCss] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;

    const loadCustomCss = async () => {
      try {
        const css = await cssTemplatesService.getGalleryCss(slug);
        setCustomCss(css);
      } catch (err) {
        console.error('Failed to load custom CSS:', err);
      }
    };

    loadCustomCss();
  }, [slug]);

  // Inject CSS into document
  useEffect(() => {
    if (!customCss) return;

    // Remove any existing custom CSS
    const existingStyle = document.getElementById('gallery-custom-css');
    if (existingStyle) {
      existingStyle.remove();
    }

    // Create and inject new style element
    const styleElement = document.createElement('style');
    styleElement.id = 'gallery-custom-css';
    styleElement.textContent = customCss;
    document.head.appendChild(styleElement);

    // Cleanup on unmount or when CSS changes
    return () => {
      const existing = document.getElementById('gallery-custom-css');
      if (existing) {
        existing.remove();
      }
    };
  }, [customCss]);
}

export default useGalleryCustomCss;
