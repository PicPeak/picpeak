import React from 'react';
import { Layout, LayoutTemplate, Grid3X3, Layers, Play, Clock, Image, LayoutGrid, Minimize2, EyeOff, Columns, Film } from 'lucide-react';
import { GalleryLayoutType, HeaderStyleType, HeroDividerStyle } from '../../../types/theme.types';

export const layoutIcons: Record<GalleryLayoutType, React.ReactNode> = {
  grid: <Grid3X3 className="w-5 h-5" />,
  masonry: <Layers className="w-5 h-5" />,
  carousel: <Play className="w-5 h-5" />,
  timeline: <Clock className="w-5 h-5" />,
  mosaic: <LayoutGrid className="w-5 h-5" />,
  'gallery-premium': <Columns className="w-5 h-5" />,
  'gallery-story': <Film className="w-5 h-5" />
};

export const headerStyleIcons: Record<HeaderStyleType, React.ReactNode> = {
  hero: <Image className="w-5 h-5" />,
  standard: <Layout className="w-5 h-5" />,
  banner: <LayoutTemplate className="w-5 h-5" />,
  minimal: <Minimize2 className="w-5 h-5" />,
  none: <EyeOff className="w-5 h-5" />
};

export const dividerStylePreviews: Record<HeroDividerStyle, React.ReactNode> = {
  wave: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d="M0,12 C12,18 37,6 50,12 C63,18 88,6 100,12 L100,24 L0,24 Z" fill="currentColor" className="text-neutral-300" />
    </svg>
  ),
  straight: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <rect x="0" y="12" width="100" height="12" fill="currentColor" className="text-neutral-300" />
    </svg>
  ),
  angle: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d="M0,24 L100,8 L100,24 Z" fill="currentColor" className="text-neutral-300" />
    </svg>
  ),
  curve: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d="M0,16 Q50,0 100,16 L100,24 L0,24 Z" fill="currentColor" className="text-neutral-300" />
    </svg>
  ),
  none: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <rect x="0" y="0" width="100" height="24" fill="currentColor" className="text-neutral-100" />
      <text x="50" y="16" textAnchor="middle" fontSize="10" fill="currentColor" className="text-neutral-400">No divider</text>
    </svg>
  )
};
