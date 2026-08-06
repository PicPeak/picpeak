import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PoweredBy } from '../PoweredBy';
import { usePublicSettings } from '../../../hooks/usePublicSettings';

// stub i18n so the prefix comes back as plain English for the assertions
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'common.poweredBy' ? 'Powered by' : key),
  }),
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: vi.fn(),
}));

const mockUsePublicSettings = vi.mocked(usePublicSettings);

const setSettings = (data: Record<string, unknown> | undefined) => {
  mockUsePublicSettings.mockReturnValue({ data } as never);
};

describe('PoweredBy', () => {
  beforeEach(() => {
    mockUsePublicSettings.mockReset();
  });

  it('renders the "Powered by PicPeak" attribution by default', () => {
    setSettings({});
    render(<PoweredBy />);
    expect(screen.getByText(/Powered by/)).toBeInTheDocument();
    expect(screen.getByText('PicPeak')).toBeInTheDocument();
  });

  it('renders nothing while settings are still loading (no attribution flash)', () => {
    setSettings(undefined);
    const { container } = render(<PoweredBy />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('PicPeak')).not.toBeInTheDocument();
  });

  it('renders nothing when branding_hide_powered_by is enabled (white-label)', () => {
    setSettings({ branding_hide_powered_by: true });
    const { container } = render(<PoweredBy />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('PicPeak')).not.toBeInTheDocument();
  });

  it('renders when branding_hide_powered_by is explicitly false', () => {
    setSettings({ branding_hide_powered_by: false });
    render(<PoweredBy />);
    expect(screen.getByText('PicPeak')).toBeInTheDocument();
  });

  it('forwards className and style to the wrapping paragraph', () => {
    setSettings({});
    render(<PoweredBy className="text-xs mt-2" style={{ opacity: 0.5 }} />);
    const paragraph = screen.getByText('PicPeak').closest('p');
    expect(paragraph).toHaveClass('text-xs', 'mt-2');
    expect(paragraph).toHaveStyle({ opacity: '0.5' });
  });
});
