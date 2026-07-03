import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown, Calendar, Clock } from 'lucide-react';
import { parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useTheme } from '../../contexts/ThemeContext';
import { AuthenticatedImage } from '../common';
import { HeroDivider } from './HeroDivider';
import { buildResourceUrl } from '../../utils/url';
import type { Photo } from '../../types';
import type { HeroDividerStyle } from '../../types/theme.types';

interface HeroHeaderProps {
  photos: Photo[];
  slug: string;
  eventName?: string;
  eventLogo?: string | null;
  eventDate?: string | null;
  expiresAt?: string | null;
  heroPhotoOverride?: Photo | null;
  heroLogoVisible?: boolean;
  heroLogoSize?: 'small' | 'medium' | 'large' | 'xlarge';
  heroLogoPosition?: 'top' | 'center' | 'bottom';
  dividerStyle?: HeroDividerStyle;
  allowDownloads?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  onScrollToContent?: () => void;
  // Hero image anchor position (#162) – keyword or "X% Y%" focal point
  heroImageAnchor?: string;
}

export const HeroHeader: React.FC<HeroHeaderProps> = ({
  photos,
  slug,
  eventName,
  eventLogo,
  eventDate,
  expiresAt,
  heroPhotoOverride,
  heroLogoVisible = true,
  heroLogoSize = 'medium',
  heroLogoPosition = 'top',
  dividerStyle = 'wave',
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  onScrollToContent,
  heroImageAnchor = 'center'
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { theme } = useTheme();
  const [heroPhoto, setHeroPhoto] = useState<Photo | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);

  const gallerySettings = theme.gallerySettings || {};
  const overlayOpacity = gallerySettings.heroOverlayOpacity || 0.3;

  // Helper function to get logo size classes
  const getLogoSizeClasses = (size: string): string => {
    switch (size) {
      case 'small':
        return 'h-12 sm:h-14 lg:h-16';
      case 'medium':
        return 'h-20 sm:h-24 lg:h-32';
      case 'large':
        return 'h-28 sm:h-32 lg:h-40';
      case 'xlarge':
        return 'h-36 sm:h-40 lg:h-48';
      default:
        return 'h-20 sm:h-24 lg:h-32';
    }
  };

  const handleScrollToContent = useCallback(() => {
    if (onScrollToContent) {
      onScrollToContent();
    } else {
      // Default: scroll to gallery grid section
      const gridSection = document.getElementById('gallery-grid-section');
      if (gridSection) {
        gridSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        // Fallback: scroll down by hero section height
        window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
      }
    }
  }, [onScrollToContent]);

  // If an override is provided, always use it and skip initialization logic
  useEffect(() => {
    if (heroPhotoOverride) {
      setHeroPhoto(heroPhotoOverride);
      setHasInitialized(true);
    }
  }, [heroPhotoOverride]);

  // Reset initialization when heroImageId changes
  useEffect(() => {
    if (gallerySettings.heroImageId) {
      setHasInitialized(false);
    }
  }, [gallerySettings.heroImageId]);

  // Select hero photo (admin-selected or first photo only if gallery was empty)
  useEffect(() => {
    // When an override is provided, the effect above has already set the hero.
    if (heroPhotoOverride) return;

    if (photos.length > 0) {
      const heroId = gallerySettings.heroImageId;
      // If admin has selected a specific hero image, always use it when available
      if (heroId) {
        const adminSelectedHero = photos.find(p => p.id === heroId);
        if (adminSelectedHero) {
          setHeroPhoto(adminSelectedHero);
          setHasInitialized(true);
          return;
        }
      }

      // Only auto-select first photo on initial load
      if (!hasInitialized) {
        setHeroPhoto(photos[0]);
        setHasInitialized(true);
      }
    }
  }, [photos, gallerySettings.heroImageId, hasInitialized, heroPhotoOverride]);

  if (!heroPhoto) return null;

  return (
    <div className="relative -mt-6">
      {/* Hero Section */}
      <div className="relative h-[60vh] sm:h-[70vh] lg:h-[80vh] max-h-[700px] -mx-4 sm:-mx-6 lg:-mx-8 mb-8">
        <AuthenticatedImage
          src={heroPhoto.hero_url || heroPhoto.url}
          fallbackSrc={heroPhoto.url}
          alt={heroPhoto.filename}
          className="w-full h-full object-cover"
          style={{ objectPosition: heroImageAnchor }}
          isGallery={true}
          slug={slug}
          photoId={heroPhoto.id}
          protectFromDownload={!allowDownloads || useEnhancedProtection}
          protectionLevel={protectionLevel}
          useEnhancedProtection={useEnhancedProtection}
          useCanvasRendering={useCanvasRendering || protectionLevel === 'maximum'}
        />

        {/* Overlay */}
        <div
          className="absolute inset-0 bg-black"
          style={{ opacity: overlayOpacity }}
        />

        {/* Hero Content */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center px-4">
            {/* Logo at top position */}
            {heroLogoVisible && heroLogoPosition === 'top' && (
              <div className="mb-6">
                <img
                  src={eventLogo ?
                    buildResourceUrl(eventLogo) :
                    '/picpeak-logo-transparent.png'
                  }
                  alt="Event logo"
                  className={`${getLogoSizeClasses(heroLogoSize)} mx-auto`}
                  style={{
                    filter: eventLogo
                      ? 'drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                      : 'brightness(0) invert(1) drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                  }}
                />
              </div>
            )}

            {/* Event Title */}
            {eventName && (
              <h1 className="text-3xl sm:text-4xl lg:text-5xl xl:text-6xl font-bold text-white drop-shadow-lg mb-4">
                {eventName}
              </h1>
            )}

            {/* Logo at center position (between title and dates) */}
            {heroLogoVisible && heroLogoPosition === 'center' && (
              <div className="my-6">
                <img
                  src={eventLogo ?
                    buildResourceUrl(eventLogo) :
                    '/picpeak-logo-transparent.png'
                  }
                  alt="Event logo"
                  className={`${getLogoSizeClasses(heroLogoSize)} mx-auto`}
                  style={{
                    filter: eventLogo
                      ? 'drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                      : 'brightness(0) invert(1) drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                  }}
                />
              </div>
            )}

            {/* Event Dates */}
            {(eventDate || expiresAt) && (
              <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 text-white/90">
                {eventDate && (
                  <span className="flex items-center text-lg sm:text-xl">
                    <Calendar className="w-5 h-5 sm:w-6 sm:h-6 mr-2" />
                    {format(parseISO(eventDate), 'PP')}
                  </span>
                )}
                {expiresAt && (
                  <span className="flex items-center text-lg sm:text-xl">
                    <Clock className="w-5 h-5 sm:w-6 sm:h-6 mr-2" />
                    {t('gallery.expires')} {format(parseISO(expiresAt), 'PP')}
                  </span>
                )}
              </div>
            )}

            {/* Logo at bottom position */}
            {heroLogoVisible && heroLogoPosition === 'bottom' && (
              <div className="mt-6">
                <img
                  src={eventLogo ?
                    buildResourceUrl(eventLogo) :
                    '/picpeak-logo-transparent.png'
                  }
                  alt="Event logo"
                  className={`${getLogoSizeClasses(heroLogoSize)} mx-auto`}
                  style={{
                    filter: eventLogo
                      ? 'drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                      : 'brightness(0) invert(1) drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Scroll Indicator */}
        <button
          onClick={handleScrollToContent}
          className="absolute bottom-8 left-1/2 transform -translate-x-1/2 animate-bounce cursor-pointer hover:scale-110 transition-transform focus:outline-none focus:ring-2 focus:ring-white focus:ring-opacity-50 rounded-full p-2"
          aria-label="Scroll to gallery"
        >
          <ChevronDown className="w-8 h-8 text-white drop-shadow-lg" />
        </button>

        {/* Decorative Divider */}
        <HeroDivider style={dividerStyle} />
      </div>
    </div>
  );
};

HeroHeader.displayName = 'HeroHeader';
