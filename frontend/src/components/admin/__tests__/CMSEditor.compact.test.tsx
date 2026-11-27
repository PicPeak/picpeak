/**
 * The CMS editor's compact form (issue 2618): the website builder's text
 * block uses it, with the formatting a website text needs and nothing that
 * the website's sanitiser would drop (h1, h4–h6, code, rules).
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { CMSEditor } from '../CMSEditor';

describe('CMSEditor compact', () => {
  it('offers headings 2 and 3, bold, italic, underline, lists, quote, link and alignment, and no page chrome', async () => {
    render(<CMSEditor compact content="<p>Hi</p>" onChange={() => {}} />);
    for (const title of [/Heading 2/, /Heading 3/, /Bold/, /Italic/, /Underline/, /Bullet List/, /Numbered List/, /Blockquote/, /Add Link/, /Align Left/, /Align Center/, /Align Right/]) {
      expect(await screen.findByTitle(title)).toBeInTheDocument();
    }
    for (const title of [/Heading 1/, /Heading 4/, /Inline Code/, /Code Block/, /Horizontal Rule/]) {
      expect(screen.queryByTitle(title)).toBeNull();
    }
    expect(screen.queryByText('Preview')).toBeNull();
    expect(screen.queryByTitle(/Fullscreen/)).toBeNull();
  });

  it('keeps the full toolbar for CMS pages', async () => {
    render(<CMSEditor content="<p>Hi</p>" onChange={() => {}} />);
    expect(await screen.findByTitle(/Heading 1/)).toBeInTheDocument();
    expect(screen.queryByTitle(/Underline/)).toBeNull();
  });
});
