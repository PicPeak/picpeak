import React, { useState, useMemo, useEffect } from 'react';
import { differenceInDays, parseISO } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Button } from '../common';
import { GallerySkeleton } from './GallerySkeleton';
import { useGalleryAuth, useTheme } from '../../contexts';
import { useGalleryPhotos, useDownloadAllPhotos } from '../../hooks/useGallery';
import { PhotoGridWithLayouts } from './PhotoGridWithLayouts';
import { ExpirationBanner } from './ExpirationBanner';
import { CountdownTimer } from './CountdownTimer';
import { GalleryLayout } from './GalleryLayout';
import { GallerySidebar } from './GallerySidebar';
import { PhotoFilterBar } from './PhotoFilterBar';
import { UserPhotoUpload } from './UserPhotoUpload';
import { GuestNamePromptModal } from './GuestNamePromptModal';
import { GuestRecoveryModal } from './GuestRecoveryModal';
import { GuestIdentityProvider } from '../../contexts/GuestIdentityContext';
import type { FilterType } from './GalleryFilter';
import { analyticsService } from '../../services/analytics.service';
import { useDevToolsProtection } from '../../hooks/useDevToolsProtection';
import { api } from '../../config/api';
import { Upload, Menu, Eye, EyeOff, Shield } from 'lucide-react';
import { galleryService } from '../../services/gallery.service';
import { feedbackService } from '../../services/feedback.service';
import { useWatermarkSettings } from '../../hooks/useWatermarkSettings';
import { useGalleryCustomCss } from '../../hooks/useGalleryCustomCss';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import type { Photo } from '../../types';
import { GALLERY_THEME_PRESETS } from '../../types/theme.types';
import { useQueryClient } from '@tanstack/react-query';

interface GalleryViewProps {
  slug: string;
  event: {
    id: number;
    event_name: string;
    event_type: string;
    event_date: string | null;
    welcome_message?: string;
    color_theme?: string;
    expires_at: string | null;
    allow_user_uploads?: boolean;
    upload_category_id?: number | null;
    hero_photo_id?: number | null;
    allow_downloads?: boolean;
  };
}

// Convert default_photo_sort DB value to internal sortBy state
const parseDefaultPhotoSort = (defaultSort?: string): { sortBy: 'date' | 'name' | 'size' | 'rating' | 'capture_date'; sortDesc: boolean } => {
  switch (defaultSort) {
    case 'upload_date_asc':
      return { sortBy: 'date', sortDesc: false };
    case 'capture_date_desc':
      return { sortBy: 'capture_date', sortDesc: true };
    case 'capture_date_asc':
      return { sortBy: 'capture_date', sortDesc: false };
    case 'filename_asc':
      return { sortBy: 'name', sortDesc: false };
    case 'filename_desc':
      return { sortBy: 'name', sortDesc: true };
    case 'upload_date_desc':
    default:
      return { sortBy: 'date', sortDesc: true };
  }
};

