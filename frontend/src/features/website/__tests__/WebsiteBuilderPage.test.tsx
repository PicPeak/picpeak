/**
 * The website builder page (issue 2618): blocks list, block form, preview from
 * the server, phone toggle, adding a block and the read-only view.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// The rich text editor keeps its own undo history: each mount is a fresh one.
const editorMounts: string[] = [];
vi.mock('../../../components/admin/CMSEditor', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    CMSEditor: ({ content, onChange }: { content: string; onChange: (v: string) => void }) => {
      ReactActual.useEffect(() => { editorMounts.push(content); }, []);
      return <textarea aria-label="rich" value={content} onChange={(e) => onChange(e.target.value)} />;
    },
  };
});
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
  SettingsSaveBar: ({ isDirty, isSaving, onSave, onDiscard, saveLabel, extra }: { isDirty: boolean; isSaving?: boolean; onSave: () => void; onDiscard: () => void; saveLabel: string; extra?: React.ReactNode }) => (
    <>
      {extra}
      <button type="button" disabled={!isDirty || isSaving} onClick={onDiscard}>Discard</button>
      <button type="button" disabled={!isDirty || isSaving} onClick={onSave}>{saveLabel}</button>
    </>
  ),
}));
vi.mock('../../../services/cms.service', () => ({
  cmsService: { getPages: () => Promise.resolve([]) },
  LEGAL_PAGE_SLUGS: ['impressum', 'datenschutz', 'agb'],
}));
vi.mock('../../../services/website.service', () => ({
  websiteService: {
    getState: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), preview: vi.fn(), resolveMedia: vi.fn(), setVisibility: vi.fn(),
    getContactSettings: vi.fn(), saveContactSettings: vi.fn(),
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

import { toast } from 'react-toastify';
import { websiteService } from '../../../services/website.service';
import { usePermission } from '../../../hooks/usePermission';
import { WebsiteBuilderPage } from '../WebsiteBuilderPage';

const STATE: EditorState = {
  document: {
    version: 1,
    pages: [
      {
        id: 'home', slug: 'home', title: 'Home', navLabel: '', hidden: false, isHome: true,
        seo: { title: '', description: '', image: null },
        blocks: [
          { id: 'h1', type: 'hero', variant: 'minimal', background: 'default', heading: 'Hello there', subheading: '', buttonLabel: '', buttonUrl: '', image: null, video: null },
          { id: 't1', type: 'text', variant: 'left', background: 'default', heading: 'About', body: 'We take photos.' },
        ],
      },
      { id: 'about', slug: 'about', title: 'About', navLabel: '', hidden: false, isHome: false, seo: { title: '', description: '', image: null }, blocks: [] },
    ],
    theme: { headingFont: null, bodyFont: null, buttonStyle: null, accent: null, background: null, text: null },
    customCss: '',
    footer: { columns: [], legal: 'column', copyright: '', background: 'default' }, menu: { layout: 'left', style: 'plain', sticky: true, transparent: false, mobile: 'dropdown', background: null, text: null, items: [{ id: 'mh', label: '', hidden: false, target: { kind: 'page', pageId: 'home' } }, { id: 'ma', label: '', hidden: false, target: { kind: 'page', pageId: 'about' } }] },
  },
  draft: { revision: 3, updatedAt: '', publishedAt: null },
  published: { revision: 3, updatedAt: '', publishedAt: '2026-11-27T10:00:00Z' },
  hasUnpublishedChanges: false,
  publicSiteEnabled: true,
};

let queryClient: QueryClient;
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient = client;
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
    vi.mocked(websiteService.getContactSettings).mockResolvedValue({
      contact: { recipients: [], defaultRecipient: '', confirmation: false },
      captcha: { provider: 'none', friendly: { siteKey: '', endpoint: 'global', apiKeySet: false }, recaptchaReady: false },
    });
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

  it('Ctrl+Z undoes the draft only outside text editing: not in the rich text editor, not when a field already took it', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Welcome' } });
    const heading = () => (screen.getByLabelText('Heading') as HTMLInputElement).value;
    // The rich text editor is contenteditable; its own undo handles the key.
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('p');
    editable.appendChild(inner);
    document.body.appendChild(editable);
    fireEvent.keyDown(inner, { key: 'z', ctrlKey: true });
    expect(heading()).toBe('Welcome');
    // A handler that already used the key.
    const taken = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(heading()).toBe('Welcome');
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(heading()).toBe('Hello there');
    editable.remove();
  });

  it('allows one contact form a page: no second from the picker or by duplicating, and a page stored with two says so', async () => {
    const state = structuredClone(STATE);
    const contact = (id: string, heading: string) => ({ id, type: 'contact' as const, variant: 'simple', background: 'default' as const, heading, intro: '', showPhone: false, showDate: false, submitLabel: '', successMessage: '' });
    state.document.pages[0].blocks.push(contact('c1', 'Write to us'), contact('c2', 'Second form'));
    vi.mocked(websiteService.getState).mockResolvedValue(state);
    renderPage();
    await screen.findByText('Blocks on “Home”');
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Contact form/ })).toBeDisabled();
    expect(within(dialog).getByText('This page already has a contact form.')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(await screen.findByText('Write to us'));
    expect(screen.getByRole('button', { name: 'Duplicate block' })).toBeDisabled();
    expect(screen.queryByText(/Only one contact form per page is shown/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All blocks' }));
    fireEvent.click(await screen.findByText('Second form'));
    expect(screen.getByText(/Only one contact form per page is shown/)).toBeInTheDocument();
  });

  it('each text block gets its own rich text editor, so its undo never brings back another block\'s text', async () => {
    const state = structuredClone(STATE);
    const text = (id: string, heading: string, body: string, variant = 'left') => ({ id, type: 'text' as const, variant, background: 'default' as const, heading, body, bodyRight: '', format: 'html' as const });
    state.document.pages[0].blocks = [text('ta', 'Block A', '<p>A</p>'), text('tb', 'Block B', '<p>B</p>'), text('tc', 'Block C', '<p>C left</p>', 'columns')];
    vi.mocked(websiteService.getState).mockResolvedValue(state);
    renderPage();
    editorMounts.length = 0;
    fireEvent.click(await screen.findByText('Block A'));
    expect(editorMounts).toEqual(['<p>A</p>']);
    fireEvent.click(screen.getByRole('button', { name: 'All blocks' }));
    fireEvent.click(await screen.findByText('Block B'));
    expect(editorMounts).toEqual(['<p>A</p>', '<p>B</p>']);
    fireEvent.click(screen.getByRole('button', { name: 'All blocks' }));
    fireEvent.click(await screen.findByText('Block C'));
    // Two columns, two editors of their own.
    expect(editorMounts.slice(2)).toEqual(['<p>C left</p>', '']);
    // Another block chosen without going back to the list (here its copy;
    // the preview's click does the same): a fresh editor, not block C's.
    editorMounts.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate block' }));
    expect(editorMounts).toEqual(['<p>C left</p>', '']);
  });

  it('keeps unsaved contact form settings across panels, counts them as unsaved and saves them with the bar', async () => {
    const settings = {
      contact: { recipients: [] as string[], defaultRecipient: 'support@studio.example', confirmation: false },
      captcha: { provider: 'none' as const, friendly: { siteKey: '', endpoint: 'global' as const, apiKeySet: false }, recaptchaReady: false },
    };
    vi.mocked(websiteService.getContactSettings).mockResolvedValue(settings);
    vi.mocked(websiteService.saveContactSettings).mockResolvedValue({ ...settings, contact: { ...settings.contact, recipients: ['owner@studio.example'] } });
    renderPage();
    await screen.findByText('Blocks on “Home”');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: /Design/ }));
    fireEvent.change(await screen.findByLabelText('Send new messages to'), { target: { value: 'owner@studio.example' } });
    // Another panel and back: the edit is still there.
    fireEvent.click(screen.getByRole('tab', { name: /Blocks/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Design/ }));
    expect(await screen.findByLabelText('Send new messages to')).toHaveValue('owner@studio.example');
    // Unsaved: the bar (and with it the leave guard) knows, and saves it.
    expect(screen.getByText('Contact form settings are not saved yet. They apply as soon as they are saved.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save contact form settings' }));
    await waitFor(() => expect(websiteService.saveContactSettings).toHaveBeenCalledWith(expect.objectContaining({
      contact: { recipients: ['owner@studio.example'], confirmation: false },
    })));
    expect(websiteService.saveDraft).not.toHaveBeenCalled();
  });

  it('adds a block after the selected one', async () => {
    renderPage();
    await screen.findByText('Blocks on “Home”');
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Contact form'));
    // The new block opens in the form.
    expect(await screen.findByText('Messages arrive in Messages › Customers and are mailed to the studio. Who gets them, a confirmation to the visitor and the spam check: Design › Contact form.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All blocks' }));
    expect(screen.getAllByText('Contact form').length).toBeGreaterThan(0);
  });

  it('renders the preview again when its query is invalidated (a gallery left the website)', async () => {
    renderPage();
    const frame = await screen.findByTitle('Preview of the page');
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('Hello there|About'));
    vi.mocked(websiteService.preview).mockResolvedValue('<html><body>Gallery gone</body></html>');
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['website-preview'] }); });
    await waitFor(() => expect(screen.getByTitle('Preview of the page').getAttribute('srcdoc')).toContain('Gallery gone'));
  });

  it('renders the preview and the image URLs again before the editor URLs in them expire', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(websiteService.getState).mockResolvedValue({
        ...structuredClone(STATE),
        document: { ...structuredClone(STATE.document), pages: [{ ...structuredClone(STATE.document.pages[0]), blocks: [{ ...STATE.document.pages[0].blocks[0], image: { source: 'photo', id: 7 } }] }] },
      } as EditorState);
      vi.mocked(websiteService.preview).mockClear();
      vi.mocked(websiteService.resolveMedia).mockClear();
      renderPage();
      await waitFor(() => expect(websiteService.preview).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(websiteService.resolveMedia).toHaveBeenCalledTimes(1));
      // The URLs work for one to two hours: refreshed well inside one.
      await act(async () => { vi.advanceTimersByTime(46 * 60 * 1000); });
      await waitFor(() => expect(websiteService.preview).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(websiteService.resolveMedia).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pick from a gallery that is off is its own error, not a conflict, and the edit stays', async () => {
    vi.mocked(websiteService.saveDraft).mockRejectedValue({
      response: {
        status: 409,
        data: { code: 'WEBSITE_GALLERY_NOT_ON_WEBSITE', error: 'Put the gallery on the website first: Summer party', details: [{ code: 'GALLERY_NOT_ON_WEBSITE', eventId: 9, name: 'Summer party' }] },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Welcome' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = String(vi.mocked(toast.error).mock.calls.at(-1)?.[0]);
    expect(message).toContain('Summer party');
    expect(message).toMatch(/Remove the pick|switch the gallery on/);
    expect(screen.queryByText(/Someone else saved the website/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load the latest version' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save draft' })).not.toBeDisabled();
  });

  it('orders the panel tabs Pages, Blocks, Design', async () => {
    renderPage();
    await screen.findByText('Blocks on “Home”');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual(['Pages', 'Blocks', 'Design']);
  });

  it('says the previous landing page was imported while it is still what visitors see', async () => {
    vi.mocked(websiteService.getState).mockResolvedValue({ ...structuredClone(STATE), published: null, legacyLandingLive: true });
    renderPage();
    expect(await screen.findByText(/Your previous landing page was imported/)).toBeInTheDocument();
  });

  it('switches the website on at the site root from the builder', async () => {
    vi.mocked(websiteService.getState).mockResolvedValue({ ...structuredClone(STATE), publicSiteEnabled: false });
    vi.mocked(websiteService.setVisibility).mockResolvedValue(undefined);
    renderPage();
    expect(await screen.findByText(/not shown at the site root/)).toBeInTheDocument();
    vi.mocked(websiteService.getState).mockResolvedValue(structuredClone(STATE));
    fireEvent.click(screen.getByRole('button', { name: 'Show it at the site root' }));
    await waitFor(() => expect(websiteService.setVisibility).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.queryByText(/not shown at the site root/)).toBeNull());
    // And off again, after asking (no confirm dialog provider here: window.confirm).
    window.confirm = () => true;
    vi.mocked(websiteService.getState).mockResolvedValue({ ...structuredClone(STATE), publicSiteEnabled: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Take offline' }));
    await waitFor(() => expect(websiteService.setVisibility).toHaveBeenLastCalledWith(false));
  });

  it('offers showing or hiding the website only with the settings permission', async () => {
    vi.mocked(usePermission).mockImplementation((p: string) => p !== 'settings.edit');
    renderPage();
    await screen.findByText('Blocks on “Home”');
    expect(screen.queryByRole('button', { name: 'Take offline' })).toBeNull();
  });

  it('opens on the Pages panel from a link to it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient = client;
    render(
      <MemoryRouter initialEntries={['/admin/website?panel=pages']}>
        <QueryClientProvider client={client}><WebsiteBuilderPage /></QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('tab', { name: /Pages/, selected: true })).toBeInTheDocument();
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

  it('offers no reordering of blocks or pages without cms.edit', async () => {
    vi.mocked(usePermission).mockImplementation((p: string) => p !== 'cms.edit');
    renderPage();
    await screen.findByText('Blocks on “Home”');
    expect(screen.queryByRole('button', { name: /Move “.*” (up|down)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /drag, or Space/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Pages/ }));
    expect(screen.getByText('/about')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move “.*” (up|down)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /drag, or Space/ })).toBeNull();
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

  it('opens the published site on the website\'s origin, not the admin\'s', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: /Open site/ });
    expect(link.getAttribute('href')).toBe('https://api.example.com/');
  });

  it('opens the published site on the configured public address, where its links work', async () => {
    vi.mocked(websiteService.getState).mockResolvedValue({ ...structuredClone(STATE), publicUrl: 'https://photos.example' });
    renderPage();
    const link = await screen.findByRole('link', { name: /Open site/ });
    expect(link.getAttribute('href')).toBe('https://photos.example/');
  });

  it('says when the preview could not be refreshed, keeps the last one, and retries', async () => {
    renderPage();
    const frame = await screen.findByTitle('Preview of the page');
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('Hello there|About'));
    vi.mocked(websiteService.preview).mockRejectedValue(new Error('Network down'));
    fireEvent.click(screen.getByText('Hello there'));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Welcome' } });
    expect(await screen.findByText(/Preview out of date/)).toBeInTheDocument();
    expect(screen.getByTitle('Preview of the page').getAttribute('srcdoc')).toContain('Hello there|About');
    vi.mocked(websiteService.preview).mockImplementation(async (doc) => `<html><body>${doc.pages[0].blocks.map((b) => ('heading' in b ? b.heading : '')).join('|')}</body></html>`);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect(screen.getByTitle('Preview of the page').getAttribute('srcdoc')).toContain('Welcome|About'));
    expect(screen.queryByText(/Preview out of date/)).toBeNull();
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

  it('keeps the editor and its unsaved changes when a refresh fails', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Hello there'));
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Unsaved' } });
    vi.mocked(websiteService.getState).mockRejectedValue(new Error('Network down'));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['website-editor'] }); });
    expect(await screen.findByText(/Could not refresh the website/)).toBeInTheDocument();
    expect((screen.getByLabelText('Heading') as HTMLInputElement).value).toBe('Unsaved');
    expect(screen.getByRole('button', { name: 'Save draft' })).not.toBeDisabled();
    vi.mocked(websiteService.getState).mockResolvedValue(structuredClone(STATE));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Could not refresh the website/)).toBeNull());
    expect((screen.getByLabelText('Heading') as HTMLInputElement).value).toBe('Unsaved');
  });

  it('shows the full error only when nothing has loaded yet', async () => {
    vi.mocked(websiteService.getState).mockRejectedValue(new Error('Network down'));
    renderPage();
    expect(await screen.findByText('Network down')).toBeInTheDocument();
    expect(screen.queryByText(/Could not refresh the website/)).toBeNull();
  });
});

