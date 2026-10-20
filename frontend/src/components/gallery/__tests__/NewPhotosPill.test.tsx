import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, vars: { count: number }) => fallback.replace('{{count}}', String(vars.count)),
  }),
}));

import { NewPhotosPill } from '../NewPhotosPill';

describe('NewPhotosPill', () => {
  it('renders nothing without new photos', () => {
    const { container } = render(<NewPhotosPill count={0} onClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count and reloads on click', () => {
    const onClick = vi.fn();
    render(<NewPhotosPill count={4} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '4 new photos' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('sits above the phone selection bar', () => {
    render(<NewPhotosPill count={2} onClick={() => {}} />);
    expect(screen.getByRole('status').style.bottom).toContain('var(--gallery-bottom-bar');
  });
});
