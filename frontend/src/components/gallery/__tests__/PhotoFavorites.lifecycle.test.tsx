import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoFavorites } from '../PhotoFavorites';

vi.mock('react-i18next', async original => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
const { submitFeedback } = vi.hoisted(() => ({ submitFeedback: vi.fn() }));
vi.mock('../../../services/feedback.service', () => ({ feedbackService: { submitFeedback } }));

let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  submitFeedback.mockReset().mockResolvedValue({ success: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function open() {
  return render(<StrictMode><QueryClientProvider client={client}>
    <PhotoFavorites photoId="7" gallerySlug="summer" isFavorited={false} favoriteCount={0} isEnabled />
  </QueryClientProvider></StrictMode>);
}
async function toggle() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe('favourite animation lifecycle', () => {
  it('finishes the animation 300 ms after a mounted save settles', async () => {
    open();
    await toggle();
    const icon = screen.getByRole('button').querySelector('svg')!;
    expect(icon).toHaveClass('scale-125');
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(icon).toHaveClass('scale-125');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(icon).toHaveClass('scale-100');
  });

  it('leaves no animation callback to run after unmount', async () => {
    const { unmount } = open();
    await toggle();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes accepted feedback without scheduling an animation after unmount', async () => {
    let accept!: (value: unknown) => void;
    submitFeedback.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { unmount } = open();
    await toggle();
    expect(screen.getByRole('button')).toBeDisabled();
    unmount();
    await act(async () => { accept({ success: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['my-feedback', 'summer'] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a new save animated when the previous animation would have finished', async () => {
    open();
    await toggle();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    let accept!: (value: unknown) => void;
    submitFeedback.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
    await toggle();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole('button').querySelector('svg')).toHaveClass('scale-125');
    await act(async () => { accept({ success: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('button').querySelector('svg')).toHaveClass('scale-100');
  });
});
