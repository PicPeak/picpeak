import React from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import { FreeMode, Mousewheel } from 'swiper/modules';
import 'swiper/css';
import 'swiper/css/free-mode';
import { StoryPhotoCard } from './StoryPhotoCard';
import type { Photo } from '../../../../types';

interface StoryCarouselProps {
  photos: Photo[];
  favorites: Set<number>;
  onToggleFavorite: (id: number) => void;
  onPhotoClick: (photo: Photo) => void;
  slug: string;
  id: string;
  allowDownloads?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
}

export const StoryCarousel: React.FC<StoryCarouselProps> = ({
  photos,
  favorites,
  onToggleFavorite,
  onPhotoClick,
  slug,
  id,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false
}) => {
  return (
    <div id={id} className="story-carousel">
      <Swiper
        modules={[FreeMode, Mousewheel]}
        spaceBetween={16}
        slidesPerView="auto"
        freeMode={true}
        mousewheel={{ forceToAxis: true }}
        className="w-full"
      >
        {photos.map((photo, index) => (
          <SwiperSlide key={photo.id} className="!w-auto">
            <div className="story-carousel-item">
              <StoryPhotoCard
                photo={photo}
                index={index}
                isFavorite={favorites.has(photo.id)}
                onToggleFavorite={onToggleFavorite}
                onClick={() => onPhotoClick(photo)}
                slug={slug}
                galleryId={id}
                allowDownloads={allowDownloads}
                protectionLevel={protectionLevel}
                useEnhancedProtection={useEnhancedProtection}
                useCanvasRendering={useCanvasRendering}
              />
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  );
};
