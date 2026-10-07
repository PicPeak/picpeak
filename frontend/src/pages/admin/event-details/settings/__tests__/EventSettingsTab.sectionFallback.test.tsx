/**
 * A link to a Settings section that the flags or the role hide falls back to
 * the overview and drops from the URL — but only once flags and permissions
 * have loaded. Until then the defaults hide Faces, Slideshow, Reminder and
 * Danger zone, and a reload on one of them used to lose the section (review
 * round 2 on 1820).
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '../../../../../types';
import { EventSettingsTab } from '../EventSettingsTab';
import { eventFieldsFromEvent, slideshowFromEvent, type EventSettingsDraft } from '../draft';
import type { EventSettingsDraftApi } from '../useEventSettingsDraft';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_k: string, fb?: unknown) => (typeof fb === 'string' ? fb : _k),
      i18n: { language: 'en' },
    }),
  };
});

const flagsState = { flags: { faces: false } as Record<string, boolean>, isLoading: true };
vi.mock('../../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => flagsState,
}));
vi.mock('../../../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ hasPermission: () => true, isLoading: false }),
}));
vi.mock('../../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: () => '14 Jun 2026' }),
}));
vi.mock('../../../../../components/common/ConfirmDialog', () => ({
  useConfirm: () => vi.fn(),
}));
vi.mock('../../../../../components/admin/FaceRecognitionCard', () => ({
  FaceRecognitionCard: () => <div>faces-card</div>,
}));
vi.mock('../../../../../components/admin/CustomerAccountPicker', () => ({
  CustomerAccountPicker: () => null,
}));
vi.mock('../../../../../components/admin/SettingsSaveBar', () => ({
  SettingsSaveBar: () => null,
}));

const EVENT = {
  id: 1,
  slug: 'g',
  event_type: 'wedding',
  event_name: 'G',
  event_date: '2026-06-14',
  customer_name: 'Sarah',
  source_mode: 'managed',
} as unknown as Event;

const draft: EventSettingsDraft = {
  event: eventFieldsFromEvent(EVENT, null),
  feedback: null,
  downloads: null,
  slideshow: slideshowFromEvent(EVENT),
};

const settings = {
  draft,
  setDraft: vi.fn(),
  setEvent: vi.fn(),
  dirty: new Set(),
  isDirty: false,
  isSaving: false,
  save: vi.fn(),
  discard: vi.fn(),
  discardSection: vi.fn(),
  downloadsData: undefined,
} as unknown as EventSettingsDraftApi;

const renderTab = (setSection: ReturnType<typeof vi.fn>, sectionFor: () => string = () => 'faces') => {
  const client = new QueryClient();
  const ui = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EventSettingsTab
          event={EVENT}
          settings={settings}
          section={sectionFor() as 'faces'}
          setSection={setSection}
          categories={[]}
          photos={[]}
          phoneFieldEnabled={false}
          onArchive={vi.fn()}
          isArchiving={false}
          onDelete={vi.fn()}
          isDeleting={false}
          refetchEvent={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(ui());
  return { ...result, rerenderTab: () => result.rerender(ui()) };
};

describe('EventSettingsTab — a section the flags hide', () => {
  beforeEach(() => {
    flagsState.flags = { faces: false };
    flagsState.isLoading = true;
  });

  it('keeps a linked section while the flags are still loading, and opens it once they arrive', () => {
    const setSection = vi.fn();
    const { rerenderTab } = renderTab(setSection);
    expect(setSection).not.toHaveBeenCalled();

    flagsState.flags = { faces: true };
    flagsState.isLoading = false;
    rerenderTab();

    expect(setSection).not.toHaveBeenCalled();
    expect(screen.getByText('faces-card')).toBeInTheDocument();
  });

  it('drops the section from the URL when the loaded flags hide it', () => {
    flagsState.isLoading = false;
    const setSection = vi.fn();
    renderTab(setSection);
    expect(setSection).toHaveBeenCalledWith(null);
  });
});

describe('EventSettingsTab — the detail pane', () => {
  it('starts a newly opened section at its top (review on 1833)', () => {
    flagsState.flags = { faces: false };
    flagsState.isLoading = false;
    let section = 'general';
    const { rerenderTab } = renderTab(vi.fn(), () => section);
    const pane = screen.getByTestId('settings-detail-pane');
    pane.scrollTop = 400;

    section = 'access';
    rerenderTab();

    expect(pane.scrollTop).toBe(0);
  });
});

