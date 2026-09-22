import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmailBodyFrame } from '../EmailBodyFrame';
import en from '../../../../i18n/locales/en.json';
import de from '../../../../i18n/locales/de.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('incoming email remote content', () => {
  it('provides the privacy controls in both maintained locales', () => {
    for (const locale of [en, de]) {
      expect(locale.messages.remoteContentBlocked).toBeTruthy();
      expect(locale.messages.loadRemoteContent).toBeTruthy();
      expect(locale.messages.emailBody).toBeTruthy();
    }
  });
  const html = '<img src="https://tracker.example/pixel"><div style="background:url(//tracker.example/css)">Hello</div>';
  const preview = () => screen.getByTitle('messages.emailBody');

  it('starts with a network-blocking policy while retaining the scriptless sandbox', () => {
    render(<EmailBodyFrame html={html} />);
    expect(preview()).toHaveAttribute('sandbox', '');
    expect(preview()).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(preview().getAttribute('srcdoc')).toContain("default-src 'none'; img-src data: blob:;");
  });

  it('only permits remote images after an explicit click and resets for a different body', () => {
    const view = render(<EmailBodyFrame html={html} />);
    fireEvent.click(screen.getByRole('button', { name: 'messages.loadRemoteContent' }));
    expect(preview().getAttribute('srcdoc')).toContain('img-src data: blob: https: http:;');
    expect(preview().getAttribute('srcdoc')).toContain("default-src 'none'");
    view.rerender(<EmailBodyFrame html={`${html}<p>Another message</p>`} />);
    expect(preview().getAttribute('srcdoc')).toContain('img-src data: blob:;');
  });

  it('removes scripts, redirects and external stylesheets from legacy saved HTML', () => {
    render(<EmailBodyFrame html={'<meta http-equiv="refresh" content="0;url=https://tracker.example"><link rel="stylesheet" href="https://tracker.example/css"><script>alert(1)</script><p>Safe text</p>'} />);
    const document = preview().getAttribute('srcdoc')!;
    expect(document).not.toContain('<script');
    expect(document).not.toContain('<link');
    expect(document).not.toContain('http-equiv="refresh"');
    expect(document).toContain('Safe text');
  });
});
