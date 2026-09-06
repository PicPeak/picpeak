/**
 * Canvas rendering is a lightbox concern, not a tile concern.
 *
 * A canvas pins a backing store of naturalWidth × naturalHeight × 4 bytes
 * that the browser is not allowed to evict, and iOS Safari has a hard
 * budget for canvas memory that fails silently when exceeded — blank
 * tiles, no error. A gallery is hundreds of tiles and one lightbox image,
 * so the tiles render <img> whatever the protection level says, and the
 * lightbox keeps the per-event toggle and the `maximum` implication.
 *
 * Source-level pin: nothing under components/gallery except PhotoLightbox
 * may hand `useCanvasRendering` to AuthenticatedImage.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '..');
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(file);
    return file.endsWith('.tsx') ? [file] : [];
  });
}

describe('canvas rendering stays in the lightbox', () => {
  const files = walk(root);
  const lightbox = path.join(root, 'PhotoLightbox.tsx');

  /** The JSX props of every <AuthenticatedImage> in a file, plus every
   *  `imageProps={{ ... }}` object a layout hands to PhotoCard to spread in. */
  const imageProps = (source: string) => [
    ...source.split('<AuthenticatedImage').slice(1).map((chunk) => chunk.split('/>')[0]),
    ...source.split('imageProps={{').slice(1).map((chunk) => chunk.split('}}')[0]),
  ];

  it('only PhotoLightbox passes useCanvasRendering to AuthenticatedImage', () => {
    const offenders = files.filter((file) => file !== lightbox
      && imageProps(fs.readFileSync(file, 'utf8')).some((props) => props.includes('useCanvasRendering')));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
    // The pin has teeth: the lightbox itself is caught by the same probe.
    expect(imageProps(fs.readFileSync(lightbox, 'utf8')).some((props) => props.includes('useCanvasRendering'))).toBe(true);
  });

  it('only PhotoLightbox turns canvas on for protection level maximum', () => {
    const offenders = files.filter((file) => file !== lightbox
      && /useCanvasRendering[^\n]*protectionLevel === 'maximum'/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('the lightbox still does both', () => {
    const source = fs.readFileSync(lightbox, 'utf8');
    expect(source).toMatch(/useCanvasRendering=\{useCanvasRendering \|\| protectionLevel === 'maximum'\}/);
  });
});
