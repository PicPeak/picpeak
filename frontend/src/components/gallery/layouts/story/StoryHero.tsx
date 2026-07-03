import React from 'react';
import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { AuthenticatedImage } from '../../../common';
import type { Photo } from '../../../../types';

interface StoryHeroProps {
  title: string;
  date?: string | null;
  stats: string;
  photo?: Photo | null;
  slug: string;
  allowDownloads?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
}

export const StoryHero: React.FC<StoryHeroProps> = ({
  title,
  date,
  stats,
  photo,
  slug,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false
}) => {
  const formattedDate = date
    ? new Date(date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    : null;

  return (
    <div className="story-hero">
      {/* Background */}
      <div className="story-hero-bg">
        {photo && (photo.url || photo.thumbnail_url) ? (
          <AuthenticatedImage
            src={photo.url || photo.thumbnail_url || ''}
            alt="Hero"
            className="w-full h-full object-cover"
            isGallery={true}
            slug={slug}
            photoId={photo.id}
            requiresToken={photo.requires_token}
            secureUrlTemplate={photo.secure_url_template}
            protectFromDownload={!allowDownloads || useEnhancedProtection}
            protectionLevel={protectionLevel}
            useEnhancedProtection={useEnhancedProtection}
            useCanvasRendering={useCanvasRendering || protectionLevel === 'maximum'}
          />
        ) : (
          <div className="w-full h-full bg-gray-900" />
        )}
        <div className="story-hero-gradient" />
      </div>

      {/* Content */}
      <div className="story-hero-content">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className="space-y-6"
        >
          {formattedDate && (
            <p className="story-hero-date">{formattedDate}</p>
          )}
          <h1 className="story-hero-title">{title}</h1>
          <div className="story-hero-stats">
            <span className="story-hero-stats-divider" />
            <span>{stats}</span>
            <span className="story-hero-stats-divider" />
          </div>
        </motion.div>
      </div>

      {/* Scroll Indicator */}
      <motion.div
        className="story-scroll-indicator"
        animate={{ y: [0, 10, 0] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <ChevronDown size={32} strokeWidth={1} />
      </motion.div>
    </div>
  );
};
