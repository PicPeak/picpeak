import { useEffect, useState } from 'react';
import { cssTemplatesService } from '../services/cssTemplates.service';

/**
 * Hook to load and inject custom CSS for a gallery
 * @param slug - Gallery slug
 * @returns Object with customCss content and loading state
 */
export function useGalleryCustomCss(slug: string) {
  const [customCss, setCustomCss] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setLoading(false);
      return;
    }

    const loadCustomCss = async () => {
      try {
        setLoading(true);
        setError(null);

        const css = await cssTemplatesService.getGalleryCss(slug);
        setCustomCss(css);
      } catch (err) {
        console.error('Failed to load custom CSS:', err);
        setError('Failed to load custom styles');
      } finally {
        setLoading(false);
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

  return { customCss, loading, error };
}

export default useGalleryCustomCss;
