import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfigurationPicker, type ConfigurationValues } from '../ConfigurationPicker';
import type { Product } from '../model';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_: string, fallback: string) => fallback, i18n: { language: 'en' } }) }));
const product: Product = { id: 'print', name: 'Print', active: true, description: '', models: [], colours: [], attributes: [
  { id: 'frame', name: 'Frame', groupId: 'frames', optionIds: ['oak'], required: false, multiple: false, addOn: true, dependsOn: [], options: [{ id: 'oak', name: 'Oak', active: true, imageId: null }] },
  { id: 'mat', name: 'Mat', groupId: 'mats', optionIds: ['white'], required: false, multiple: true, addOn: true, dependsOn: [{ attributeId: 'frame', optionIds: ['oak'] }], options: [{ id: 'white', name: 'White mat', active: true, imageId: null }] },
] };
describe('shared product picker', () => {
  it('shows dependent options only with a frame, clears descendants and visibly selects tiles', () => {
    const changes = vi.fn();
    function Fixture() { const [values, setValues] = useState<ConfigurationValues>({}); return <ConfigurationPicker product={product} values={values} onChange={value => { changes(value); setValues(value); }} />; }
    render(<Fixture />);
    expect(screen.queryByLabelText('White mat')).toBeNull();
    fireEvent.click(screen.getByLabelText('Oak'));
    expect(screen.getByLabelText('Oak').closest('label')).toHaveClass('tile-selected');
    fireEvent.click(screen.getByLabelText('White mat'));
    expect(changes).toHaveBeenLastCalledWith({ frame: ['oak'], mat: ['white'] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear choice' })[0]);
    expect(screen.queryByLabelText('White mat')).toBeNull();
    expect(changes).toHaveBeenLastCalledWith({ frame: [] });
  });
  it('renders a confirmed picker read-only', () => {
    render(<ConfigurationPicker product={product} values={{ frame: ['oak'] }} onChange={vi.fn()} disabled />);
    expect(screen.getByLabelText('Oak')).toBeDisabled();
    expect(screen.getByLabelText('White mat')).toBeDisabled();
  });
});
