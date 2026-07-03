import React, { useMemo } from 'react';
import { Camera, Calendar } from 'lucide-react';
import { ThemeConfig, GalleryLayoutType, HeroDividerStyle } from '../../types/theme.types';
import { buildResourceUrl } from '../../utils/url';
import { useTranslation } from 'react-i18next';

interface GalleryPreviewBranding {
  company_name?: string;
  company_tagline?: string;
  logo_url?: string;
  logo_url_dark?: string;
  logo_display_mode?: 'logo_only' | 'text_only' | 'logo_and_text';
  logo_position?: 'left' | 'center' | 'right';
}

interface GalleryPreviewProps {
  theme: ThemeConfig;
  branding?: GalleryPreviewBranding;
  layoutType?: GalleryLayoutType;
  className?: string;
}

// Mock photo data for preview
const generateMockPhotos = (count: number) => {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    filename: `photo-${i + 1}.jpg`,
    url: '',
    thumbnail_url: '',
    type: i % 3 === 0 ? 'collage' : 'individual',
    category_id: (i % 4) + 1,
    category_name: ['Ceremony', 'Reception', 'Portraits', 'Party'][i % 4],
    category_slug: ['ceremony', 'reception', 'portraits', 'party'][i % 4],
    size: Math.floor(Math.random() * 5000000) + 1000000,
    uploaded_at: new Date().toISOString(),
  }));
};

// Preview photo component
const PreviewPhoto: React.FC<{ 
  photo: any; 
  className?: string;
  aspectRatio?: string;
}> = ({ 
  photo, 
  className = '',
  aspectRatio = 'aspect-square'
}) => (
  <div className={`relative overflow-hidden rounded-lg bg-gradient-to-br from-neutral-200 to-neutral-300 ${aspectRatio} ${className}`}>
    <div className="absolute inset-0 flex items-center justify-center">
      <Camera className="w-8 h-8 text-neutral-400" />
    </div>
    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
      <p className="text-white text-xs truncate">{photo.filename}</p>
      {photo.category_name && (
        <p className="text-white/70 text-[10px]">{photo.category_name}</p>
      )}
    </div>
    {photo.type === 'collage' && (
      <div className="absolute top-1 right-1">
        <span className="px-1.5 py-0.5 bg-black/60 text-white text-[10px] rounded">
          Collage
        </span>
      </div>
    )}
  </div>
);

