import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ProtectionLevel } from '../../hooks/useImageProtection';

type VendorStyle = CSSStyleDeclaration & {
  webkitUserSelect?: string;
  webkitTouchCallout?: string;
  webkitUserDrag?: string;
};

interface ProtectedImageProps extends React.CanvasHTMLAttributes<HTMLCanvasElement> {
  src: string;
  alt: string;
  protectionLevel?: ProtectionLevel;
  watermarkText?: string;
  fragmentGrid?: boolean;
  gridSize?: number;
  scrambleFragments?: boolean;
  invisibleWatermark?: boolean;
  onProtectionViolation?: (violationType: string) => void;
  fallbackSrc?: string;
  crossOrigin?: 'anonymous' | 'use-credentials';
}

export const ProtectedImage: React.FC<ProtectedImageProps> = ({
  src,
  alt,
  protectionLevel = 'standard',
  watermarkText,
  fragmentGrid = false,
  gridSize = 4,
  scrambleFragments = false,
  invisibleWatermark = false,
  onProtectionViolation,
  fallbackSrc,
  crossOrigin = 'anonymous',
  ...canvasProps
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const reportViolation = useCallback((violationType: string) => {
    onProtectionViolation?.(violationType);
    if (process.env.NODE_ENV === 'development') {
      console.warn(`Image protection violation: ${violationType}`);
    }
  }, [onProtectionViolation]);

  // Apply invisible watermark using steganography
  const applyInvisibleWatermark = useCallback((
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    text: string
  ) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const message = text + '\0'; // Null-terminated string
    const messageBytes = new TextEncoder().encode(message);
    
    let byteIndex = 0;
    let bitIndex = 0;
    
    for (let i = 0; i < data.length && byteIndex < messageBytes.length; i += 4) {
      if (bitIndex === 8) {
        bitIndex = 0;
        byteIndex++;
        if (byteIndex >= messageBytes.length) break;
      }
      
      // Modify the least significant bit of the red channel
      const bit = (messageBytes[byteIndex] >> bitIndex) & 1;
      data[i] = (data[i] & 0xFE) | bit;
      bitIndex++;
    }
    
    ctx.putImageData(imageData, 0, 0);
  }, []);

  // Apply visible watermark
  const applyVisibleWatermark = useCallback((
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    text: string
  ) => {
    const fontSize = Math.max(12, Math.min(width, height) / 20);
    ctx.font = `${fontSize}px Arial, sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Add shadow for better visibility
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    
    // Draw watermark in multiple positions for maximum protection
    const positions = [
      { x: width * 0.5, y: height * 0.5 }, // Center
      { x: width * 0.2, y: height * 0.2 }, // Top-left
      { x: width * 0.8, y: height * 0.2 }, // Top-right
      { x: width * 0.2, y: height * 0.8 }, // Bottom-left
      { x: width * 0.8, y: height * 0.8 }, // Bottom-right
    ];
    
    positions.forEach(pos => {
      ctx.strokeText(text, pos.x, pos.y);
      ctx.fillText(text, pos.x, pos.y);
    });
    
    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }, []);

  // Fragment and scramble image for maximum protection
  const renderFragmentedImage = useCallback((
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    width: number,
    height: number
  ) => {
    const fragmentWidth = width / gridSize;
    const fragmentHeight = height / gridSize;
    const fragments: Array<{ x: number; y: number; destX: number; destY: number }> = [];
    
    // Create fragment map
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        fragments.push({
          x: col * fragmentWidth,
          y: row * fragmentHeight,
          destX: col * fragmentWidth,
          destY: row * fragmentHeight,
        });
      }
    }
    
    // Scramble fragments if requested
    if (scrambleFragments) {
      for (let i = fragments.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = fragments[i].destX;
        const tempY = fragments[i].destY;
        fragments[i].destX = fragments[j].destX;
        fragments[i].destY = fragments[j].destY;
        fragments[j].destX = temp;
        fragments[j].destY = tempY;
      }
    }
    
    // Draw fragments
    fragments.forEach(fragment => {
      ctx.drawImage(
        img,
        fragment.x, fragment.y, fragmentWidth, fragmentHeight,
        fragment.destX, fragment.destY, fragmentWidth, fragmentHeight
      );
    });
  }, [gridSize, scrambleFragments]);

  // Main canvas rendering function - wrapped in useCallback to prevent infinite re-renders
  const renderToCanvas = useCallback(() => {
    if (!canvasRef.current || !imageRef.current) {
      return;
    }
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');  // Remove willReadFrequently option
    const img = imageRef.current;
    
    if (!ctx || !img.complete || img.naturalWidth === 0) {
      return;
    }
    
    // Use natural dimensions from the loaded image
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    
    // Don't render if dimensions are invalid
    if (width <= 0 || height <= 0) {
      return;
    }
    
    // IMPORTANT: Set canvas dimensions to match image
    canvas.width = width;
    canvas.height = height;
    
    // Clear canvas and reset context state
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1.0;  // Reset alpha
    ctx.globalCompositeOperation = 'source-over';  // Reset composite operation
    
    try {
      if (fragmentGrid && (protectionLevel === 'enhanced' || protectionLevel === 'maximum')) {
        // Render fragmented image
        renderFragmentedImage(ctx, img, canvas.width, canvas.height);
      } else {
        // Render normal image - ensure image is valid before drawing
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }
      }
      
      // Apply watermarks
      if (watermarkText) {
        if (invisibleWatermark && (protectionLevel === 'enhanced' || protectionLevel === 'maximum')) {
          applyInvisibleWatermark(ctx, canvas.width, canvas.height, watermarkText);
        } else {
          applyVisibleWatermark(ctx, canvas.width, canvas.height, watermarkText);
        }
      }
      
      // Apply additional protection measures
      if (protectionLevel === 'maximum') {
        // Add random noise to make pixel-perfect copying harder
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
          // Add subtle random noise (±1 to RGB values)
          const noise = Math.random() * 2 - 1;
          data[i] = Math.max(0, Math.min(255, data[i] + noise));     // R
          data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise)); // G
          data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise)); // B
        }
        
        ctx.putImageData(imageData, 0, 0);
      }
      
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Error rendering protected image:', error);
      }
      reportViolation('canvas_rendering_error');
      setError(true);
    }
  }, [fragmentGrid, protectionLevel, renderFragmentedImage, watermarkText, invisibleWatermark, applyInvisibleWatermark, applyVisibleWatermark, reportViolation]);

  // Set up protection event listeners
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const canvas = canvasRef.current;
    
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      reportViolation('canvas_context_menu');
      return false;
    };
    
    const handleDragStart = (e: DragEvent) => {
      e.preventDefault();
      reportViolation('canvas_drag_start');
      return false;
    };
    
    const handleSelectStart = (e: Event) => {
      e.preventDefault();
      reportViolation('canvas_selection');
      return false;
    };
    
    // Canvas-specific protection
    const handleCanvasClick = (e: MouseEvent) => {
      if (protectionLevel === 'maximum') {
        // Block all interactions in maximum protection mode
        e.preventDefault();
        e.stopPropagation();
        reportViolation('canvas_interaction_blocked');
        return false;
      }
    };
    
    canvas.addEventListener('contextmenu', handleContextMenu);
    canvas.addEventListener('dragstart', handleDragStart);
    canvas.addEventListener('selectstart', handleSelectStart);
    
    if (protectionLevel === 'maximum') {
      canvas.addEventListener('click', handleCanvasClick);
      canvas.addEventListener('mousedown', handleCanvasClick);
      canvas.addEventListener('mouseup', handleCanvasClick);
    }
    
    // Apply CSS protection
    const canvasStyle = canvas.style as VendorStyle;
    canvasStyle.userSelect = 'none';
    canvasStyle.webkitUserSelect = 'none';
    canvasStyle.webkitTouchCallout = 'none';
    canvasStyle.webkitUserDrag = 'none';
    canvasStyle.pointerEvents = protectionLevel === 'maximum' ? 'none' : 'auto';
    
    return () => {
      canvas.removeEventListener('contextmenu', handleContextMenu);
      canvas.removeEventListener('dragstart', handleDragStart);
      canvas.removeEventListener('selectstart', handleSelectStart);
      canvas.removeEventListener('click', handleCanvasClick);
      canvas.removeEventListener('mousedown', handleCanvasClick);
      canvas.removeEventListener('mouseup', handleCanvasClick);
    };
  }, [protectionLevel, reportViolation]);

  // Load and render image
  useEffect(() => {
    setIsLoading(true);
    setError(false);
    
    const img = new Image();
    // Don't set crossOrigin for blob URLs as they don't support CORS
    if (!src.startsWith('blob:')) {
      img.crossOrigin = crossOrigin;
    }
    
    img.onload = () => {
      try {
        imageRef.current = img;
        
        // Always render to canvas once image is loaded
        renderToCanvas();
        
        setIsLoading(false);
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[ProtectedImage] Critical error in onload handler:', error);
        }
        setError(true);
        setIsLoading(false);
      }
    };
    
    img.onerror = () => {
      if (process.env.NODE_ENV === 'development') {
        console.error('ProtectedImage failed to load:', src);
      }
      if (fallbackSrc && src !== fallbackSrc) {
        // Try fallback
        img.src = fallbackSrc;
      } else {
        setError(true);
        setIsLoading(false);
        reportViolation('image_load_error');
      }
    };
    
    img.src = src;
    
    return () => {
      if (imageRef.current) {
        imageRef.current.onload = null;
        imageRef.current.onerror = null;
      }
    };
  }, [src, fallbackSrc, crossOrigin, renderToCanvas, reportViolation]);

  // Apply protection CSS classes
  const protectionClass = `protected-image protection-${protectionLevel}`;

  // Always render the canvas element so the ref is available
  // Show error state if there's an error
  if (error) {
    return (
      <div 
        className="protected-image-error"
        style={{
          width: canvasProps.width || '100%',
          height: canvasProps.height || 'auto',
          backgroundColor: '#fee2e2',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#dc2626',
          ...canvasProps.style
        }}
        role="img"
        aria-label={`Error loading ${alt}`}
      >
        <span>Image unavailable</span>
      </div>
    );
  }

  // Always render canvas to ensure ref is available
  // Simply hide canvas with opacity while loading, no wrapper needed
  return (
    <canvas
      ref={canvasRef}
      {...canvasProps}
      role="img"
      aria-label={alt}
      className={`${canvasProps.className || ''} ${protectionClass}`.trim()}
      style={{
        maxWidth: '100%',
        height: 'auto',
        opacity: isLoading ? 0 : 1,
        transition: 'opacity 0.2s',
        backgroundColor: isLoading ? '#f3f4f6' : 'transparent',
        ...canvasProps.style
      }}
    />
  );
};
