import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { ProtectedImage } from '../ProtectedImage';

// Create a stable mock context (same reference for all getContext calls)
const mockContext = {
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  getImageData: vi.fn(() => ({
    data: new Uint8ClampedArray(400).fill(255)
  })),
  putImageData: vi.fn(),
  fillRect: vi.fn(),
  fillText: vi.fn(),
  strokeText: vi.fn(),
  measureText: vi.fn(() => ({ width: 100 })),
  globalAlpha: 1.0,
  globalCompositeOperation: 'source-over',
  font: '',
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  textAlign: 'center',
  textBaseline: 'middle',
  shadowColor: 'transparent',
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
};

// Mock HTMLCanvasElement.getContext to always return our stable context
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => mockContext,
  writable: true,
});

// Default Image mock that simulates successful loading
const createSuccessImage = () => {
  return class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';
    naturalWidth = 100;
    naturalHeight = 100;
    width = 100;
    height = 100;
    crossOrigin = '';
    complete = true;

    constructor() {
      setTimeout(() => {
        if (this.onload) this.onload();
      }, 10);
    }
  } as unknown as typeof Image;
};

global.Image = createSuccessImage();

describe('ProtectedImage', () => {
  const defaultProps = {
    src: '/test-image.jpg',
    alt: 'Test image'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Image mock to success variant
    global.Image = createSuccessImage();
  });

  it('renders canvas with loading styles initially', () => {
    render(<ProtectedImage {...defaultProps} />);
    const canvas = screen.getByRole('img', { name: 'Test image' });
    expect(canvas).toBeInTheDocument();
    // While loading, canvas has opacity 0
    expect(canvas).toHaveStyle({ opacity: '0' });
  });

  it('renders canvas after image loads', async () => {
    render(<ProtectedImage {...defaultProps} />);

    await waitFor(() => {
      const canvas = screen.getByRole('img', { name: 'Test image' });
      expect(canvas).toHaveStyle({ opacity: '1' });
    });
  });

  it('applies protection level classes and events', async () => {
    const onViolation = vi.fn();

    render(
      <ProtectedImage
        {...defaultProps}
        protectionLevel="enhanced"
        onProtectionViolation={onViolation}
      />
    );

    await waitFor(() => {
      const canvas = screen.getByRole('img', { name: 'Test image' });
      expect(canvas).toBeInTheDocument();
    });

    // Test context menu blocking
    const canvas = screen.getByRole('img', { name: 'Test image' });
    fireEvent.contextMenu(canvas);

    expect(onViolation).toHaveBeenCalledWith('canvas_context_menu');
  });

  it('applies watermark text when specified', async () => {
    render(
      <ProtectedImage
        {...defaultProps}
        watermarkText="Test Watermark"
        protectionLevel="standard"
      />
    );

    await waitFor(() => {
      const canvas = screen.getByRole('img', { name: 'Test image' });
      expect(canvas).toHaveStyle({ opacity: '1' });
    });

    // Verify canvas context methods were called for watermark
    expect(mockContext.fillText).toHaveBeenCalled();
  });

  it('handles fragment grid rendering', async () => {
    render(
      <ProtectedImage
        {...defaultProps}
        fragmentGrid={true}
        gridSize={4}
        protectionLevel="enhanced"
      />
    );

    await waitFor(() => {
      const canvas = screen.getByRole('img', { name: 'Test image' });
      expect(canvas).toHaveStyle({ opacity: '1' });
    });

    // Verify multiple drawImage calls for fragments
    expect(mockContext.drawImage).toHaveBeenCalled();
  });

  it('blocks interactions in maximum protection mode', async () => {
    const onViolation = vi.fn();

    render(
      <ProtectedImage
        {...defaultProps}
        protectionLevel="maximum"
        onProtectionViolation={onViolation}
      />
    );

    await waitFor(() => {
      const canvas = screen.getByRole('img', { name: 'Test image' });
      expect(canvas).toBeInTheDocument();

      // Test click blocking
      fireEvent.click(canvas);
      expect(onViolation).toHaveBeenCalledWith('canvas_interaction_blocked');
    });
  });

  it('handles image loading errors gracefully', async () => {
    // Track how many times src is set to detect fallback attempts
    let loadAttempt = 0;

    global.Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = '';
      naturalWidth = 0;
      naturalHeight = 0;
      width = 0;
      height = 0;
      crossOrigin = '';
      complete = false;

      get src() { return this._src; }
      set src(value: string) {
        this._src = value;
        loadAttempt++;
        setTimeout(() => {
          if (this.onerror) this.onerror();
        }, 10);
      }
    } as unknown as typeof Image;

    const onViolation = vi.fn();

    // Render WITHOUT fallbackSrc so error state is reached immediately
    render(
      <ProtectedImage
        {...defaultProps}
        onProtectionViolation={onViolation}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Image unavailable')).toBeInTheDocument();
    });

    expect(onViolation).toHaveBeenCalledWith('image_load_error');
  });

  it('applies invisible watermark for enhanced protection', async () => {
    render(
      <ProtectedImage
        {...defaultProps}
        watermarkText="Hidden"
        invisibleWatermark={true}
        protectionLevel="enhanced"
      />
    );

    await waitFor(() => {
      const canvas = screen.getByRole('img', { name: 'Test image' });
      expect(canvas).toHaveStyle({ opacity: '1' });
    });

    // Verify getImageData and putImageData called for steganography
    expect(mockContext.getImageData).toHaveBeenCalled();
    expect(mockContext.putImageData).toHaveBeenCalled();
  });

  it('scrambles fragments when enabled', async () => {
    render(
      <ProtectedImage
        {...defaultProps}
        fragmentGrid={true}
        scrambleFragments={true}
        protectionLevel="maximum"
      />
    );

    await waitFor(() => {
      const canvas = screen.getByRole('img', { name: 'Test image' });
      expect(canvas).toHaveStyle({ opacity: '1' });
    });

    // Fragment scrambling should result in multiple drawImage calls
    expect(mockContext.drawImage).toHaveBeenCalled();
  });

  it('adds random noise in maximum protection', async () => {
    render(
      <ProtectedImage
        {...defaultProps}
        protectionLevel="maximum"
      />
    );

    await waitFor(() => {
      const canvas = screen.getByRole('img', { name: 'Test image' });
      expect(canvas).toHaveStyle({ opacity: '1' });
    });

    // Noise injection requires getImageData and putImageData
    expect(mockContext.getImageData).toHaveBeenCalled();
    expect(mockContext.putImageData).toHaveBeenCalled();
  });
});
