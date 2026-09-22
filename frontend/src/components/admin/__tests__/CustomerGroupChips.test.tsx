/**
 * Customer group chips (#1443): the "+n" beyond the visible chips is a real
 * button — reachable by Tab, named for a screen reader, and it reveals the
 * hidden groups in place and hides them again. The colour dot carries a ring
 * so a colour close to the surface doesn't make it vanish.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const values = (typeof fb === 'object' && fb !== null ? fb : opts) as Record<string, unknown> | undefined;
        const plural = values?.[values?.count === 1 ? 'defaultValue_one' : 'defaultValue_other'];
        const base = typeof fb === 'string' ? fb : typeof plural === 'string' ? plural : k;
        return values ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(values[key] ?? '')) : base;
      },
    }),
  };
});

import { CustomerGroupChipList, CustomerGroupFilter } from '../CustomerGroupChips';

const group = (id: number, name: string) => ({
  id, name, description: null, color: '#FFFFFF', sortOrder: id, isArchived: false,
});
const groups = [group(1, 'VIP'), group(2, 'Press'), group(3, 'Wedding'), group(4, 'Corporate')];

describe('CustomerGroupChipList', () => {
  it('reveals the hidden groups from a keyboard-reachable button, and hides them again', async () => {
    const user = userEvent.setup();
    render(<CustomerGroupChipList groups={groups} max={2} />);
    expect(screen.queryByText('Wedding')).toBeNull();

    await user.tab();
    const more = screen.getByRole('button', { name: 'Show 2 more groups' });
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute('aria-expanded', 'false');
    const controlled = document.getElementById(more.getAttribute('aria-controls') || '');
    expect(controlled).not.toBeNull();

    await user.keyboard('{Enter}');
    expect(screen.getByText('Wedding')).toBeInTheDocument();
    expect(screen.getByText('Corporate')).toBeInTheDocument();
    expect(controlled).toContainElement(screen.getByText('Wedding'));
    const less = screen.getByRole('button', { name: 'Show fewer groups' });
    expect(less).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard(' ');
    expect(screen.queryByText('Wedding')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 2 more groups' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('names one hidden group in the singular', () => {
    render(<CustomerGroupChipList groups={groups.slice(0, 3)} max={2} />);
    expect(screen.getByRole('button', { name: 'Show 1 more group' })).toBeInTheDocument();
  });

  it('has no button when every group fits', () => {
    render(<CustomerGroupChipList groups={groups.slice(0, 2)} max={3} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('rings the colour dot, so a white dot on a white surface still shows', () => {
    const { container } = render(<CustomerGroupChipList groups={groups.slice(0, 1)} />);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toContain('ring-1');
    expect(dot?.className).toContain('dark:ring-white/25');
  });
});

describe('CustomerGroupFilter', () => {
  const props = {
    selectedIds: [], onToggle: vi.fn(), ungrouped: false, ungroupedCount: 5, onToggleUngrouped: vi.fn(),
    match: 'any' as const, onMatchChange: vi.fn(), showClear: false, onClear: vi.fn(),
  };

  it('keeps Ungrouped when every group is archived', () => {
    render(<CustomerGroupFilter {...props} groups={[]} hasAnyGroup />);
    expect(screen.getByRole('button', { name: /Ungrouped/ })).toBeInTheDocument();
  });

  it('renders nothing when there are no groups at all', () => {
    const { container } = render(<CustomerGroupFilter {...props} groups={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('turns the unselected groups off at the limit, and says why, but keeps the selected ones switchable', () => {
    render(<CustomerGroupFilter {...props} groups={groups} selectedIds={[1, 2]} maxSelected={2} />);
    expect(screen.getByRole('button', { name: /VIP/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Press/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Wedding/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Corporate/ })).toBeDisabled();
    expect(screen.getByText('Filter by at most 2 groups at once.')).toBeInTheDocument();
  });

  it('keeps every group switchable below the limit', () => {
    render(<CustomerGroupFilter {...props} groups={groups} selectedIds={[1]} maxSelected={2} />);
    for (const name of [/VIP/, /Press/, /Wedding/, /Corporate/]) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    expect(screen.queryByText(/at most/)).toBeNull();
  });
});
