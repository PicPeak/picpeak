/**
 * The website builder page (issue 2618): blocks list, block form, preview from
 * the server, phone toggle, adding a block and the read-only view.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EditorState } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
      const text = typeof fallback === 'string' ? fallback : key;
      const vars = (typeof fallback === 'object' ? fallback : opts) as Record<string, unknown> | undefined;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// A split-origin install: resources live on the API's origin.
vi.mock('../../../utils/url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/url')>()),
  buildResourceUrl: (path: string) => `https://api.example.com${path}`,
}));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: vi.fn() }));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { messaging: true, calendarBooking: false, quotes: false } }),
}));
vi.mock('../../../components/admin/SectionPageHeader', () => ({
  SectionPageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => <header><h1>{title}</h1>{actions}</header>,
}));
vi.mock('../../../components/admin/SettingsSaveBar', () => ({
  // Like the real bar: both buttons off while clean or while saving.
  SettingsSaveBar: ({ isDirty, isSaving, onSave, onDiscard, saveLabel }: { isDirty: boolean; isSaving?: boolean; onSave: () => void; onDiscard: () => void; saveLabel: string }) => (
    <>
      <button type="button" disabled={!isDirty || isSaving} onClick={onDiscard}>Discard</button>
      <button type="button" disabled={!isDirty || isSaving} onClick={onSave}>{saveLabel}</button>
    </>
  ),
}));
vi.mock('../../../services/website.service', () => ({
  websiteService: {
    getState: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), preview: vi.fn(), resolveMedia: vi.fn(),
    listGalleries: vi.fn().mockResolvedValue([]), listAssets: vi.fn().mockResolvedValue([]), listPackages: vi.fn().mockResolvedValue({ available: false, packages: [] }),
  },
  mediaKey: (r: { source: string; id: string | number }) => `${r.source}:${r.id}`,
}));

// jsdom has no layout, so no ResizeObserver; the preview then keeps scale 1.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

import { websiteService } from '../../../services/website.service';
import { usePermission } from '../../../hooks/usePermission';
import { WebsiteBuilderPage } from '../WebsiteBuilderPage';

const STATE: EditorState = {
  document: {
    version: 1,
    pages: [
      {
        id: 'home', slug: 'home', title: 'Home', navLabel: '', hidden: false, inNav: true, isHome: true,
        seo: { title: '', description: '', image: null },
        blocks: [
          { id: 'h1', type: 'hero', variant: 'minimal', background: 'default', heading: 'Hello there', subheading: '', buttonLabel: '', buttonUrl: '', image: null, video: null },
          { id: 't1', type: 'text', variant: 'left', background: 'default', heading: 'About', body: 'We take photos.' },
        ],
      },
      { id: 'about', slug: 'about', title: 'About', navLabel: '', hidden: false, inNav: true, isHome: false, seo: { title: '', description: '', image: null }, blocks: [] },
    ],
    theme: { headingFont: null, bodyFont: null, buttonStyle: null, accent: null, background: null, text: null },
    customCss: '',
  },
  draft: { revision: 3, updatedAt: '', publishedAt: null },
  published: { revision: 3, updatedAt: '', publishedAt: '2026-11-27T10:00:00Z' },
  hasUnpublishedChanges: false,
  publicSiteEnabled: true,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <WebsiteBuilderPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('WebsiteBuilderPage', () => {
  beforeEach(() => {
    vi.mocked(websiteService.getState).mockResolvedValue(structuredClone(STATE));
    vi.mocked(websiteService.preview).mockImplementation(async (doc) => `<html><body>${doc.pages[0].blocks.map((b) => ('heading' in b ? b.heading : '')).join('|')}</body></html>`);
    vi.mocked(websiteService.resolveMedia).mockResolvedValue({});
    vi.mocked(usePermission).mockReturnValue(true);
  });

  it('lists the home page blocks and previews the server markup', async () => {
    renderPage();
    expect(await screen.findByText('Blocks on “Home”')).toBeInTheDocument();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    await waitFor(() => expect(websiteService.preview).toHaveBeenCalledWith(expect.anything(), 'home', expect.anything()));
    const frame = await screen.findByTitle('Preview of the page');
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('Hello there|About'));
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
  });

  it('edits a block, marks the draft unsaved and re-renders the preview', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    const heading = screen.getByLabelText('Heading');
    fireEvent.change(heading, { target: { value: 'Welcome' } });
    expect(screen.getByRole('button', { name: 'Save draft' })).not.toBeDisabled();
    await waitFor(() => expect(screen.getByTitle('Preview of the page').getAttribute('srcdoc')).toContain('Welcome|About'));
    expect(screen.getByText('Unpublished changes')).toBeInTheDocument();
  });

  it('undo puts the last edit back', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Welcome' } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByLabelText('Heading') as HTMLInputElement).value).toBe('Hello there');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('adds a block after the selected one', async () => {
    renderPage();
    await screen.findByText('Blocks on “Home”');
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Contact form'));
    // The new block opens in the form.
    expect(await screen.findByText('Messages arrive in Messages › Customers. Nothing is emailed to the visitor.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All blocks' }));
    expect(screen.getAllByText('Contact form').length).toBeGreaterThan(0);
  });

  it('switches the preview to phone width', async () => {
    renderPage();
    const frame = await screen.findByTitle('Preview of the page');
    expect(frame.style.width).toBe('1280px');
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    expect(screen.getByTitle('Preview of the page').style.width).toBe('390px');
  });

  it('is read-only without cms.edit', async () => {
    vi.mocked(usePermission).mockImplementation((p: string) => p !== 'cms.edit');
    renderPage();
    expect(await screen.findByText('You can see the website but not change it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add block' })).toBeNull();
  });

  it('refuses a reserved page address before saving', async () => {
    renderPage();
    await screen.findByText('Blocks on “Home”');
    fireEvent.click(screen.getByRole('tab', { name: /Pages/ }));
    fireEvent.click(screen.getByText('/about'));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'admin' } });
    expect(screen.getByText('This address is used by PicPeak itself. Choose another.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('says so when someone else saved first, and loads their version on request', async () => {
    vi.mocked(websiteService.saveDraft).mockRejectedValue({ response: { status: 409, data: { error: 'changed elsewhere', code: 'WEBSITE_REVISION_CONFLICT' } } });
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/Someone else saved the website/)).toBeInTheDocument();
    // The typed text is still there.
    expect((screen.getByLabelText('Heading') as HTMLInputElement).value).toBe('Mine');
    const theirs = structuredClone(STATE);
    (theirs.document.pages[0].blocks[0] as { heading: string }).heading = 'Theirs';
    theirs.draft.revision = 4;
    vi.mocked(websiteService.getState).mockResolvedValue(theirs);
    fireEvent.click(screen.getByRole('button', { name: 'Load the latest version' }));
    await waitFor(() => expect((screen.getByLabelText('Heading') as HTMLInputElement).value).toBe('Theirs'));
    expect(screen.queryByText(/Someone else saved the website/)).toBeNull();
  });

  it('offers no duplicate or new block once a page has 60', async () => {
    const full = structuredClone(STATE);
    full.document.pages[0].blocks = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, type: 'spacer', variant: 'medium', background: 'default', divider: false }));
    full.document.pages[0].blocks[0] = { id: 'h1', type: 'hero', variant: 'minimal', background: 'default', heading: 'Hello there', subheading: '', buttonLabel: '', buttonUrl: '', image: null, video: null };
    vi.mocked(websiteService.getState).mockResolvedValue(full);
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    expect(screen.getByRole('button', { name: 'Duplicate block' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'All blocks' }));
    expect(screen.getByRole('button', { name: 'Add block' })).toBeDisabled();
  });

  it('shows the block\'s anchor and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    expect(screen.getByText('#b-h1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the link to this block' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('#b-h1'));
  });

  it('says why the landing page was not imported', async () => {
    vi.mocked(websiteService.getState).mockResolvedValue({ ...structuredClone(STATE), published: null, legacyImportRefused: { length: 150000, max: 102400 } });
    renderPage();
    expect(await screen.findByText(/Your landing page is too long for a custom HTML block/)).toBeInTheDocument();
    expect(screen.getByText(/150000/)).toBeInTheDocument();
  });

  it('locks saving and discarding while Publish saves the draft', async () => {
    window.confirm = () => true;
    let finishSave: (value: EditorState) => void = () => {};
    vi.mocked(websiteService.saveDraft).mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    vi.mocked(websiteService.publish).mockImplementation(async () => ({ ...structuredClone(STATE), hasUnpublishedChanges: false }));
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(websiteService.saveDraft).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    const saved = structuredClone(STATE);
    saved.draft.revision = 4;
    finishSave(saved);
    await waitFor(() => expect(websiteService.publish).toHaveBeenCalledWith(4));
  });

  it('resolves the preview\'s images and fonts against the backend origin', async () => {
    renderPage();
    const frame = await screen.findByTitle('Preview of the page');
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('<base href="https://api.example.com/">'));
  });

  it('keeps a home page\'s faulty address visible so it can be fixed', async () => {
    renderPage();
    await screen.findByText('Blocks on “Home”');
    fireEvent.click(screen.getByRole('tab', { name: /Pages/ }));
    fireEvent.click(screen.getByText('/about'));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'book' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make this the home page' }));
    expect(screen.getByLabelText('Address')).toHaveValue('book');
    expect(screen.getByText('This address is used by PicPeak itself. Choose another.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'start' } });
    expect(screen.queryByText('This address is used by PicPeak itself. Choose another.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish' })).not.toBeDisabled();
  });

  it('asks for the hero video\'s poster when the media live on another origin', async () => {
    renderPage();
    await waitFor(() => expect(websiteService.preview).toHaveBeenCalledWith(expect.anything(), 'home', { videoAsPoster: true }));
  });
});

