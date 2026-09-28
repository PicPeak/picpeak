import React from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import { FreeMode, Mousewheel } from 'swiper/modules';
import 'swiper/css';
import 'swiper/css/free-mode';
import { StoryPhotoCard } from './StoryPhotoCard';
import { storyPhotoAspectRatio } from './StoryJustifiedGrid';
import type { Photo } from '../../../../types';

interface StoryCarouselProps {
  photos: Photo[];
  favorites: Set<number>;
  onToggleFavorite: (id: number) => void;
  onPhotoClick: (photo: Photo) => void;
  slug: string;
  id: string;
  allowDownloads?: boolean;
  useEnhancedProtection?: boolean;
  /** Issue 1709: size each slide from the photo's aspect ratio instead of a fixed box. */
  naturalAspect?: boolean;
}

export const StoryCarousel: React.FC<StoryCarouselProps> = ({
  photos,
  favorites,
  onToggleFavorite,
  onPhotoClick,
  slug,
  id,
  allowDownloads = true,
  useEnhancedProtection = false,
  naturalAspect = false,
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
            <div
              className={`story-carousel-item${naturalAspect ? ' story-carousel-item--natural' : ''}`}
              style={naturalAspect
                ? ({ '--story-ratio': storyPhotoAspectRatio(photo) } as React.CSSProperties)
                : undefined}
            >
              <StoryPhotoCard
                photo={photo}
                index={index}
                isFavorite={favorites.has(photo.id)}
                onToggleFavorite={onToggleFavorite}
                onClick={() => onPhotoClick(photo)}
                slug={slug}
                galleryId={id}
                allowDownloads={allowDownloads}
                useEnhancedProtection={useEnhancedProtection}
              />
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  );
};
