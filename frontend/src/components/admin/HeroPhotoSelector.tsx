import React, { useState } from 'react';
import { X, Image as ImageIcon, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, AuthenticatedImage, Modal } from '../common';
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
        <label className="block text-sm font-medium text-body mb-1">
          {t('events.heroPhoto')}
        </label>
        {currentHeroPhoto ? (
          <div className="relative w-full h-48 rounded-lg overflow-hidden bg-inset">
            <AuthenticatedImage
              src={currentHeroPhoto.thumbnail_url || currentHeroPhoto.url}
              alt={currentHeroPhoto.filename}
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          <p className="text-sm text-muted">{t('events.noHeroPhotoSelected')}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm font-medium text-body mb-1">
        {t('events.heroPhoto')}
      </label>
      <p className="text-xs text-muted mb-2">
        {t('events.heroPhotoHelp')}
      </p>
      
      {currentHeroPhoto ? (
        <div className="relative w-full h-48 rounded-lg overflow-hidden bg-inset mb-2">
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
              className="bg-white/90 hover:bg-panel"
            >
              {t('common.change')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRemove}
              leftIcon={<X className="w-4 h-4" />}
              className="bg-white/90 hover:bg-panel"
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
      <Modal
        open={isOpen}
        onClose={() => setIsOpen(false)}
        title={t('events.selectHeroPhoto')}
        size="xl"
        closeOnBackdrop={false}
        footer={
          <Button
            variant="outline"
            onClick={() => setIsOpen(false)}
          >
            {t('common.cancel')}
          </Button>
        }
      >
        {photos.length === 0 ? (
          <p className="text-center text-muted py-8">
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
                    ? 'border-accent-dark ring-2 ring-accent ring-offset-2'
                    : 'border-transparent hover:border-line-strong'
                }`}
              >
                <div className="aspect-square bg-inset">
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
      </Modal>
    </div>
  );
};