export const GalleryView: React.FC<GalleryViewProps> = ({ slug, event }) => {
  const { t } = useTranslation();
  const { logout, isClient } = useGalleryAuth();
  const { setTheme, theme } = useTheme();
  const queryClient = useQueryClient();
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'size' | 'rating' | 'capture_date'>('date');
  const [sortDesc, setSortDesc] = useState(true);
  const [defaultSortApplied, setDefaultSortApplied] = useState(false);
  const [brandingSettings, setBrandingSettings] = useState<any>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedPhotos, setSelectedPhotos] = useState<Set<number>>(new Set());
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const { watermarkEnabled } = useWatermarkSettings();

  // Load and inject custom CSS for this gallery
  useGalleryCustomCss(slug);

  const [protectionLevel, setProtectionLevel] = useState<'basic' | 'standard' | 'enhanced' | 'maximum'>('standard');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'photo' | 'video'>('all');
  const [guestId, setGuestId] = useState<string>('');
  const [staticHeroPhoto, setStaticHeroPhoto] = useState<Photo | null>(null);

  const resolveMediaType = (photo: Photo) => {
    if (photo.media_type === 'video' || photo.media_type === 'photo') {
      return photo.media_type;
    }
    if (photo.mime_type && photo.mime_type.startsWith('video/')) {
      return 'video';
    }
    if ((photo as any).type === 'video') {
      return 'video';
    }
    return 'photo';
  };
  
  // Generate a unique guest ID for this session
  useEffect(() => {
    // Use existing guest ID from localStorage or generate new one
    let storedGuestId = localStorage.getItem('gallery_guest_id');
    if (!storedGuestId) {
      storedGuestId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('gallery_guest_id', storedGuestId);
    }
    setGuestId(storedGuestId);
  }, []);
  
  // Fetch photos WITHOUT filter (always get all photos, filter on frontend)
  // This ensures counts are always calculated from the full dataset
  const { data, isLoading, error, refetch } = useGalleryPhotos(slug, 'all', guestId);
  
  // Set protection level when data is available
  useEffect(() => {
    if (data?.event?.protection_level) {
      setProtectionLevel(data.event.protection_level);
    }
  }, [data?.event?.protection_level]);

  // Apply default photo sort from event settings
  useEffect(() => {
    if (!defaultSortApplied && data?.event?.default_photo_sort) {
      const { sortBy: defaultSortBy, sortDesc: defaultSortDesc } = parseDefaultPhotoSort(data.event.default_photo_sort);
      setSortBy(defaultSortBy);
      setSortDesc(defaultSortDesc);
      setDefaultSortApplied(true);
    }
  }, [data?.event?.default_photo_sort, defaultSortApplied]);

  // Get individual protection settings from event
  const disableRightClick = data?.event?.disable_right_click === true;
  const enableDevtoolsProtection = data?.event?.enable_devtools_protection === true;
  const useCanvasRendering = data?.event?.use_canvas_rendering === true;
  // #508 — surface original camera filenames in the lightbox when the
  // admin has flipped the same toggle that drives original-name downloads.
  const showOriginalFilename = data?.event?.use_original_filenames === true;

  // DevTools protection - enabled by individual setting OR legacy protection level
  const devToolsEnabled = enableDevtoolsProtection || protectionLevel === 'enhanced' || protectionLevel === 'maximum';

  useDevToolsProtection({
    enabled: devToolsEnabled,
    detectionSensitivity: protectionLevel === 'maximum' ? 'high' : 'medium',
    onDevToolsDetected: () => {
      console.warn('DevTools detected in gallery view');

      // Track analytics
      if (typeof window !== 'undefined' && (window as any).umami) {
        (window as any).umami.track('gallery_devtools_detected', {
          gallery: slug,
          protectionLevel,
          eventId: data?.event?.id
        });
      }

      // For maximum protection, redirect away from gallery
      if (protectionLevel === 'maximum') {
        setTimeout(() => {
          window.location.href = '/';
        }, 100);
      }
    },
    redirectOnDetection: protectionLevel === 'maximum',
    redirectUrl: '/'
  });

  // Right-click blocking - separate from DevTools protection
  useEffect(() => {
    if (!disableRightClick) return;

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [disableRightClick]);
  
  // Data updates are handled by React Query
  const downloadAllMutation = useDownloadAllPhotos();

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const { data: settingsData } = usePublicSettings();

  // Fetch feedback settings
  const { data: feedbackSettings } = useQuery({
    queryKey: ['gallery-feedback-settings', event.id],
    queryFn: async () => {
      try {
        // Use public endpoint to get feedback settings
        const response = await api.get(`/gallery/${slug}/feedback-settings`);
        return response.data;
      } catch (error) {
        console.error('Error fetching feedback settings:', error);
        // If endpoint doesn't exist or returns error, default to disabled
        return { feedback_enabled: false };
      }
    },
    enabled: !!event.id,
  });

  // Update feedbackEnabled when settings change
  useEffect(() => {
    if (feedbackSettings) {
      setFeedbackEnabled(feedbackSettings.feedback_enabled || false);
    }
  }, [feedbackSettings]);

  // In guest identity mode both the "Liked / Favorited / Rated /
  // Commented" filters AND the matching chip-count labels need to scope
  // to the *current guest's* interactions, not the global aggregates on
  // each photo row (#538 bug 1). Pull the current guest's feedback via
  // /my-feedback (already keyed by x-guest-token in the api interceptor)
  // and build per-type photo-id sets so both consumers below can do
  // O(1) lookups.
  //
  // Always-on in guest mode (not gated on the active filter) because
  // the chip counts render whether or not a feedback filter is selected
  // — gating on filterType would leave "Liked (0)" stale until the user
  // clicks the chip, which is the same UX cliff bug 1 was reporting.
  const isGuestIdentityMode = feedbackSettings?.identity_mode === 'guest';
  const { data: myFeedbackRows } = useQuery<Array<{
    photo_id: number;
    feedback_type: 'like' | 'favorite' | 'rating' | 'comment';
  }>>({
    queryKey: ['my-feedback', slug],
    queryFn: () => feedbackService.getMyFeedback(slug),
    enabled: isGuestIdentityMode && !!slug,
    staleTime: 30 * 1000,
  });

  const myFeedbackPhotoIds = useMemo(() => {
    const sets = {
      liked: new Set<number>(),
      favorited: new Set<number>(),
      rated: new Set<number>(),
      commented: new Set<number>(),
    };
    if (!myFeedbackRows) return sets;
    for (const row of myFeedbackRows) {
      if (row.feedback_type === 'like') sets.liked.add(row.photo_id);
      else if (row.feedback_type === 'favorite') sets.favorited.add(row.photo_id);
      else if (row.feedback_type === 'rating') sets.rated.add(row.photo_id);
      else if (row.feedback_type === 'comment') sets.commented.add(row.photo_id);
    }
    return sets;
  }, [myFeedbackRows]);

  // Apply branding settings
  useEffect(() => {
    if (settingsData) {
      setBrandingSettings({
        company_name: settingsData.branding_company_name || '',
        company_tagline: settingsData.branding_company_tagline || '',
        support_email: settingsData.branding_support_email || '',
        footer_text: settingsData.branding_footer_text || '',
        watermark_enabled: settingsData.branding_watermark_enabled || false,
        logo_url: settingsData.branding_logo_url || null,
        logo_url_dark: settingsData.branding_logo_url_dark || null,
        logo_size: settingsData.branding_logo_size || 'medium',
        logo_max_height: settingsData.branding_logo_max_height || 48,
        logo_position: settingsData.branding_logo_position || 'left',
        logo_display_header: settingsData.branding_logo_display_header !== false,
        logo_display_hero: settingsData.branding_logo_display_hero !== false,
        logo_display_mode: settingsData.branding_logo_display_mode || 'logo_and_text',
        hide_powered_by: settingsData.branding_hide_powered_by === true,
        // Footer overhaul (#441 + #440). All five socials are optional;
        // empty strings → that icon is hidden. promo_markdown is the
        // global default; per-event override happens in GalleryLayout.
        facebook_url: settingsData.branding_facebook_url || '',
        instagram_url: settingsData.branding_instagram_url || '',
        whatsapp_url: settingsData.branding_whatsapp_url || '',
        twitter_url: settingsData.branding_twitter_url || '',
        youtube_url: settingsData.branding_youtube_url || '',
        promo_markdown: settingsData.branding_promo_markdown || '',
        promo_position: settingsData.branding_promo_position === 'below_footer' ? 'below_footer' : 'above_footer',
        // Promo alignment (#482). Defaults to 'center' to match the
        // gallery footer; see GalleryLayout.
        promo_alignment: ['left', 'center', 'right'].includes(settingsData.branding_promo_alignment)
          ? settingsData.branding_promo_alignment
          : 'center',
      });
    }
  }, [settingsData]);

  const availableMediaTypes = useMemo(() => {
    const types = new Set<'photo' | 'video'>();
    (data?.photos || []).forEach((photo) => {
      const mediaType = resolveMediaType(photo);
      if (mediaType === 'photo' || mediaType === 'video') {
        types.add(mediaType);
      }
    });
    return types;
  }, [data?.photos]);

  const showMediaFilter = availableMediaTypes.has('photo') && availableMediaTypes.has('video');

  useEffect(() => {
    if (!showMediaFilter && mediaFilter !== 'all') {
      setMediaFilter('all');
    }
  }, [showMediaFilter, mediaFilter]);

  // Determine the default hero photo from the initial (unfiltered) load
  const [defaultHeroPhoto, setDefaultHeroPhoto] = useState<Photo | null>(null);

  useEffect(() => {
    if (!defaultHeroPhoto && data?.photos && filterType === 'all') {
      let hero: Photo | null = null;
      const heroId = data?.event?.hero_photo_id || null;
      if (heroId) {
        hero = data.photos.find(p => p.id === heroId) || null;
      }
      if (!hero && data.photos.length > 0) {
        const firstPhoto = data.photos.find(p => resolveMediaType(p) === 'photo');
        hero = firstPhoto || data.photos[0];
      }
      if (hero) {
        setDefaultHeroPhoto(hero);
        setStaticHeroPhoto(hero);
      }
    }
  }, [data?.photos, data?.event?.hero_photo_id, filterType, defaultHeroPhoto]);

  // Switch hero photo when a category with its own hero image is selected
  useEffect(() => {
    if (!data?.photos || !defaultHeroPhoto) return;

    if (selectedCategoryId) {
      const category = (data.categories || []).find(c => c.id === selectedCategoryId);
      if (category?.hero_photo_id) {
        const categoryHero = data.photos.find(p => p.id === category.hero_photo_id);
        if (categoryHero) {
          setStaticHeroPhoto(categoryHero);
          return;
        }
      }
    }
    // No category selected or category has no hero — revert to default
    setStaticHeroPhoto(defaultHeroPhoto);
  }, [selectedCategoryId, data?.categories, data?.photos, defaultHeroPhoto]);

  // Apply theme when settings are loaded
  useEffect(() => {
    if (settingsData && data?.event) {
      let themeToApply = null;
      const fullEvent = data.event; // Use the full event data from API

      if (fullEvent.color_theme) {
        try {
          // Check if it's a valid JSON string
          if (fullEvent.color_theme.startsWith('{')) {
            const eventTheme = JSON.parse(fullEvent.color_theme);
            themeToApply = eventTheme;
          } else {
            // Handle legacy theme names - check if it's a preset
            const preset = GALLERY_THEME_PRESETS[fullEvent.color_theme];
            if (preset) {
              themeToApply = preset.config;
            } else {
              // Unknown theme name, fall back to global theme
              if (settingsData.theme_config) {
                themeToApply = settingsData.theme_config;
              }
            }
          }
        } catch {
          // Invalid theme format - use default
          // Fall back to global theme
          if (settingsData.theme_config) {
            themeToApply = settingsData.theme_config;
          }
        }
      } else if (settingsData.theme_config) {
        // No event theme, use global theme
        themeToApply = settingsData.theme_config;
      }

      // Apply theme with a small delay to ensure it overrides any global theme.
      // Instance-wide force color mode is enforced inside ThemeContext.applyTheme,
      // so callers don't have to wrap the theme themselves.
      if (themeToApply) {
        // Use setTimeout to ensure this runs after any global theme application
        const timer = setTimeout(() => {
          // If there's a hero photo, add it to gallery settings
          if (fullEvent.hero_photo_id && themeToApply.gallerySettings) {
            themeToApply.gallerySettings.heroImageId = fullEvent.hero_photo_id;
            // Apply hero photo ID to existing gallery settings
          } else if (fullEvent.hero_photo_id) {
            themeToApply.gallerySettings = { heroImageId: fullEvent.hero_photo_id };
            // Create gallery settings with hero photo ID
          }
          setTheme(themeToApply);
        }, 0);

        return () => clearTimeout(timer);
      }
    }
  }, [settingsData, data, setTheme]); // Use data instead of event prop

  // Client visibility toggle handler (#172)
  const handleToggleVisibility = async (photoId: number, currentVisibility: string) => {
    const newVisibility = currentVisibility === 'hidden' ? 'visible' : 'hidden';
    try {
      await galleryService.togglePhotoVisibility(slug, photoId, newVisibility);
      queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
    } catch (error) {
      console.error('Failed to toggle visibility:', error);
    }
  };

  const handleBulkVisibility = async (visibility: 'visible' | 'hidden') => {
    if (selectedPhotos.size === 0) return;
    try {
      await galleryService.bulkToggleVisibility(slug, Array.from(selectedPhotos), visibility);
      setSelectedPhotos(new Set());
      setIsSelectionMode(false);
      queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
    } catch (error) {
      console.error('Failed to bulk toggle visibility:', error);
    }
  };

  // Client visibility stats
  const visibleCount = useMemo(() => {
    if (!isClient || !data?.photos) return 0;
    return data.photos.filter(p => p.visibility !== 'hidden').length;
  }, [isClient, data?.photos]);

  const totalCount = data?.photos?.length || 0;

  // Calculate days until expiration (null means never expires)
  const daysUntilExpiration = event.expires_at
    ? differenceInDays(parseISO(event.expires_at), new Date())
    : null;
  const showUrgentWarning = daysUntilExpiration !== null && daysUntilExpiration <= 7;
  const isExpired = daysUntilExpiration !== null && daysUntilExpiration < 0;

  // Filter and sort photos
  const filteredPhotos = useMemo(() => {
    if (!data?.photos) return [];
    
    let photos = [...data.photos];

    if (mediaFilter === 'photo') {
      photos = photos.filter(photo => resolveMediaType(photo) !== 'video');
    } else if (mediaFilter === 'video') {
      photos = photos.filter(photo => resolveMediaType(photo) === 'video');
    }
    
    // Apply category filter
    if (selectedCategoryId) {
      photos = photos.filter(photo => photo.category_id === selectedCategoryId);
    }
    
    // Apply search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      photos = photos.filter(photo => 
        photo.filename.toLowerCase().includes(term)
      );
    }
    
    // Apply feedback filter. In guest identity mode the filter has to
    // scope to the *current guest's* interactions (#538 bug 1) — the
    // aggregate counts on each photo row are global across all guests,
    // which gave an empty grid when the guest had liked photos that
    // nobody else had touched. Falls back to the aggregate-count check
    // in simple/non-guest mode where there's no per-person identity to
    // scope by.
    switch (filterType) {
      case 'liked':
        photos = isGuestIdentityMode
          ? photos.filter(photo => myFeedbackPhotoIds.liked.has(photo.id))
          : photos.filter(photo => (photo.like_count || 0) > 0);
        break;
      case 'favorited':
        photos = isGuestIdentityMode
          ? photos.filter(photo => myFeedbackPhotoIds.favorited.has(photo.id))
          : photos.filter(photo => (photo.favorite_count || 0) > 0);
        break;
      case 'rated':
        photos = isGuestIdentityMode
          ? photos.filter(photo => myFeedbackPhotoIds.rated.has(photo.id))
          : photos.filter(photo => (photo.average_rating || 0) > 0 || (photo.total_ratings || 0) > 0);
        break;
      case 'commented':
        photos = isGuestIdentityMode
          ? photos.filter(photo => myFeedbackPhotoIds.commented.has(photo.id))
          : photos.filter(photo => (photo.comment_count || 0) > 0);
        break;
      default:
        break;
    }
    
    // Apply sorting
    // Each comparator defaults to its natural order (desc for dates/size/rating, asc for name).
    // The flip multiplier reverses that when sortDesc differs from the natural order.
    const flip = sortDesc ? 1 : -1;
    photos.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          // Natural order is ascending (A-Z); flip when sortDesc=true
          return (sortDesc ? -1 : 1) * a.filename.localeCompare(b.filename);
        case 'size':
          return flip * (b.size - a.size);
        case 'rating': {
          const ratingA = a.average_rating || 0;
          const ratingB = b.average_rating || 0;
          if (ratingA !== ratingB) {
            return flip * (ratingB - ratingA);
          }
          return flip * ((b.comment_count || 0) - (a.comment_count || 0));
        }
        case 'capture_date': {
          const captureDateA = a.captured_at || a.uploaded_at;
          const captureDateB = b.captured_at || b.uploaded_at;
          return flip * (new Date(captureDateB).getTime() - new Date(captureDateA).getTime());
        }
        case 'date':
        default:
          return flip * (new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());
      }
    });
    
    // Transform full-size URLs for watermarks if enabled
    // Note: Thumbnails are watermarked server-side at the thumbnail endpoint
    if (watermarkEnabled) {
      photos = photos.map(photo => ({
        ...photo,
        url: `/api/gallery/${slug}/photo/${photo.id}`
      }));
    }
    
    return photos;
  }, [data?.photos, selectedCategoryId, searchTerm, sortBy, sortDesc, watermarkEnabled, slug, filterType, mediaFilter, isGuestIdentityMode, myFeedbackPhotoIds]);

  // Counts shown in the filter chips ("Liked (N)", etc.). In guest
  // mode these need to mirror the per-guest filter behaviour above —
  // otherwise the chip says "Liked (5)" globally but clicking it
  // surfaces 3 (the guest's own subset), which is the same confusing
  // mismatch #538 reported for the filter itself. Fall back to the
  // global aggregate in simple mode where no per-person identity
  // exists.
  const likeCount = useMemo(() => {
    if (isGuestIdentityMode) return myFeedbackPhotoIds.liked.size;
    return data?.photos?.filter(p => (p.like_count ?? 0) > 0).length || 0;
  }, [data?.photos, isGuestIdentityMode, myFeedbackPhotoIds]);

  const favoriteCount = useMemo(() => {
    if (isGuestIdentityMode) return myFeedbackPhotoIds.favorited.size;
    return data?.photos?.filter(p => (p.favorite_count ?? 0) > 0).length || 0;
  }, [data?.photos, isGuestIdentityMode, myFeedbackPhotoIds]);

  const ratedCount = useMemo(() => {
    if (isGuestIdentityMode) return myFeedbackPhotoIds.rated.size;
    return data?.photos?.filter(p => (p.total_ratings || 0) > 0 || (p.average_rating || 0) > 0).length || 0;
  }, [data?.photos, isGuestIdentityMode, myFeedbackPhotoIds]);

  // Check if downloads are allowed (both event setting and not expired)
  const allowDownloads = !isExpired && (data?.event?.allow_downloads === true);

  const handleDownloadAll = () => {
    // Prevent downloads if gallery is expired or downloads disabled
    if (!allowDownloads) {
      return;
    }
    
    downloadAllMutation.mutate({ slug, zipReady: data?.event?.download_zip_ready });
    
    // Track download all action
    analyticsService.trackGalleryEvent('bulk_download', {
      gallery: slug,
      photo_count: data?.photos.length || 0,
      is_download_all: true
    });
  };

  const handleDownloadSelected = async () => {
    if (selectedPhotos.size === 0) return;
    
    // Prevent downloads if gallery is expired or downloads disabled
    if (!allowDownloads) {
      return;
    }
    
    const selectedPhotosList = filteredPhotos.filter(p => selectedPhotos.has(p.id));
    
    // Track bulk download
    analyticsService.trackGalleryEvent('bulk_download', {
      gallery: slug,
      photo_count: selectedPhotos.size
    });
    
    // Download each selected photo
    for (const photo of selectedPhotosList) {
      await galleryService.downloadPhoto(slug, photo.id, photo.filename);
    }
    
    // Clear selection after download
    setSelectedPhotos(new Set());
    setIsSelectionMode(false);
  };

  // Calculate photo counts per category
  const photoCounts = useMemo(() => {
    if (!data?.photos) return {};
    const counts: Record<number | string, number> = {};
    data.photos
      .filter(photo => {
        if (mediaFilter === 'photo') return resolveMediaType(photo) !== 'video';
        if (mediaFilter === 'video') return resolveMediaType(photo) === 'video';
        return true;
      })
      .forEach(photo => {
      if (photo.category_id) {
        counts[photo.category_id] = (counts[photo.category_id] || 0) + 1;
      }
    });
    return counts;
  }, [data?.photos, mediaFilter]);

  // Track search usage with debouncing
  useEffect(() => {
    if (searchTerm.length > 0) {
      const timer = setTimeout(() => {
        analyticsService.trackSearch(searchTerm, filteredPhotos.length, 'gallery');
      }, 1000); // Debounce for 1 second

      return () => clearTimeout(timer);
    }
  }, [searchTerm, filteredPhotos.length]);

  // Track expiration warning views
  useEffect(() => {
    if (showUrgentWarning && daysUntilExpiration > 0) {
      analyticsService.trackExpirationWarning(slug, daysUntilExpiration);
    }
  }, [showUrgentWarning, daysUntilExpiration, slug]);

  if (isLoading) {
    return <GallerySkeleton />;
  }

  if (error || !data) {
    // Check if it's an authentication error (401)
    const is401Error = (error as any)?.response?.status === 401;
    
    if (is401Error) {
      // Authentication failed - logout and let the parent component handle re-authentication
      logout();
      return null;
    }
    
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-muted-theme">{t('gallery.failedToLoad')}</p>
          <Button onClick={() => refetch()} className="mt-4">
            {t('gallery.tryAgain')}
          </Button>
        </div>
      </div>
    );
  }

  // Determine controls style (sidebar vs classic inline filter bar).
  // Decoupled from layout — only an explicit controlsStyle === 'sidebar' on
  // the theme renders the sidebar. Default (unset or 'classic') is the inline
  // filter bar for every layout, so the gallery header/filters look identical
  // regardless of whether the photos render as grid, masonry, carousel, etc.
  const headerStyle = data?.event?.header_style || theme.headerStyle || 'standard';
  const isHeroHeader = headerStyle === 'hero';
  const showSidebar = theme.controlsStyle === 'sidebar';
  const filterBarShown = !showSidebar
    && settingsData?.gallery_show_filter_bar !== false
    && (data?.photos?.length ?? 0) > 0;

  // Full-page layouts (gallery-premium, gallery-story) have their own integrated UI
  // Skip all wrapper elements (header, footer, sidebar, filters) for these layouts
  const isFullPageLayout = theme.galleryLayout === 'gallery-premium' || theme.galleryLayout === 'gallery-story';

  // For full-page layouts, render just the PhotoGridWithLayouts without any wrappers
  if (isFullPageLayout) {
    return (
      <>
        <PhotoGridWithLayouts
          photos={filteredPhotos}
          slug={slug}
          categoryId={selectedCategoryId}
          onFeedbackChange={() => refetch()}
          heroPhotoOverride={staticHeroPhoto}
          feedbackEnabled={feedbackEnabled}
          feedbackOptions={{
            allowLikes: !!feedbackSettings?.allow_likes,
            allowFavorites: !!feedbackSettings?.allow_favorites,
            allowRatings: !!feedbackSettings?.allow_ratings,
            allowComments: !!feedbackSettings?.allow_comments,
            requireNameEmail: !!feedbackSettings?.require_name_email,
          }}
          isSelectionMode={isSelectionMode}
          selectedPhotos={selectedPhotos}
          onSelectionChange={setSelectedPhotos}
          onToggleSelectionMode={() => setIsSelectionMode(!isSelectionMode)}
          showSelectionControls={false}
          eventName={event.event_name}
          eventLogo={data?.event?.hero_logo_url || brandingSettings?.logo_url}
          eventDate={event.event_date}
          expiresAt={event.expires_at}
          allowDownloads={allowDownloads}
          protectionLevel={protectionLevel}
          useEnhancedProtection={protectionLevel !== 'basic'}
          disableRightClick={disableRightClick}
          enableDevtoolsProtection={enableDevtoolsProtection}
          useCanvasRendering={useCanvasRendering}
          heroLogoVisible={data?.event?.hero_logo_visible !== false}
          heroLogoSize={data?.event?.hero_logo_size || 'medium'}
          heroLogoPosition={data?.event?.hero_logo_position || 'top'}
          headerStyle={data?.event?.header_style || theme.headerStyle}
          heroDividerStyle={data?.event?.hero_divider_style || theme.heroDividerStyle || 'wave'}
          heroImageAnchor={data?.event?.hero_image_anchor || 'center'}
          welcomeMessage={event.welcome_message}
          onLogout={logout}
          showOriginalFilename={showOriginalFilename}
        />

        {/* Upload Modal for full-page layouts */}
        {showUploadModal && (data?.event?.allow_user_uploads || event?.allow_user_uploads) && (
          <UserPhotoUpload
            eventId={data?.event?.id || event?.id}
            categoryId={data?.event?.upload_category_id || event?.upload_category_id}
            onUploadComplete={() => {
              setShowUploadModal(false);
              window.location.reload();
            }}
            onClose={() => setShowUploadModal(false)}
          />
        )}
      </>
    );
  }

  const identityMode: 'simple' | 'guest' =
    feedbackSettings?.identity_mode === 'guest' ? 'guest' : 'simple';

  return (
    <GuestIdentityProvider slug={slug} identityMode={identityMode}>
    <>
      <GuestNamePromptModal requireEmail={!!feedbackSettings?.require_name_email} />
      <GuestRecoveryModal />
      {/* Sidebar for non-grid layouts */}
      {showSidebar ? (
        <GallerySidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(!sidebarOpen)}
          categories={(data?.categories || []).filter(cat => photoCounts[cat.id] > 0)}
          selectedCategoryId={selectedCategoryId}
          onCategoryChange={setSelectedCategoryId}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          sortBy={sortBy}
          onSortChange={setSortBy}
          isSelectionMode={isSelectionMode}
          onToggleSelectionMode={() => setIsSelectionMode(!isSelectionMode)}
          selectedCount={selectedPhotos.size}
          onDownloadAll={handleDownloadAll}
          onDownloadSelected={handleDownloadSelected}
          isDownloading={downloadAllMutation.isPending}
          allowDownloads={allowDownloads}
          photoCounts={photoCounts}
          totalPhotos={data?.photos.length || 0}
          isMobile={isMobile}
          galleryLayout={theme.galleryLayout}
          allowUploads={data?.event?.allow_user_uploads || event?.allow_user_uploads || false}
          onUploadClick={() => setShowUploadModal(true)}
          feedbackEnabled={feedbackEnabled}
          filterType={filterType}
          onFilterChange={setFilterType}
          mediaFilter={mediaFilter}
          onMediaFilterChange={setMediaFilter}
          showMediaFilter={showMediaFilter}
          likeCount={likeCount}
          favoriteCount={favoriteCount}
          ratedCount={ratedCount}
        />
      ) : null}

      <GalleryLayout
        event={{
          ...event,
          // Per-event promo override (#440). Sourced from the gallery
          // /info response so the layout can decide between inherit /
          // custom / off without a second fetch.
          promo_mode: (data?.event as { promo_mode?: 'inherit' | 'custom' | 'off' })?.promo_mode,
          promo_markdown: (data?.event as { promo_markdown?: string | null })?.promo_markdown,
        }}
        brandingSettings={brandingSettings}
        headerStyle={data?.event?.header_style || theme.headerStyle}
        showLogout={true}
        onLogout={logout}
        // Old Download All header button is replaced by the new
        // showHeaderDownload below — accent-coloured, always visible when
        // downloads are allowed, sits right before Logout (#386).
        showDownloadAll={false}
        onDownloadAll={handleDownloadAll}
        isDownloading={downloadAllMutation.isPending}
        menuButton={
          // Menu icon is shown when the event theme uses the sidebar
          // controls style. The button is icon-only — the redundant
          // "Menu" text label was dropped (#386). The wrapper aligns the
          // icon to the very left of the header so the logo lines up
          // with the leftmost gallery image.
          showSidebar ? (
            <Button
              variant="ghost"
              size="sm"
              className="gallery-btn p-2"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label={t('gallery.toggleMenu')}
            >
              <Menu className="w-5 h-5" />
            </Button>
          ) : undefined
        }
        showHeaderDownload={allowDownloads}
        onHeaderDownload={handleDownloadAll}
        headerExtra={(() => {
          const items = [];
          
          if (daysUntilExpiration !== null && daysUntilExpiration <= 1 && daysUntilExpiration > 0 && event.expires_at) {
            items.push(
              <CountdownTimer key="countdown" expiresAt={event.expires_at} className="mr-2" />
            );
          }
          
          // Upload button - always show when uploads are allowed (regardless of layout/theme loading state)
          const allowUploads = data?.event?.allow_user_uploads || event?.allow_user_uploads;
          if (allowUploads) {
            items.push(
              <Button
                key="upload-button"
                variant="outline"
                size="sm"
                leftIcon={<Upload className="w-4 h-4" />}
                onClick={() => setShowUploadModal(true)}
                className={!showSidebar ? 'flex-1 sm:flex-initial' : ''}
              >
                <span className="hidden sm:inline">{t('upload.uploadPhotos')}</span>
                <span className="sm:hidden">{t('common.upload')}</span>
              </Button>
            );
          }
          
          return items.length > 0 ? <>{items}</> : null;
        })()}
      >
        {/* Expiration Banner */}
        {showUrgentWarning && event.expires_at && (
          <ExpirationBanner daysRemaining={daysUntilExpiration} expiresAt={event.expires_at} />
        )}

        {/* Client Access Banner (#172) */}
        {isClient && (
          <div className="mt-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  {t('clientAccess.banner')}
                </span>
                <span className="text-xs text-amber-600 dark:text-amber-400 ml-2">
                  {t('clientAccess.visibleCount', { visible: visibleCount, total: totalCount })}
                </span>
              </div>
              {isSelectionMode && selectedPhotos.size > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<EyeOff className="w-4 h-4" />}
                    onClick={() => handleBulkVisibility('hidden')}
                  >
                    {t('clientAccess.hideSelected')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<Eye className="w-4 h-4" />}
                    onClick={() => handleBulkVisibility('visible')}
                  >
                    {t('clientAccess.showSelected')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Search and Filters - Only for grid layout, when admin enables the
            filter bar globally, and when the gallery actually has photos
            (avoids the empty "Search photos by filename" row in the screenshot
            from discussion #317). */}
        {filterBarShown ? (
          <div className="mt-6">
            <PhotoFilterBar
              categories={data.categories}
              photos={data.photos}
              selectedCategoryId={selectedCategoryId}
              onCategoryChange={setSelectedCategoryId}
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
            sortBy={sortBy}
            onSortChange={setSortBy}
            photoCount={filteredPhotos.length}
            // Feedback filter props
            feedbackEnabled={feedbackEnabled}
            currentFilter={filterType}
            onFilterChange={setFilterType}
            mediaFilter={mediaFilter}
            onMediaFilterChange={setMediaFilter}
            showMediaFilter={showMediaFilter}
          />
        </div>
      ) : null}

        {/* Photo Grid — when the hero header sits directly under the filter
            bar, double the wrapper margin (mt-12) so the hero's decorative
            `-mt-6` bleed leaves a visible gap instead of gluing the filter
            bar to the hero image (issue #624). */}
        <div className={filterBarShown && isHeroHeader ? "mt-12" : "mt-6"}>
          <PhotoGridWithLayouts 
            photos={filteredPhotos} 
            slug={slug} 
            categoryId={selectedCategoryId}
            onFeedbackChange={() => refetch()}
            heroPhotoOverride={staticHeroPhoto}
            feedbackEnabled={feedbackEnabled}
            feedbackOptions={{
              allowLikes: !!feedbackSettings?.allow_likes,
              allowFavorites: !!feedbackSettings?.allow_favorites,
              allowRatings: !!feedbackSettings?.allow_ratings,
              allowComments: !!feedbackSettings?.allow_comments,
              requireNameEmail: !!feedbackSettings?.require_name_email,
            }}
            isSelectionMode={isSelectionMode}
            selectedPhotos={selectedPhotos}
            onSelectionChange={setSelectedPhotos}
            onToggleSelectionMode={() => setIsSelectionMode(!isSelectionMode)}
            showSelectionControls={!showSidebar}
            eventName={event.event_name}
            eventLogo={data?.event?.hero_logo_url || brandingSettings?.logo_url}
            eventDate={event.event_date}
            expiresAt={event.expires_at}
            allowDownloads={allowDownloads}
            protectionLevel={protectionLevel}
            useEnhancedProtection={protectionLevel !== 'basic'}
            disableRightClick={disableRightClick}
            enableDevtoolsProtection={enableDevtoolsProtection}
            useCanvasRendering={useCanvasRendering}
            heroLogoVisible={data?.event?.hero_logo_visible !== false}
            heroLogoSize={data?.event?.hero_logo_size || 'medium'}
            heroLogoPosition={data?.event?.hero_logo_position || 'top'}
            headerStyle={data?.event?.header_style || theme.headerStyle}
            heroDividerStyle={data?.event?.hero_divider_style || theme.heroDividerStyle || 'wave'}
            heroImageAnchor={data?.event?.hero_image_anchor || 'center'}
            welcomeMessage={event.welcome_message}
            isClient={isClient}
            onToggleVisibility={isClient ? handleToggleVisibility : undefined}
            showOriginalFilename={showOriginalFilename}
          />
        </div>

        {/* Upload Modal */}
        {showUploadModal && (data?.event?.allow_user_uploads || event?.allow_user_uploads) && (
          <UserPhotoUpload
            eventId={data?.event?.id || event?.id}
            categoryId={data?.event?.upload_category_id || event?.upload_category_id}
            onUploadComplete={() => {
              setShowUploadModal(false);
              // Refetch photos after upload
              window.location.reload(); // Simple reload for now
            }}
            onClose={() => setShowUploadModal(false)}
          />
        )}
      </GalleryLayout>
    </>
    </GuestIdentityProvider>
  );
};
