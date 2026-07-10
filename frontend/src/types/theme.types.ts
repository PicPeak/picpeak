// Gallery Layout Types
export type GalleryLayoutType = 'grid' | 'masonry' | 'carousel' | 'timeline' | 'mosaic' | 'gallery-premium' | 'gallery-story';

// Header Style Types (decoupled from layout)
export type HeaderStyleType = 'hero' | 'standard' | 'banner' | 'minimal' | 'none';

// Hero Divider Styles
export type HeroDividerStyle = 'wave' | 'straight' | 'angle' | 'curve' | 'none';

export interface GalleryLayoutSettings {
  // Common settings
  spacing?: 'tight' | 'normal' | 'relaxed';
  photoAnimation?: 'none' | 'fade' | 'scale' | 'slide';
  photoShape?: 'square' | 'rounded' | 'circle';
  
  // Grid specific
  gridColumns?: {
    mobile: number;
    tablet: number;
    desktop: number;
  };
  
  // Masonry specific
  masonryMode?: 'columns' | 'rows' | 'flickr' | 'quilted' | 'justified'; // columns = Pinterest-style, rows = justified rows, flickr = Flickr justified-layout, quilted = mixed sizes, justified = Knuth-Plass
  masonryGutter?: number;
  masonryRowHeight?: number; // Target row height for rows mode (150-400)
  masonryLastRowBehavior?: 'justify' | 'left' | 'center'; // How to align incomplete last row

  // Justified layout specific
  justifiedRowHeight?: number;
  justifiedLastRowBehavior?: 'justify' | 'left' | 'center';
  justifiedShowHero?: boolean;
  justifiedHeroHeight?: 'small' | 'medium' | 'large';
  
  // Carousel specific
  carouselAutoplay?: boolean;
  carouselInterval?: number;
  carouselShowThumbnails?: boolean;
  
  // Timeline specific
  timelineGrouping?: 'day' | 'week' | 'month';
  timelineShowDates?: boolean;
  
  // Hero specific
  heroImageId?: number;
  heroOverlayOpacity?: number;
  
  // Mosaic specific
  mosaicPattern?: 'random' | 'structured' | 'alternating';

  // Thumbnail scale (applies to Grid, Masonry columns, Mosaic)
  thumbnailScale?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}

export interface ThemeConfig {
  // Colors — 8-token CI palette.
  // Naming kept for backward-compat with existing settings rows; semantics:
  //   backgroundColor   → page base
  //   surfaceColor      → cards / nav / alternating sections
  //   elevatedColor     → raised panels / image placeholders
  //   surfaceBorderColor→ dividers, borders, grid lines (a.k.a. "border" token)
  //   textColor         → primary text (Text 1°)
  //   mutedTextColor    → secondary text (Text 2°)
  //   accentColor       → links, icons, focus rings, hover
  //   accentDarkColor   → primary CTA fill / filled states
  //
  // primaryColor is retained as a legacy alias and migrated to accentDarkColor
  // by frontend/src/utils/themeMigration.ts. Do not surface it in new UI.
  primaryColor?: string;
  accentColor?: string;
  accentDarkColor?: string;
  backgroundColor?: string;
  surfaceColor?: string;
  elevatedColor?: string;
  surfaceBorderColor?: string;
  textColor?: string;
  mutedTextColor?: string;

  // Color Mode
  colorMode?: 'light' | 'dark' | 'auto';

  // Typography
  fontFamily?: string;
  headingFontFamily?: string;
  fontSize?: 'small' | 'normal' | 'large';

  // Styling
  borderRadius?: 'none' | 'sm' | 'md' | 'lg';
  buttonStyle?: 'solid' | 'outline' | 'ghost';
  shadowStyle?: 'none' | 'subtle' | 'normal' | 'dramatic';

  // Gallery Layout
  galleryLayout?: GalleryLayoutType;
  gallerySettings?: GalleryLayoutSettings;

  // Header Style (decoupled from layout)
  headerStyle?: HeaderStyleType;
  heroDividerStyle?: HeroDividerStyle;

  // Controls Style - sidebar (menu button) vs classic (inline filter bar)
  controlsStyle?: 'sidebar' | 'classic';

  // Legacy Header/Footer (kept for backward compatibility)
  legacyHeaderStyle?: 'minimal' | 'standard' | 'full';
  footerStyle?: 'minimal' | 'standard' | 'full';
  showEventInfo?: boolean;
  showBranding?: boolean;
  
  // Advanced
  logoUrl?: string;
  customCss?: string;
  backgroundPattern?: 'none' | 'dots' | 'grid' | 'waves';
}

export interface EventTheme {
  id?: string;
  name: string;
  description?: string;
  thumbnail?: string;
  config: ThemeConfig;
  isPreset?: boolean;
}

