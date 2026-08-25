/**
 * Other guests' colour labels must reach the grid (#1178).
 *
 * The lightbox has always shown them — /photos/:id/feedback returns per-colour
 * tallies across everyone — but the grid payload carried only the viewer's own
 * label, so a colour set by one guest was visible in fullscreen and invisible
 * on the tile. With "Show Feedback to Guests" on, that is just a hole.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ColorLabelBadge } from '../ColorLabelBadge';

describe('ColorLabelBadge (#1178)', () => {
  it('renders nothing when there is no label at all', () => {
    const { container } = render(<ColorLabelBadge colorLabel={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the viewer's own badge when nobody else marked it", () => {
    render(<ColorLabelBadge colorLabel="red" />);
    expect(screen.getByLabelText(/Marked as/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Also marked by others/i)).not.toBeInTheDocument();
  });

  it("shows other guests' colours even when the viewer has none", () => {
    // The reported case: another guest set red, this viewer set nothing, and
    // the tile showed no indication at all.
    render(<ColorLabelBadge colorLabel={null} otherColorLabels={['red']} />);
    expect(screen.getByLabelText(/Also marked by others/i)).toBeInTheDocument();
  });

  it('shows both without repeating the viewer’s own colour', () => {
    // Own colour excluded from the dots so the badge and the dots never say
    // the same thing twice. Asserted on the rendered dots rather than the
    // aria-label, because the test i18n returns the raw default string without
    // interpolating {{colors}}.
    render(<ColorLabelBadge colorLabel="red" otherColorLabels={['red', 'green']} />);
    expect(screen.getByLabelText(/Marked as/i)).toBeInTheDocument();
    const dots = screen.getByLabelText(/Also marked by others/i).querySelectorAll('span');
    expect(dots.length).toBe(1);
  });

  it('caps the dots so a heavily-marked photo cannot flood the tile', () => {
    render(<ColorLabelBadge colorLabel={null} otherColorLabels={['red', 'green', 'blue', 'yellow', 'purple']} />);
    const others = screen.getByLabelText(/Also marked by others/i);
    expect(others.querySelectorAll('span').length).toBe(3);
  });

  it('ignores a colour it does not know', () => {
    // Forward-compat: a colour added server-side that this build has no swatch
    // for must not render a blank dot.
    render(<ColorLabelBadge colorLabel={null} otherColorLabels={['chartreuse']} />);
    expect(screen.queryByLabelText(/Also marked by others/i)).not.toBeInTheDocument();
  });
});
