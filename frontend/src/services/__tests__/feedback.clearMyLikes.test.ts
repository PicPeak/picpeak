import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../config/api';
import { feedbackService } from '../feedback.service';
import { FEEDBACK_SUBMITTED_EVENT, LIKES_CLEARED_EVENT } from '../../utils/feedbackEvents';

vi.mock('../../config/api', () => ({ api: { delete: vi.fn() } }));

const listeners: Array<[string, EventListener]> = [];
const listen = (name: string) => {
  const fn = vi.fn();
  listeners.push([name, fn]);
  window.addEventListener(name, fn);
  return fn;
};
afterEach(() => { listeners.splice(0).forEach(([name, fn]) => window.removeEventListener(name, fn)); });

// Issue 2561: taking back all likes reaches the tiles (their held clicks) and
// the selection bar (its cached state) like any other like write.
it('announces the cleared likes and a like change once the server confirmed them', async () => {
  vi.mocked(api.delete).mockResolvedValue({ data: { success: true, removed: 2, photo_ids: [7, 9] } });
  const cleared = listen(LIKES_CLEARED_EVENT);
  const submitted = listen(FEEDBACK_SUBMITTED_EVENT);
  await expect(feedbackService.clearMyLikes('wedding')).resolves.toMatchObject({ removed: 2 });
  expect(api.delete).toHaveBeenCalledWith('/gallery/wedding/my-feedback/likes');
  expect(cleared).toHaveBeenCalledTimes(1);
  expect((submitted.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: 'wedding', feedback_type: 'like' });
});

it('announces nothing when the server refused', async () => {
  vi.mocked(api.delete).mockRejectedValue(new Error('locked'));
  const cleared = listen(LIKES_CLEARED_EVENT);
  const submitted = listen(FEEDBACK_SUBMITTED_EVENT);
  await expect(feedbackService.clearMyLikes('wedding')).rejects.toThrow('locked');
  expect(cleared).not.toHaveBeenCalled();
  expect(submitted).not.toHaveBeenCalled();
});
