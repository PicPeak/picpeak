import React, { useState } from 'react';
import { X, Image as ImageIcon, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card, AuthenticatedImage } from '../common';
import { AdminPhoto } from '../../services/photos.service';

interface HeroPhotoSelectorProps {
  photos: AdminPhoto[];
  currentHeroPhotoId?: number | null;
  onSelect: (photoId: number | null) => void;
  isEditing: boolean;
}

export const HeroPhotoSelector: React.FC<HeroPhotoSelectorProps> = ({
  photos,
  currentHeroPhotoId,
  onSelect,
  isEditing
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedPhotoId, setSelectedPhotoId] = useState<number | null>(currentHeroPhotoId || null);

  const currentHeroPhoto = photos.find(p => p.id === currentHeroPhotoId);

  const handleSelect = (photoId: number) => {
    setSelectedPhotoId(photoId);
    onSelect(photoId);
    setIsOpen(false);
  };

  const handleRemove = () => {
    setSelectedPhotoId(null);
    onSelect(null);
  };

  if (!isEditing) {
    return (
      <div>
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
          {t('events.heroPhoto')}
        </label>
        {currentHeroPhoto ? (
          <div className="relative w-full h-48 rounded-lg overflow-hidden bg-neutral-100">
            <AuthenticatedImage
              src={currentHeroPhoto.thumbnail_url || currentHeroPhoto.url}
              alt={currentHeroPhoto.filename}
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          <p className="text-sm text-neutral-500">{t('events.noHeroPhotoSelected')}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
        {t('events.heroPhoto')}
      </label>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
        {t('events.heroPhotoHelp')}
      </p>
      
      {currentHeroPhoto ? (
        <div className="relative w-full h-48 rounded-lg overflow-hidden bg-neutral-100 mb-2">
          <AuthenticatedImage
            src={currentHeroPhoto.thumbnail_url || currentHeroPhoto.url}
            alt={currentHeroPhoto.filename}
            className="w-full h-full object-cover"
          />
          <div className="absolute top-2 right-2 flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsOpen(true)}
              className="bg-white/90 hover:bg-white"
            >
              {t('common.change')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRemove}
              leftIcon={<X className="w-4 h-4" />}
              className="bg-white/90 hover:bg-white"
            >
              {t('common.remove')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          leftIcon={<ImageIcon className="w-4 h-4" />}
          onClick={() => setIsOpen(true)}
          className="w-full"
        >
          {t('events.selectHeroPhoto')}
        </Button>
      )}

      {/* Photo Selection Modal */}
      {isOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <Card className="max-w-4xl w-full max-h-[90vh] overflow-hidden">
            <div className="p-6 border-b border-neutral-200 dark:border-neutral-700">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('events.selectHeroPhoto')}</h2>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
              {photos.length === 0 ? (
                <p className="text-center text-neutral-500 py-8">
                  {t('events.noPhotosAvailable')}
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {photos.map((photo) => (
                    <div
                      key={photo.id}
                      onClick={() => handleSelect(photo.id)}
                      className={`relative cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
                        photo.id === selectedPhotoId
                          ? 'border-accent-dark ring-2 ring-primary-500 ring-offset-2'
                          : 'border-transparent hover:border-neutral-300'
                      }`}
                    >
                      <div className="aspect-square bg-neutral-100">
                        <AuthenticatedImage
                          src={photo.thumbnail_url || photo.url}
                          alt={photo.filename}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      {photo.id === selectedPhotoId && (
                        <div className="absolute top-2 right-2 bg-accent-dark/150 text-white rounded-full p-1">
                          <Check className="w-4 h-4" />
                        </div>
                      )}
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                        <p className="text-white text-xs truncate">{photo.filename}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className="p-6 border-t border-neutral-200 dark:border-neutral-700 flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setIsOpen(false)}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};