import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../config';
import { SkipLink } from '../../components/common/SkipLink';
import { Button } from '../../components/common/Button';
import { CMSContentBlock } from '../../components/common/CMSContentBlock';
import { LikedChip } from '../../components/gallery/layouts/TileChips';
import { EmailPreviewModal } from '../../components/admin/EmailPreviewModal';

vi.mock('../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { default_language: 'pt' } }),
}));

vi.mock('../../services/cms.service', () => ({
  cmsService: {
    getPublicPage: vi.fn(async (slug: string) => (
      slug === 'agb'
        ? { slug, title: 'AGB', content: '', show_in_footer: false }
        : { slug, title: 'Página não encontrada', content: '<p>Nada aqui.</p>' }
    )),
  },
}));

// Text that used to be fixed English in the markup now follows the UI language (issue 2617).
describe('fixed UI strings go through i18n', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('labels the skip link, the loading spinner and the liked chip in German', async () => {
    await i18n.changeLanguage('de');
    render(
      <>
        <SkipLink />
        <Button isLoading>Go</Button>
        <LikedChip aboveCollage={false} />
      </>,
    );
    expect(screen.getByText('Zum Hauptinhalt springen')).toBeInTheDocument();
    expect(screen.getByLabelText('Wird geladen...')).toBeInTheDocument();
    expect(screen.getByTitle('Gefällt mir')).toBeInTheDocument();
  });

  it('translates the email preview modal chrome', async () => {
    await i18n.changeLanguage('de');
    render(
      <EmailPreviewModal isOpen onClose={() => {}} subject="Hallo" htmlContent="<p>x</p>" textContent="x" />,
    );
    expect(screen.getByText('E-Mail-Vorschau')).toBeInTheDocument();
    expect(screen.getByText('Betreff:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /HTML-Ansicht/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Textansicht/ })).toBeInTheDocument();
  });

  it('labels the CMS page footer in the language the page is served in, not only German', async () => {
    await i18n.changeLanguage('en');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CMSContentBlock slug="not-found" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Aviso Legal')).toBeInTheDocument();
    expect(screen.getByText('Política de Privacidade')).toBeInTheDocument();
    expect(screen.queryByText('Legal Notice')).not.toBeInTheDocument();
  });
});