export const GalleryPreview: React.FC<GalleryPreviewProps> = ({
  theme,
  branding,
  layoutType,
  className = ''
}) => {
  const { t } = useTranslation();
  const mockPhotos = useMemo(() => generateMockPhotos(12), []);
  
  // Use the provided layoutType or fallback to theme's gallery layout
  const activeLayout = layoutType || theme.galleryLayout || 'grid';

  const displayMode = branding?.logo_display_mode || 'logo_and_text';
  const showLogo = displayMode === 'logo_only' || displayMode === 'logo_and_text';
  const showText = displayMode === 'text_only' || displayMode === 'logo_and_text';
  const brandName = branding?.company_name?.trim() || 'Your Studio';
  const brandTagline = branding?.company_tagline?.trim() || '';
  // Theme-aware logo with symmetric fallback — mirror the live surfaces
  // so the preview reflects what the gallery will actually show.
  const previewLogo = theme.colorMode === 'dark'
    ? (branding?.logo_url_dark || branding?.logo_url)
    : (branding?.logo_url || branding?.logo_url_dark);
  const resolvedLogoUrl = showLogo && previewLogo
    ? (previewLogo.startsWith('http') ? previewLogo : buildResourceUrl(previewLogo))
    : null;
  const logoPosition = branding?.logo_position || 'left';
  const brandFlexClass = logoPosition === 'center'
    ? 'justify-center text-center'
    : logoPosition === 'right'
      ? 'justify-end text-right flex-row-reverse'
      : 'justify-start text-left';
  
  // Check header style
  const isHeroHeader = theme.headerStyle === 'hero';
  const isMinimalHeader = theme.headerStyle === 'minimal';
  const isNoHeader = theme.headerStyle === 'none';
  const heroDividerStyle: HeroDividerStyle = theme.heroDividerStyle || 'wave';

  // Render hero divider based on style
  const renderHeroDivider = () => {
    const bgColor = theme.backgroundColor || '#fafafa';
    switch (heroDividerStyle) {
      case 'wave':
        return (
          <svg className="w-full h-6" viewBox="0 0 1200 120" preserveAspectRatio="none">
            <path d="M0,60 C150,90 350,30 600,60 C850,90 1050,30 1200,60 L1200,120 L0,120 Z" fill={bgColor} />
          </svg>
        );
      case 'curve':
        return (
          <svg className="w-full h-6" viewBox="0 0 1200 120" preserveAspectRatio="none">
            <path d="M0,120 Q600,0 1200,120 L1200,120 L0,120 Z" fill={bgColor} />
          </svg>
        );
      case 'angle':
        return (
          <svg className="w-full h-6" viewBox="0 0 1200 120" preserveAspectRatio="none">
            <path d="M0,120 L600,40 L1200,120 L1200,120 L0,120 Z" fill={bgColor} />
          </svg>
        );
      case 'straight':
      case 'none':
      default:
        return null;
    }
  };

  const renderLayout = () => {
    const spacing = theme.gallerySettings?.spacing || 'normal';
    const gapClass = spacing === 'tight' ? 'gap-1' : spacing === 'relaxed' ? 'gap-4' : 'gap-2';
    
    switch (activeLayout) {
      case 'grid': {
        return (
          <div className={`grid grid-cols-3 md:grid-cols-4 ${gapClass}`}>
            {mockPhotos.slice(0, 8).map((photo) => (
              <PreviewPhoto key={photo.id} photo={photo} />
            ))}
          </div>
        );
      }
      
      case 'masonry':
        return (
          <div className={`columns-3 md:columns-4 ${gapClass}`}>
            {mockPhotos.slice(0, 10).map((photo, idx) => (
              <div key={photo.id} className={`break-inside-avoid mb-${spacing === 'tight' ? '1' : spacing === 'relaxed' ? '4' : '2'}`}>
                <PreviewPhoto 
                  photo={photo} 
                  aspectRatio={idx % 3 === 0 ? 'aspect-[4/5]' : idx % 3 === 1 ? 'aspect-[4/3]' : 'aspect-square'}
                />
              </div>
            ))}
          </div>
        );
      
      case 'carousel':
        return (
          <div className="relative">
            <div className="flex items-center gap-2 overflow-hidden">
              <PreviewPhoto photo={mockPhotos[0]} className="w-full max-w-md mx-auto" aspectRatio="aspect-[4/3]" />
            </div>
            <div className="flex justify-center gap-1 mt-3">
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx} className={`w-2 h-2 rounded-full ${idx === 0 ? 'bg-accent-dark' : 'bg-neutral-300'}`} />
              ))}
            </div>
          </div>
        );
      
      case 'timeline':
        return (
          <div className="space-y-6">
            {['Today', 'Yesterday'].map((date, dateIdx) => (
              <div key={date}>
                <h4 className="text-sm font-medium text-neutral-700 mb-2">{date}</h4>
                <div className={`grid grid-cols-3 ${gapClass}`}>
                  {mockPhotos.slice(dateIdx * 3, (dateIdx * 3) + 3).map((photo) => (
                    <PreviewPhoto key={photo.id} photo={photo} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      
      case 'mosaic':
        return (
          <div className={`grid grid-cols-4 grid-rows-3 ${gapClass} h-64`}>
            <PreviewPhoto photo={mockPhotos[0]} className="col-span-2 row-span-2" aspectRatio="aspect-auto h-full" />
            <PreviewPhoto photo={mockPhotos[1]} className="col-span-1 row-span-1" aspectRatio="aspect-auto h-full" />
            <PreviewPhoto photo={mockPhotos[2]} className="col-span-1 row-span-1" aspectRatio="aspect-auto h-full" />
            <PreviewPhoto photo={mockPhotos[3]} className="col-span-1 row-span-1" aspectRatio="aspect-auto h-full" />
            <PreviewPhoto photo={mockPhotos[4]} className="col-span-1 row-span-1" aspectRatio="aspect-auto h-full" />
            <PreviewPhoto photo={mockPhotos[5]} className="col-span-2 row-span-1" aspectRatio="aspect-auto h-full" />
          </div>
        );
      
      default:
        return null;
    }
  };
  
  return (
    <div
      className={`bg-white rounded-lg shadow-sm overflow-hidden ${className}`}
      style={{
        backgroundColor: theme.backgroundColor || '#ffffff',
        color: theme.textColor || '#171717',
        fontFamily: theme.fontFamily || 'Inter, sans-serif',
      }}
    >
      {/* Hero Header */}
      {isHeroHeader && (
        <div
          className="relative text-white overflow-hidden"
          style={{
            backgroundColor: theme.accentColor || theme.primaryColor || '#22c55e',
            backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'40\' height=\'40\' viewBox=\'0 0 40 40\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'%23ffffff\' fill-opacity=\'0.03\'%3E%3Cpath d=\'M0 40L40 0H20L0 20M40 40V20L20 40\'/%3E%3C/g%3E%3C/svg%3E")',
          }}
        >
          <div className="py-8 px-4 relative z-10">
            <div className="text-center max-w-md mx-auto">
              {showLogo && (
                <div className="mb-3">
                  {resolvedLogoUrl ? (
                    <img
                      src={resolvedLogoUrl}
                      alt={brandName}
                      className="h-10 w-auto object-contain mx-auto"
                      style={{ filter: 'brightness(0) invert(1) drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))' }}
                    />
                  ) : (
                    <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center mx-auto">
                      <Camera className="w-5 h-5 text-white" />
                    </div>
                  )}
                </div>
              )}
              <h1
                className="text-xl font-bold mb-2"
                style={{
                  fontFamily: theme.headingFontFamily || theme.fontFamily || 'Inter, sans-serif',
                  textShadow: '0 2px 4px rgba(0, 0, 0, 0.3)'
                }}
              >
                Sample Event
              </h1>
              <div className="flex items-center justify-center text-white/80 text-sm" style={{ textShadow: '0 1px 3px rgba(0, 0, 0, 0.3)' }}>
                <Calendar className="w-4 h-4 mr-1" />
                <span>January 15, 2026</span>
              </div>
              {/* Hero photo placeholder hint */}
              <div className="mt-3 flex items-center justify-center gap-1.5 text-white/60 text-xs">
                <Camera className="w-3 h-3" />
                <span>{t('branding.heroPlaceholderText')}</span>
              </div>
            </div>
          </div>
          <div className="absolute bottom-0 left-0 right-0">
            {renderHeroDivider()}
          </div>
        </div>
      )}

      {/* Standard Header */}
      {!isHeroHeader && !isMinimalHeader && !isNoHeader && (
        <div
          className="px-4 py-3 border-b space-y-2"
          style={{
            borderColor: theme.primaryColor ? `${theme.primaryColor}20` : '#e5e7eb',
          }}
        >
          <div className={`flex items-center gap-3 ${brandFlexClass}`}>
            {showLogo && (
              resolvedLogoUrl ? (
                <img
                  src={resolvedLogoUrl}
                  alt={brandName}
                  className="h-8 w-auto object-contain"
                />
              ) : (
                <div className="h-8 w-8 rounded-full bg-neutral-200 flex items-center justify-center">
                  <Camera className="w-4 h-4 text-neutral-500" />
                </div>
              )
            )}
            {showText && (
              <div>
                <p className="text-sm font-semibold leading-tight">{brandName}</p>
                {brandTagline && (
                  <p className="text-xs text-neutral-500 leading-tight">{brandTagline}</p>
                )}
              </div>
            )}
            {!showLogo && !showText && (
              <p className="text-sm font-semibold">{brandName}</p>
            )}
          </div>
        </div>
      )}

      {/* Minimal Header - thin bar with just event name */}
      {isMinimalHeader && (
        <div
          className="px-4 py-2 border-b"
          style={{
            borderColor: theme.primaryColor ? `${theme.primaryColor}20` : '#e5e7eb',
          }}
        >
          <p
            className="text-sm font-semibold truncate"
            style={{
              fontFamily: theme.headingFontFamily || theme.fontFamily || 'Inter, sans-serif',
            }}
          >
            Sample Event
          </p>
        </div>
      )}

      {/* None Header - no header content at all */}
      {/* (isNoHeader renders nothing here — goes straight to layout bar) */}

      {/* Layout info bar */}
      <div className="px-4 py-1 border-b text-xs text-neutral-500 flex justify-between" style={{ borderColor: theme.primaryColor ? `${theme.primaryColor}20` : '#e5e7eb' }}>
        <span>Gallery preview</span>
        <span className="capitalize">{isHeroHeader ? `Hero + ${activeLayout}` : isMinimalHeader ? `Minimal + ${activeLayout}` : isNoHeader ? `No header + ${activeLayout}` : `${activeLayout} layout`}</span>
      </div>

      {/* Preview Content */}
      <div className="p-4" style={{ maxHeight: '400px', overflowY: 'auto' }}>
        {renderLayout()}
      </div>
    </div>
  );
};

GalleryPreview.displayName = 'GalleryPreview';
