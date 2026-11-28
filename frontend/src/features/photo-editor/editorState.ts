/**
 * The editor's state changes and keyboard map (issue 2619), kept pure so they
 * are tested without a canvas.
 */
import {
  type CropRect, type EditParams, type SliderKey, type ToneStats, DEFAULT_PARAMS, MIN_CROP, STRAIGHTEN_MAX, autoTone, clampTo, frameSize,
  mergeParts, normalizeSlider,
} from './editMath';

export type EditorAction =
  | { type: 'slider'; key: SliderKey; value: number }
  | { type: 'straighten'; value: number }
  | { type: 'rotate'; direction: 1 | -1 }
  | { type: 'flip'; axis: 'h' | 'v' }
  | { type: 'bw'; value: boolean }
  | { type: 'crop'; crop: CropRect | null }
  | { type: 'aspect'; ratio: number | null; width: number; height: number }
  | { type: 'auto'; stats: ToneStats; linear?: boolean }
  | { type: 'apply'; params: EditParams; parts?: Array<'tone' | 'geometry'> }
  | { type: 'resetTone' }
  | { type: 'resetAll' };

const ROTATIONS: EditParams['rotate'][] = [0, 90, 180, 270];

/** The largest crop of `ratio` (width / height, in pixels) centred in `within`. */
export function cropForAspect(ratio: number, frame: { width: number; height: number }, within: CropRect | null): CropRect {
  const box = within || { x: 0, y: 0, w: 1, h: 1 };
  const boxW = box.w * frame.width;
  const boxH = box.h * frame.height;
  let w = boxW;
  let h = w / ratio;
  if (h > boxH) {
    h = boxH;
    w = h * ratio;
  }
  const cw = w / frame.width;
  const ch = h / frame.height;
  return {
    x: clampTo(box.x + (box.w - cw) / 2, 0, 1 - cw),
    y: clampTo(box.y + (box.h - ch) / 2, 0, 1 - ch),
    w: cw,
    h: ch,
  };
}

/** A crop as the server accepts it: inside the frame, at least MIN_CROP a side, rounded; null for the whole frame. */
export function normalizeCrop(crop: CropRect | null): CropRect | null {
  if (!crop) return null;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  const w = round(clampTo(crop.w, MIN_CROP, 1));
  const h = round(clampTo(crop.h, MIN_CROP, 1));
  const x = round(clampTo(crop.x, 0, 1 - w));
  const y = round(clampTo(crop.y, 0, 1 - h));
  return x === 0 && y === 0 && w === 1 && h === 1 ? null : { x, y, w, h };
}

export function editorReducer(params: EditParams, action: EditorAction): EditParams {
  switch (action.type) {
    case 'slider':
      return { ...params, [action.key]: normalizeSlider(action.key, action.value) };
    case 'straighten':
      return { ...params, straighten: Math.round(clampTo(action.value, -STRAIGHTEN_MAX, STRAIGHTEN_MAX) * 100) / 100 + 0 };
    case 'rotate': {
      // The flips come after the turn: under one flip, turning the picture
      // clockwise on screen is a turn the other way before it.
      const mirrored = params.flipH !== params.flipV;
      const step = (action.direction === 1) !== mirrored ? 1 : 3;
      const next = ROTATIONS[(ROTATIONS.indexOf(params.rotate) + step) % 4];
      // The crop is a share of the turned frame: turning it with the photo
      // keeps the same part of the picture.
      const c = params.crop;
      const crop = c && (action.direction === 1
        ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w }
        : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w });
      return { ...params, rotate: next, crop: normalizeCrop(crop) };
    }
    case 'flip': {
      const c = params.crop;
      if (action.axis === 'h') return { ...params, flipH: !params.flipH, crop: c && normalizeCrop({ ...c, x: 1 - c.x - c.w }), straighten: -params.straighten + 0 };
      return { ...params, flipV: !params.flipV, crop: c && normalizeCrop({ ...c, y: 1 - c.y - c.h }), straighten: -params.straighten + 0 };
    }
    case 'bw':
      return { ...params, bw: action.value };
    case 'crop':
      return { ...params, crop: normalizeCrop(action.crop) };
    case 'aspect': {
      if (action.ratio === null) return params;
      const frame = frameSize(params, action.width, action.height);
      return { ...params, crop: normalizeCrop(cropForAspect(action.ratio, frame, params.crop)) };
    }
    case 'auto':
      return { ...params, ...autoTone(action.stats, { linear: action.linear }) };
    case 'apply':
      return mergeParts(params, action.params, action.parts || ['tone', 'geometry']);
    case 'resetTone':
      return mergeParts(params, DEFAULT_PARAMS, ['tone']);
    case 'resetAll':
      return { ...DEFAULT_PARAMS };
    default:
      return params;
  }
}

// ----------------------------------------------------------------- keyboard

export type EditorCommand =
  | 'previous' | 'next' | 'beforeAfter' | 'crop' | 'rotateLeft' | 'rotateRight' | 'auto' | 'reset'
  | 'copy' | 'paste' | 'save' | 'close' | 'shortcuts';

interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** True while focus is in a text field or a slider, which keep their own keys. */
  inField?: boolean;
}

/**
 * The editor's keyboard map, after Lightroom where it can be: `\` before and
 * after, R crop, Ctrl/Cmd+Shift+C / V copy and paste settings. Plain keys are
 * left to a focused field or slider; the modified ones always work.
 */
export function resolveEditorKey(input: KeyInput): EditorCommand | null {
  const mod = Boolean(input.ctrlKey || input.metaKey);
  const key = input.key;
  if (mod && input.shiftKey && !input.altKey) {
    if (key.toLowerCase() === 'c') return 'copy';
    if (key.toLowerCase() === 'v') return 'paste';
  }
  if (mod && !input.shiftKey && !input.altKey) {
    if (key.toLowerCase() === 's') return 'save';
    if (key === 'ArrowLeft') return 'previous';
    if (key === 'ArrowRight') return 'next';
  }
  if (key === 'Escape') return 'close';
  if (mod || input.altKey || input.inField) return null;
  switch (key) {
    case 'ArrowLeft': return 'previous';
    case 'ArrowRight': return 'next';
    case '\\': return 'beforeAfter';
    case 'r': return 'crop';
    case 'R': return input.shiftKey ? 'reset' : null;
    case '[': return 'rotateLeft';
    case ']': return 'rotateRight';
    case 'a': return 'auto';
    case '?': return 'shortcuts';
    default: return null;
  }
}

/** What the shortcuts panel lists: keys as shown, and the i18n key of the command. */
export const SHORTCUTS: Array<{ keys: string[]; command: EditorCommand }> = [
  { keys: ['←', '→'], command: 'previous' },
  { keys: ['\\'], command: 'beforeAfter' },
  { keys: ['R'], command: 'crop' },
  { keys: ['[', ']'], command: 'rotateLeft' },
  { keys: ['A'], command: 'auto' },
  { keys: ['Shift', 'R'], command: 'reset' },
  { keys: ['Ctrl/⌘', 'Shift', 'C'], command: 'copy' },
  { keys: ['Ctrl/⌘', 'Shift', 'V'], command: 'paste' },
  { keys: ['Ctrl/⌘', 'S'], command: 'save' },
  { keys: ['Esc'], command: 'close' },
  { keys: ['?'], command: 'shortcuts' },
];
