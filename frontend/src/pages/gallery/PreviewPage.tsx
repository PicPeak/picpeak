import React, { useEffect, useState, useMemo } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { GalleryLayout, PhotoFilterBar } from '../../components/gallery';
import { Card } from '../../components/common';
import { Camera } from 'lucide-react';

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

const mockCategories = [
  { id: 1, name: 'Ceremony', slug: 'ceremony', is_global: true },
  { id: 2, name: 'Reception', slug: 'reception', is_global: true },
  { id: 3, name: 'Portraits', slug: 'portraits', is_global: true },
  { id: 4, name: 'Party', slug: 'party', is_global: true },
];

export const PreviewPage: React.FC = () => {
  const { setTheme } = useTheme();
  const [brandingSettings, setBrandingSettings] = useState<any>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'size' | 'rating'>('date');

  const mockPhotos = useMemo(() => generateMockPhotos(12), []);
  const mockEvent = {
    event_name: 'Preview Wedding Gallery',
    event_date: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  useEffect(() => {
    // Listen for theme preview messages from the branding page.
    // Only accept messages from our own origin — the branding page that
    // posts these is served from the same origin as the preview window.
    // Without this check any third-party page could window.open() the
    // preview and postMessage arbitrary `branding`/`theme` payloads.
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'THEME_PREVIEW') {
        setTheme(event.data.theme);
        setBrandingSettings(event.data.branding);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [setTheme]);

  // Filter photos
  const filteredPhotos = useMemo(() => {
    let photos = [...mockPhotos];
    
    // Apply category filter
    if (selectedCategoryId) {
      photos = photos.filter(photo => photo.category_id === selectedCategoryId);
    }
    
    // Apply search filter
    if (searchTerm) {
      photos = photos.filter(photo => 
        photo.filename.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    
    // Apply sorting
    photos.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.filename.localeCompare(b.filename);
        case 'size':
          return b.size - a.size;
        case 'rating':
          return 0;
        case 'date':
        default:
          return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
      }
    });
    
    return photos;
  }, [mockPhotos, selectedCategoryId, searchTerm, sortBy]);

  // Custom photo renderer for preview
  const PreviewPhotoGrid: React.FC<{ photos: any[] }> = ({ photos }) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {photos.map((photo) => (
        <Card key={photo.id} className="overflow-hidden group cursor-pointer">
          <div className="aspect-[4/3] bg-gradient-to-br from-neutral-200 to-neutral-300 relative">
            <div className="absolute inset-0 flex items-center justify-center">
              <Camera className="w-12 h-12 text-neutral-400" />
            </div>
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
              <p className="text-white text-xs truncate">{photo.filename}</p>
              {photo.category_name && (
                <p className="text-white/70 text-xs">{photo.category_name}</p>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );

  return (
    <GalleryLayout
      event={mockEvent}
      brandingSettings={brandingSettings}
      showLogout={false}
      showDownloadAll={false}
    >
      <div className="mt-8">
        <div className="text-center mb-6">
          <h2 className="text-xl font-semibold text-neutral-900">Theme Preview</h2>
          <p className="text-neutral-600">This is how your galleries will look with the current theme settings</p>
        </div>

        {/* Filters */}
        <PhotoFilterBar
          categories={mockCategories}
          photos={mockPhotos}
          selectedCategoryId={selectedCategoryId}
          onCategoryChange={setSelectedCategoryId}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          sortBy={sortBy}
          onSortChange={(sort) => setSortBy(sort)}
          photoCount={filteredPhotos.length}
        />

        {/* Photo Grid */}
        <div className="mt-6">
          <PreviewPhotoGrid photos={filteredPhotos} />
        </div>
      </div>
    </GalleryLayout>
  );
};
