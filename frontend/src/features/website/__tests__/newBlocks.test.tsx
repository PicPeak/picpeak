/**
 * The forms of the FAQ, steps, call-to-action, logos and social links
 * blocks (issue 2618).
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Block, CtaBlock, FaqBlock, SocialBlock, StepsBlock, WebsiteDocument } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fb?: unknown, o?: Record<string, unknown>) => {
      const text = typeof fb === 'string' ? fb : (fb as { defaultValue?: string })?.defaultValue ?? k;
      const vars = (typeof fb === 'object' ? fb : o) as Record<string, unknown> | undefined;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: vi.fn(() => true) }));
vi.mock('../../../services/website.service', () => ({
  websiteService: { listGalleries: vi.fn(), listPackages: vi.fn(), getBooking: vi.fn() },
  mediaKey: (r: { source: string; id: string | number }) => `${r.source}:${r.id}`,
}));
// Each editor instance remembers what it was first given: its own undo
// history starts there.
vi.mock('../../../components/admin/CMSEditor', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    CMSEditor: ({ content, onChange }: { content: string; onChange: (v: string) => void }) => {
      const first = ReactActual.useRef(content);
      return <textarea aria-label="rich" data-history-from={first.current} value={content} onChange={(e) => onChange(e.target.value)} />;
    },
  };
});

import { BlockEditor } from '../BlockEditor';
import { WebsiteDocContext } from '../LinkTargetField';

const DOC = {
  version: 1, customCss: '', theme: {},
  pages: [
    { id: 'home', slug: 'home', title: 'Home', navLabel: '', hidden: false, isHome: true, seo: { title: '', description: '', image: null }, blocks: [] },
    { id: 'about', slug: 'about', title: 'About us', navLabel: '', hidden: false, isHome: false, seo: { title: '', description: '', image: null },
      blocks: [{ id: 'form', type: 'contact', variant: 'simple', background: 'default', heading: 'Write to us', intro: '', showPhone: false, showDate: false, submitLabel: '', successMessage: '' }] },
  ],
} as unknown as WebsiteDocument;

function open(block: Block) {
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><WebsiteDocContext.Provider value={DOC}><BlockEditor block={block} onChange={onChange} /></WebsiteDocContext.Provider></MemoryRouter>
    </QueryClientProvider>,
  );
  return onChange;
}
const base = { id: 'b', background: 'default' as const };

describe('FAQ form', () => {
  it('adds a question and edits its answer with the rich text editor', () => {
    const block: FaqBlock = { ...base, type: 'faq', variant: 'list', heading: '', items: [{ question: 'How long?', answer: '' }] };
    const onChange = open(block);
    fireEvent.change(screen.getByLabelText('rich'), { target: { value: '<p>Two weeks</p>' } });
    expect(onChange.mock.calls.at(-1)?.[0].items[0]).toEqual({ question: 'How long?', answer: '<p>Two weeks</p>' });
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    expect(onChange.mock.calls.at(-1)?.[0].items).toHaveLength(2);
  });
});

describe('list items keep their own editor', () => {
  // The form as the builder holds it: the block in state, edits applied.
  const Stateful: React.FC<{ initial: Block }> = ({ initial }) => {
    const [block, setBlock] = React.useState(initial);
    return <BlockEditor block={block} onChange={(next) => setBlock(next)} />;
  };
  const mount = (block: Block) => render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><WebsiteDocContext.Provider value={DOC}><Stateful initial={block} /></WebsiteDocContext.Provider></MemoryRouter>
    </QueryClientProvider>,
  );

  it('removing a question leaves the next one with its own answer editor (its undo cannot bring back the removed text)', () => {
    mount({ ...base, type: 'faq', variant: 'list', heading: '', items: [
      { id: 'q1', question: 'First?', answer: '<p>removed text</p>' },
      { id: 'q2', question: 'Second?', answer: '<p>kept</p>' },
    ] } as FaqBlock);
    fireEvent.click(screen.getAllByRole('button', { name: /Remove question/ })[0]);
    const editors = screen.getAllByLabelText('rich');
    expect(editors).toHaveLength(1);
    expect(editors[0]).toHaveValue('<p>kept</p>');
    expect(editors[0]).toHaveAttribute('data-history-from', '<p>kept</p>');
  });

  it('a new question, step or testimonial gets an id of its own', () => {
    const onChange = open({ ...base, type: 'faq', variant: 'list', heading: '', items: [{ id: 'q1', question: '', answer: '' }] } as FaqBlock);
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    const items = (onChange.mock.calls.at(-1)?.[0] as FaqBlock).items;
    expect(items[1].id).toMatch(/^[a-z0-9-]{1,24}$/);
    expect(items[1].id).not.toBe('q1');
  });
});

describe('steps form', () => {
  const steps = (n: number, variant = 'numbers'): StepsBlock => ({
    ...base, type: 'steps', variant, heading: '', items: Array.from({ length: n }, (_, i) => ({ title: `S${i}`, text: '', icon: null })),
  });

  it('keeps between two and eight steps', () => {
    open(steps(2));
    for (const b of screen.getAllByRole('button', { name: /Remove step/ })) expect(b).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add step' })).not.toBeDisabled();
  });

  it('stops adding at eight', () => {
    open(steps(8));
    expect(screen.getByRole('button', { name: 'Add step' })).toBeDisabled();
  });

  it('offers an icon per step only in the icon style', () => {
    open(steps(3));
    expect(screen.queryByLabelText('Icon')).toBeNull();
  });

  it('sets a step icon', () => {
    const onChange = open(steps(3, 'icons'));
    fireEvent.change(screen.getAllByLabelText('Icon')[1], { target: { value: 'camera' } });
    expect(onChange.mock.calls.at(-1)?.[0].items[1].icon).toBe('camera');
  });
});

describe('call to action form', () => {
  it('points a button at a block on another page, such as the contact form', () => {
    const block: CtaBlock = { ...base, type: 'cta', variant: 'centered', heading: '', text: '', buttons: [{ label: 'Write', target: null }] };
    const onChange = open(block);
    fireEvent.change(screen.getByLabelText('Leads to'), { target: { value: 'anchor' } });
    const next = onChange.mock.calls.at(-1)?.[0] as CtaBlock;
    expect(next.buttons[0].target).toEqual({ kind: 'anchor', pageId: 'home', blockId: '' });
  });

  it('lists the blocks of the chosen page', () => {
    const block: CtaBlock = { ...base, type: 'cta', variant: 'centered', heading: '', text: '', buttons: [{ label: 'Write', target: { kind: 'anchor', pageId: 'about', blockId: '' } }] };
    const onChange = open(block);
    fireEvent.change(screen.getByLabelText('Block'), { target: { value: 'form' } });
    expect((onChange.mock.calls.at(-1)?.[0] as CtaBlock).buttons[0].target).toEqual({ kind: 'anchor', pageId: 'about', blockId: 'form' });
    expect(screen.getByRole('option', { name: 'Contact form: Write to us' })).toBeInTheDocument();
  });

  it('allows two buttons at most', () => {
    const block: CtaBlock = { ...base, type: 'cta', variant: 'centered', heading: '', text: '', buttons: [{ label: 'A', target: { kind: 'booking' } }, { label: 'B', target: { kind: 'url', url: 'https://x.example' } }] };
    open(block);
    const add = screen.getByRole('button', { name: 'Add button' });
    expect(add).toBeDisabled();
    // And says why it is off.
    expect(add).toHaveAccessibleDescription('No more than 2 fit here.');
    expect(screen.getByText('No more than 2 fit here.')).toBeInTheDocument();
  });
});

describe('social links form', () => {
  it('adds a network and says when its address is not one a visitor can open', () => {
    const block: SocialBlock = { ...base, type: 'social', variant: 'icons', heading: '', links: [{ network: 'instagram', url: 'instagram.com/studio' }] };
    const onChange = open(block);
    expect(screen.getByText('Start with https://')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(onChange.mock.calls.at(-1)?.[0].links[1]).toEqual({ network: 'facebook', url: '' });
  });
});

describe('logos form', () => {
  it('turns the grey look off', () => {
    const onChange = open({ ...base, type: 'logos', variant: 'strip', heading: '', grayscale: true, items: [] });
    fireEvent.click(screen.getByRole('switch', { name: /grey/i }));
    expect(onChange.mock.calls.at(-1)?.[0].grayscale).toBe(false);
  });
});
