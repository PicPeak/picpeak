import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { toast } from 'react-toastify';
import { useLightboxAnnotation } from '../useLightboxAnnotation';

vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const stroke = { tool: 'free' as const, color: 0, points: [[0.1, 0.1], [0.2, 0.2]] };

function setup(initial: { photoId: number; editRevision: number }) {
  return renderHook((props: { photoId: number; editRevision: number }) => useLightboxAnnotation({
    photoId: props.photoId,
    canDraw: true,
    panelOpen: true,
    onStart: () => {},
    onShow: () => {},
    editRevision: props.editRevision,
  }), { initialProps: initial });
}

describe('useLightboxAnnotation and the edit revision (issue 2619)', () => {
  beforeEach(() => vi.mocked(toast.info).mockClear());

  it('labels a drawing with the revision it was started on', () => {
    const { result } = setup({ photoId: 1, editRevision: 2 });
    act(() => result.current.startDrawing());
    act(() => result.current.addStroke(stroke as never));
    act(() => result.current.done());
    expect(result.current.context.draft?.strokes).toHaveLength(1);
    expect(result.current.context.draftRevision).toBe(2);
  });

  it('drops strokes in progress when the photo on screen is updated, with a notice', () => {
    const { result, rerender } = setup({ photoId: 1, editRevision: 2 });
    act(() => result.current.startDrawing());
    act(() => result.current.addStroke(stroke as never));
    rerender({ photoId: 1, editRevision: 3 });
    expect(result.current.drawing).toBe(false);
    expect(result.current.strokes).toHaveLength(0);
    // Done afterwards has nothing of the old picture to label with the new revision.
    act(() => result.current.done());
    expect(result.current.context.draft).toBeNull();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it('drops a finished draft when the photo is updated before it is sent', () => {
    const { result, rerender } = setup({ photoId: 1, editRevision: 2 });
    act(() => result.current.startDrawing());
    act(() => result.current.addStroke(stroke as never));
    act(() => result.current.done());
    rerender({ photoId: 1, editRevision: 3 });
    expect(result.current.context.draft).toBeNull();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it('a new revision without a drawing, or another photo, shows no notice', () => {
    const { result, rerender } = setup({ photoId: 1, editRevision: 2 });
    rerender({ photoId: 1, editRevision: 3 });
    act(() => result.current.startDrawing());
    act(() => result.current.addStroke(stroke as never));
    rerender({ photoId: 2, editRevision: 5 });
    expect(result.current.drawing).toBe(false);
    expect(toast.info).not.toHaveBeenCalled();
  });
});
