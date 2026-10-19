/**
 * The Live Slideshow card seeds its form from the `initial` the Overview tab
 * hands it. A field left out there reads back as the default after a reload
 * (issue 2187: "Random (shuffle)" showed as "Chronological"), and the next
 * save of any other slideshow setting writes that default over the stored one.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

import type { Event } from '../../../../types';

const { slideshowProps, slideshowMounts, stub } = vi.hoisted(() => ({
  slideshowProps: vi.fn(),
  slideshowMounts: vi.fn(),
  stub: () => null,
}));

vi.mock('../../../../components/admin/SlideshowSettingsCard', () => ({
  SlideshowSettingsCard: (props: unknown) => {
    slideshowProps(props);
    React.useEffect(() => { slideshowMounts(); }, []);
    return null;
  },
}));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { slideshow: true, faces: false } }),
}));

vi.mock('../../../../components/admin', () => ({ FeedbackModerationPanel: stub }));
vi.mock('../../../../components/admin/PermissionGate', () => ({
  PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../../components/admin/EventReminderOverrideCard', () => ({ EventReminderOverrideCard: stub }));
vi.mock('../../../../components/admin/DownloadResolutionCard', () => ({ DownloadResolutionCard: stub }));
vi.mock('../../../../components/admin/FaceRecognitionCard', () => ({ FaceRecognitionCard: stub }));
vi.mock('../../../../components/admin/ShortUrlsCard', () => ({ ShortUrlsCard: stub }));
vi.mock('../EventInformationCard', () => ({ EventInformationCard: stub }));
vi.mock('../ShareLinkCard', () => ({ ShareLinkCard: stub }));
vi.mock('../ClientAccessCard', () => ({ ClientAccessCard: stub }));
vi.mock('../EventActionsCard', () => ({ EventActionsCard: stub }));
vi.mock('../PhotoStatisticsCard', () => ({ PhotoStatisticsCard: stub }));
vi.mock('../EventThemeSection', () => ({ EventThemeSection: stub }));
vi.mock('../ArchiveStatusCard', () => ({ ArchiveStatusCard: stub }));

import { OverviewTab } from '../OverviewTab';

describe('OverviewTab → SlideshowSettingsCard initial', () => {
  it('passes the stored play order and category filter', () => {
    const event = {
      id: 7,
      slug: 'wedding-2026',
      show_order: 'random',
      show_category_id: 12,
    } as unknown as Event;
    const noop = () => {};

    render(
      <OverviewTab
        {...({} as React.ComponentProps<typeof OverviewTab>)}
        event={event}
        id="7"
        refetchEvent={noop}
        categories={[]}
        photos={[]}
        cssTemplates={[]}
      />,
    );

    expect(slideshowProps).toHaveBeenCalled();
    const { initial } = slideshowProps.mock.calls.at(-1)![0] as { initial: Record<string, unknown> };
    expect(initial.show_order).toBe('random');
    expect(initial.show_category_id).toBe(12);
  });

  it('mounts a fresh card for another event, so unsaved edits stay with their gallery', () => {
    const tab = (id: number) => (
      <OverviewTab
        {...({} as React.ComponentProps<typeof OverviewTab>)}
        event={{ id, slug: `event-${id}` } as unknown as Event}
        id={String(id)}
        refetchEvent={() => {}}
        categories={[]}
        photos={[]}
        cssTemplates={[]}
      />
    );
    slideshowMounts.mockClear();
    const { rerender } = render(tab(1));
    rerender(tab(1));
    expect(slideshowMounts).toHaveBeenCalledTimes(1);
    rerender(tab(2));
    expect(slideshowMounts).toHaveBeenCalledTimes(2);
  });
});
