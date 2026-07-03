import React from 'react';
import type { HeroDividerStyle } from '../../types/theme.types';

interface HeroDividerProps {
  style: HeroDividerStyle;
  fillColor?: string;
  className?: string;
}

export const HeroDivider: React.FC<HeroDividerProps> = ({
  style,
  fillColor = 'var(--color-background, #fafafa)',
  className = ''
}) => {
  if (style === 'none' || style === 'straight') {
    // No visible divider - straight clean edge
    return null;
  }

  switch (style) {
    case 'wave':
      return (
        <div className={`absolute bottom-0 left-0 right-0 ${className}`}>
          <svg className="w-full h-12 sm:h-16" viewBox="0 0 1200 120" preserveAspectRatio="none">
            <path
              d="M0,60 C150,90 350,30 600,60 C850,90 1050,30 1200,60 L1200,120 L0,120 Z"
              fill={fillColor}
            />
          </svg>
        </div>
      );

    case 'angle':
      return (
        <div className={`absolute bottom-0 left-0 right-0 ${className}`}>
          <svg className="w-full h-12 sm:h-16" viewBox="0 0 1200 120" preserveAspectRatio="none">
            <path
              d="M0,120 L1200,40 L1200,120 Z"
              fill={fillColor}
            />
          </svg>
        </div>
      );

    case 'curve':
      return (
        <div className={`absolute bottom-0 left-0 right-0 ${className}`}>
          <svg className="w-full h-12 sm:h-16" viewBox="0 0 1200 120" preserveAspectRatio="none">
            <path
              d="M0,80 Q600,0 1200,80 L1200,120 L0,120 Z"
              fill={fillColor}
            />
          </svg>
        </div>
      );

    default:
      return null;
  }
};

HeroDivider.displayName = 'HeroDivider';
