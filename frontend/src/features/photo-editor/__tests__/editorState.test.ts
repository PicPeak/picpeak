/**
 * The editor's state changes and keyboard map (issue 2619).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, type EditParams } from '../editMath';
import { cropForAspect, editorReducer, normalizeCrop, resolveEditorKey } from '../editorState';
import { dragCrop } from '../CropOverlay';

const base: EditParams = { ...DEFAULT_PARAMS };

describe('editorReducer', () => {
  it('keeps sliders in range and rounded like the server', () => {
    expect(editorReducer(base, { type: 'slider', key: 'exposure', value: 7.777 }).exposure).toBe(5);
    expect(editorReducer(base, { type: 'slider', key: 'contrast', value: 12.6 }).contrast).toBe(13);
    expect(editorReducer(base, { type: 'slider', key: 'sharpen', value: -5 }).sharpen).toBe(0);
    expect(editorReducer(base, { type: 'straighten', value: 99 }).straighten).toBe(45);
  });

  it('turns the crop with the photo, four turns back to the start', () => {
    const cropped = editorReducer(base, { type: 'crop', crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    const once = editorReducer(cropped, { type: 'rotate', direction: 1 });
    expect(once.rotate).toBe(90);
    expect(once.crop).toEqual({ x: 0.4, y: 0.1, w: 0.4, h: 0.3 });
    let p = cropped;
    for (let i = 0; i < 4; i++) p = editorReducer(p, { type: 'rotate', direction: 1 });
    expect(p).toEqual(cropped);
    expect(editorReducer(once, { type: 'rotate', direction: -1 })).toEqual(cropped);
  });

  it('a turn under a flip still turns the picture clockwise on screen', () => {
    const flipped = editorReducer(base, { type: 'flip', axis: 'h' });
    expect(editorReducer(flipped, { type: 'rotate', direction: 1 }).rotate).toBe(270);
  });

  it('a flip mirrors the crop and the straighten angle', () => {
    const p = { ...base, straighten: 3, crop: { x: 0.1, y: 0, w: 0.5, h: 1 } };
    expect(editorReducer(p, { type: 'flip', axis: 'h' })).toMatchObject({ flipH: true, straighten: -3, crop: { x: 0.4, y: 0, w: 0.5, h: 1 } });
  });

  it('an aspect makes the largest centred crop of that shape', () => {
    const square = editorReducer(base, { type: 'aspect', ratio: 1, width: 600, height: 400 });
    expect(square.crop).toEqual({ x: 0.1667, y: 0, w: 0.6667, h: 1 });
    expect(cropForAspect(3 / 2, { width: 600, height: 400 }, null)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(normalizeCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it('auto sets tone from the histogram; paste and reset touch only what they say', () => {
    const dark = { p005: -12, p10: -10, p50: -7, p99: -4.5, p995: -4, mean: -7.2, clipped: 0 };
    expect(editorReducer(base, { type: 'auto', stats: dark }).exposure).toBeGreaterThan(0);
    const source = { ...base, exposure: 1, rotate: 90 as const, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } };
    const pasted = editorReducer(base, { type: 'apply', params: source, parts: ['tone'] });
    expect(pasted).toMatchObject({ exposure: 1, rotate: 0, crop: null });
    expect(editorReducer(source, { type: 'resetTone' })).toMatchObject({ exposure: 0, rotate: 90 });
    expect(editorReducer(source, { type: 'resetAll' })).toEqual(DEFAULT_PARAMS);
  });
});

describe('dragCrop', () => {
  it('moves inside the frame and keeps the aspect on a corner', () => {
    const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    expect(dragCrop(start, 'move', 0.9, 0, null)).toMatchObject({ x: 0.6, y: 0.2 });
    const corner = dragCrop(start, 'se', 0.1, 0.3, 1);
    expect(corner.w).toBeCloseTo(0.5);
    expect(corner.h).toBeCloseTo(0.5);
    expect(dragCrop(start, 'w', 0.5, 0, null).w).toBeGreaterThanOrEqual(0.02);
  });
});

describe('resolveEditorKey', () => {
  it.each([
    [{ key: '\\' }, 'beforeAfter'],
    [{ key: 'r' }, 'crop'],
    [{ key: 'R', shiftKey: true }, 'reset'],
    [{ key: '[' }, 'rotateLeft'],
    [{ key: ']' }, 'rotateRight'],
    [{ key: 'a' }, 'auto'],
    [{ key: 'ArrowRight' }, 'next'],
    [{ key: 'ArrowLeft' }, 'previous'],
    [{ key: 'C', ctrlKey: true, shiftKey: true }, 'copy'],
    [{ key: 'v', metaKey: true, shiftKey: true }, 'paste'],
    [{ key: 's', metaKey: true }, 'save'],
    [{ key: 'Escape' }, 'close'],
    [{ key: '?' }, 'shortcuts'],
  ])('%j -> %s', (input, command) => {
    expect(resolveEditorKey(input)).toBe(command);
  });

  it('leaves plain keys to a focused slider or field, but not the modified ones', () => {
    expect(resolveEditorKey({ key: 'ArrowLeft', inField: true })).toBeNull();
    expect(resolveEditorKey({ key: 'a', inField: true })).toBeNull();
    expect(resolveEditorKey({ key: 'ArrowLeft', ctrlKey: true, inField: true })).toBe('previous');
    expect(resolveEditorKey({ key: 's', ctrlKey: true, inField: true })).toBe('save');
    expect(resolveEditorKey({ key: 'c', ctrlKey: true })).toBeNull();
  });
});
