import { useEffect, useRef } from 'react';
import { ProtectionLevel } from './useImageProtection';

type VendorStyle = CSSStyleDeclaration & {
  webkitUserSelect?: string;
  webkitTouchCallout?: string;
  webkitUserDrag?: string;
};

interface UseCSSProtectionOptions {
  enabled: boolean;
  protectionLevel: ProtectionLevel;
  applyWatermark?: boolean;
  watermarkText?: string;
  antiScreenshot?: boolean;
}

export const useCSSProtection = (options: UseCSSProtectionOptions) => {
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!options.enabled || !containerRef.current) return;

    const container = containerRef.current;
    
    // Base protection class
    container.classList.add('protected-image');
    
    // Protection level specific classes
    switch (options.protectionLevel) {
      case 'standard':
        container.classList.add('protection-standard');
        break;
      case 'enhanced':
        container.classList.add('protection-enhanced');
        break;
      case 'maximum':
        container.classList.add('protection-maximum');
        break;
      default:
        break;
    }
    
    // Additional protection features
    if (options.antiScreenshot && options.protectionLevel !== 'basic') {
      container.classList.add('anti-screenshot');
    }
    
    // Create watermark overlay if requested
    if (options.applyWatermark && options.watermarkText && options.protectionLevel !== 'basic') {
      const watermarkOverlay = document.createElement('div');
      watermarkOverlay.className = 'watermark-overlay';
      
      const watermarkText = document.createElement('div');
      watermarkText.className = 'watermark-text';
      watermarkText.textContent = options.watermarkText;
      watermarkText.setAttribute('aria-hidden', 'true');
      
      watermarkOverlay.appendChild(watermarkText);
      container.appendChild(watermarkOverlay);
      
      // Make container relative if not already
      const computedStyle = window.getComputedStyle(container);
      if (computedStyle.position === 'static') {
        container.style.position = 'relative';
      }
    }
    
    // Apply inline styles for enhanced protection
    if (options.protectionLevel === 'enhanced' || options.protectionLevel === 'maximum') {
      // Disable various browser features
      const containerStyle = container.style as VendorStyle;
      containerStyle.userSelect = 'none';
      containerStyle.webkitUserSelect = 'none';
      containerStyle.webkitTouchCallout = 'none';
      containerStyle.webkitUserDrag = 'none';
      
      // Find all img and canvas elements and protect them
      const mediaElements = container.querySelectorAll('img, canvas');
      mediaElements.forEach(element => {
        const el = element as HTMLElement;
        const elStyle = el.style as VendorStyle;
        el.draggable = false;
        elStyle.userSelect = 'none';
        elStyle.webkitUserSelect = 'none';
        elStyle.webkitUserDrag = 'none';
        elStyle.webkitTouchCallout = 'none';
        
        if (options.protectionLevel === 'maximum') {
          (element as HTMLElement).style.pointerEvents = 'none';
        }
      });
    }
    
    // Cleanup function
    return () => {
      // Remove protection classes
      container.classList.remove(
        'protected-image',
        'protection-standard',
        'protection-enhanced',
        'protection-maximum',
        'anti-screenshot'
      );
      
      // Remove watermark overlay
      const watermarkOverlay = container.querySelector('.watermark-overlay');
      if (watermarkOverlay) {
        container.removeChild(watermarkOverlay);
      }
      
      // Reset inline styles
      const containerStyle = container.style as VendorStyle;
      containerStyle.userSelect = '';
      containerStyle.webkitUserSelect = '';
      containerStyle.webkitTouchCallout = '';
      containerStyle.webkitUserDrag = '';
      
      // Reset media element styles
      const mediaElements = container.querySelectorAll('img, canvas');
      mediaElements.forEach(element => {
        const el = element as HTMLElement;
        const elStyle = el.style as VendorStyle;
        elStyle.userSelect = '';
        elStyle.webkitUserSelect = '';
        elStyle.webkitUserDrag = '';
        elStyle.webkitTouchCallout = '';
        elStyle.pointerEvents = '';
      });
    };
  }, [
    options.enabled,
    options.protectionLevel,
    options.applyWatermark,
    options.watermarkText,
    options.antiScreenshot
  ]);

  return containerRef;
};