// Preset theme definitions
export const GALLERY_THEME_PRESETS: Record<string, EventTheme> = {
  default: {
    name: 'Classic Grid',
    description: 'Clean and organized grid layout',
    config: {
      primaryColor: '#5C8762',
      accentColor: '#22c55e',
      accentDarkColor: '#5C8762',
      backgroundColor: '#fafafa',
      surfaceColor: '#ffffff',
      elevatedColor: '#f5f5f5',
      surfaceBorderColor: '#e5e5e5',
      textColor: '#171717',
      mutedTextColor: '#737373',
      borderRadius: 'md',
      galleryLayout: 'grid',
      gallerySettings: {
        spacing: 'normal',
        photoAnimation: 'fade',
        gridColumns: { mobile: 2, tablet: 3, desktop: 4 }
      },
      headerStyle: 'standard',
      footerStyle: 'standard'
    },
    isPreset: true
  },
  
  elegantWedding: {
    name: 'Elegant Wedding',
    description: 'Sophisticated layout with hero image and timeline',
    config: {
      primaryColor: '#c9a961',
      accentColor: '#e6ddd4',
      accentDarkColor: '#c9a961',
      backgroundColor: '#fdfcfb',
      surfaceColor: '#ffffff',
      elevatedColor: '#faf6f0',
      surfaceBorderColor: '#e8e0d4',
      textColor: '#3f3f3f',
      mutedTextColor: '#7a7a7a',
      fontFamily: 'Playfair Display, serif',
      headingFontFamily: 'Playfair Display, serif',
      borderRadius: 'lg',
      shadowStyle: 'subtle',
      galleryLayout: 'grid',
      headerStyle: 'hero',
      heroDividerStyle: 'wave',
      gallerySettings: {
        spacing: 'relaxed',
        photoAnimation: 'scale',
        photoShape: 'rounded',
        heroOverlayOpacity: 0.3
      },
      legacyHeaderStyle: 'full',
      footerStyle: 'minimal'
    },
    isPreset: true
  },
  
  modernMasonry: {
    name: 'Modern Masonry',
    description: 'Pinterest-style columns or Google Photos-style rows',
    config: {
      primaryColor: '#3b82f6',
      accentColor: '#1e40af',
      accentDarkColor: '#3b82f6',
      backgroundColor: '#ffffff',
      surfaceColor: '#ffffff',
      elevatedColor: '#f8fafc',
      surfaceBorderColor: '#e2e8f0',
      textColor: '#0f172a',
      mutedTextColor: '#64748b',
      fontFamily: 'Inter, sans-serif',
      borderRadius: 'sm',
      galleryLayout: 'masonry',
      gallerySettings: {
        spacing: 'tight',
        photoAnimation: 'fade',
        masonryMode: 'columns',
        masonryGutter: 16,
        masonryRowHeight: 250,
        masonryLastRowBehavior: 'left'
      },
      headerStyle: 'minimal',
      footerStyle: 'minimal',
      shadowStyle: 'normal'
    },
    isPreset: true
  },
  
  birthdayFun: {
    name: 'Birthday Celebration',
    description: 'Vibrant carousel with playful animations',
    config: {
      primaryColor: '#ec4899',
      accentColor: '#fbbf24',
      accentDarkColor: '#ec4899',
      backgroundColor: '#fef3c7',
      surfaceColor: '#ffffff',
      elevatedColor: '#fef9e3',
      surfaceBorderColor: '#fde68a',
      textColor: '#451a03',
      mutedTextColor: '#92400e',
      fontFamily: 'Comic Neue, cursive',
      borderRadius: 'lg',
      galleryLayout: 'carousel',
      gallerySettings: {
        spacing: 'normal',
        photoAnimation: 'slide',
        carouselAutoplay: true,
        carouselInterval: 5000,
        carouselShowThumbnails: true
      },
      headerStyle: 'banner',
      footerStyle: 'standard',
      backgroundPattern: 'dots'
    },
    isPreset: true
  },

  corporateTimeline: {
    name: 'Corporate Timeline',
    description: 'Professional chronological layout',
    config: {
      primaryColor: '#1f2937',
      accentColor: '#059669',
      accentDarkColor: '#1f2937',
      backgroundColor: '#f9fafb',
      surfaceColor: '#ffffff',
      elevatedColor: '#f3f4f6',
      surfaceBorderColor: '#e5e7eb',
      textColor: '#111827',
      mutedTextColor: '#6b7280',
      fontFamily: 'IBM Plex Sans, sans-serif',
      borderRadius: 'sm',
      galleryLayout: 'timeline',
      gallerySettings: {
        spacing: 'normal',
        photoAnimation: 'none',
        timelineGrouping: 'day',
        timelineShowDates: true
      },
      headerStyle: 'banner',
      footerStyle: 'full',
      buttonStyle: 'outline'
    },
    isPreset: true
  },
  
  artisticMosaic: {
    name: 'Artistic Mosaic',
    description: 'Creative layout with varied photo sizes',
    config: {
      primaryColor: '#7c3aed',
      accentColor: '#f59e0b',
      accentDarkColor: '#7c3aed',
      backgroundColor: '#faf5ff',
      surfaceColor: '#ffffff',
      elevatedColor: '#f3e8ff',
      surfaceBorderColor: '#e9d5ff',
      textColor: '#1e1b4b',
      mutedTextColor: '#6b7280',
      fontFamily: 'Montserrat, sans-serif',
      borderRadius: 'none',
      galleryLayout: 'mosaic',
      gallerySettings: {
        spacing: 'tight',
        photoAnimation: 'scale',
        mosaicPattern: 'structured'
      },
      headerStyle: 'minimal',
      footerStyle: 'minimal',
      shadowStyle: 'dramatic'
    },
    isPreset: true
  },

  darkClassic: {
    name: 'Dark Classic',
    description: 'Dark theme with green accents',
    config: {
      primaryColor: '#5C8762',
      accentColor: '#22c55e',
      accentDarkColor: '#5C8762',
      backgroundColor: '#0f0f0f',
      textColor: '#e5e5e5',
      surfaceColor: '#1a1a1a',
      elevatedColor: '#242424',
      surfaceBorderColor: '#2e2e2e',
      mutedTextColor: '#a3a3a3',
      colorMode: 'dark',
      borderRadius: 'md',
      galleryLayout: 'grid',
      gallerySettings: {
        spacing: 'normal',
        photoAnimation: 'fade',
        gridColumns: { mobile: 2, tablet: 3, desktop: 4 }
      },
      headerStyle: 'standard',
      footerStyle: 'standard',
      shadowStyle: 'subtle'
    },
    isPreset: true
  },

  darkElegant: {
    name: 'Dark Elegant',
    description: 'Dark theme with gold accents',
    config: {
      primaryColor: '#c9a961',
      accentColor: '#e6ddd4',
      accentDarkColor: '#c9a961',
      backgroundColor: '#121212',
      textColor: '#f0ebe5',
      surfaceColor: '#1e1e1e',
      elevatedColor: '#262626',
      surfaceBorderColor: '#333333',
      mutedTextColor: '#a3a3a3',
      colorMode: 'dark',
      fontFamily: 'Playfair Display, serif',
      headingFontFamily: 'Playfair Display, serif',
      borderRadius: 'lg',
      galleryLayout: 'grid',
      headerStyle: 'hero',
      heroDividerStyle: 'wave',
      gallerySettings: {
        spacing: 'relaxed',
        photoAnimation: 'scale',
        photoShape: 'rounded',
        heroOverlayOpacity: 0.4
      },
      footerStyle: 'minimal',
      shadowStyle: 'subtle'
    },
    isPreset: true
  },

  darkModern: {
    name: 'Dark Modern',
    description: 'Dark theme with blue accents',
    config: {
      primaryColor: '#3b82f6',
      accentColor: '#1e40af',
      accentDarkColor: '#3b82f6',
      backgroundColor: '#0a0a0a',
      textColor: '#f5f5f5',
      surfaceColor: '#171717',
      elevatedColor: '#1f1f1f',
      surfaceBorderColor: '#262626',
      mutedTextColor: '#a3a3a3',
      colorMode: 'dark',
      fontFamily: 'Inter, sans-serif',
      borderRadius: 'sm',
      galleryLayout: 'masonry',
      gallerySettings: {
        spacing: 'tight',
        photoAnimation: 'fade',
        masonryMode: 'columns',
        masonryGutter: 16
      },
      headerStyle: 'minimal',
      footerStyle: 'minimal',
      shadowStyle: 'normal'
    },
    isPreset: true
  },

  galleryPremium: {
    name: 'Gallery Premium (Beta)',
    description: 'Clean light theme with elegant serif typography and masonry grid',
    config: {
      primaryColor: '#18181b',
      accentColor: '#ef4444',
      accentDarkColor: '#18181b',
      backgroundColor: '#ffffff',
      textColor: '#18181b',
      surfaceColor: '#ffffff',
      elevatedColor: '#fafafa',
      surfaceBorderColor: '#f4f4f5',
      mutedTextColor: '#71717a',
      colorMode: 'light',
      fontFamily: 'Inter, sans-serif',
      headingFontFamily: "'Playfair Display', serif",
      borderRadius: 'sm',
      galleryLayout: 'gallery-premium',
      gallerySettings: {
        spacing: 'normal',
        photoAnimation: 'fade'
      },
      headerStyle: 'none',
      footerStyle: 'minimal',
      shadowStyle: 'subtle'
    },
    isPreset: true
  },

  galleryStory: {
    name: 'Gallery Story (Beta)',
    description: 'Dark cinematic theme with gold accents and scene-based sections',
    config: {
      primaryColor: '#c9a961',
      accentColor: '#c9a961',
      accentDarkColor: '#a88c4a',
      backgroundColor: '#0d0d0d',
      textColor: '#f2f2f2',
      surfaceColor: '#1a1a1a',
      elevatedColor: '#222222',
      surfaceBorderColor: '#262626',
      mutedTextColor: '#a3a3a3',
      colorMode: 'dark',
      fontFamily: 'Inter, sans-serif',
      headingFontFamily: "'Playfair Display', serif",
      borderRadius: 'sm',
      galleryLayout: 'gallery-story',
      gallerySettings: {
        spacing: 'normal',
        photoAnimation: 'fade'
      },
      headerStyle: 'none',
      footerStyle: 'minimal',
      shadowStyle: 'subtle'
    },
    isPreset: true
  }
};