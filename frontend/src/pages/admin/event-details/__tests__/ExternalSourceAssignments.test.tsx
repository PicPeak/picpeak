import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalSourceAssignments } from '../ExternalSourceAssignments';
import { FolderTreeNode } from '../FolderTreeNode';

const { getSources, list, assignSource, revokeSource } = vi.hoisted(() => ({
  getSources: vi.fn(), list: vi.fn(), assignSource: vi.fn(), revokeSource: vi.fn(),
}));
vi.mock('../../../../services/externalMedia.service', () => ({
  externalMediaService: { getSources, list, assignSource, revokeSource },
}));
vi.mock('../../../../contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ user: { id: 3 } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const mount = (element: React.ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
};
beforeEach(() => {
  vi.clearAllMocks();
  assignSource.mockResolvedValue(undefined); revokeSource.mockResolvedValue(undefined);
});

describe('external source assignments and approved roots', () => {
  it('hides grant management for scoped accounts and explains an empty grant set', async () => {
    getSources.mockResolvedValue({ can_assign: false, sources: [], owners: [] });
    mount(<ExternalSourceAssignments selectedPath="tenants/alice" />);
    expect(await screen.findByText('externalSources.noSources')).toBeInTheDocument();
    expect(screen.queryByText('externalSources.assign')).not.toBeInTheDocument();
  });

  it('requires an explicit owner choice before assigning the selected source', async () => {
    getSources.mockResolvedValue({ can_assign: true, sources: [], owners: [{ id: 4, username: 'alice' }] });
    mount(<ExternalSourceAssignments selectedPath="tenants/alice" />);
    const button = await screen.findByText('externalSources.assign');
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('externalSources.owner'), { target: { value: '4' } });
    fireEvent.click(button);
    await waitFor(() => expect(assignSource).toHaveBeenCalledWith('tenants/alice', 4));
  });

  it('revocation targets only the selected source grant and requires confirmation', async () => {
    getSources.mockResolvedValue({
      can_assign: true, sources: [{ id: 8, path: 'tenants/alice', owner_id: 4 }], owners: [{ id: 4, username: 'alice' }],
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(<ExternalSourceAssignments selectedPath="" />);
    fireEvent.click(await screen.findByText('externalSources.revoke'));
    expect(revokeSource).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('externalSources.revoke'));
    await waitFor(() => expect(revokeSource).toHaveBeenCalledWith(8));
    confirm.mockRestore();
  });

  it('shows a localized mutation failure without reporting a successful assignment', async () => {
    assignSource.mockRejectedValue(new Error('overlap'));
    getSources.mockResolvedValue({ can_assign: true, sources: [], owners: [{ id: 4, username: 'alice' }] });
    mount(<ExternalSourceAssignments selectedPath="tenants/alice" />);
    await screen.findByText('externalSources.assign');
    fireEvent.change(screen.getByLabelText('externalSources.owner'), { target: { value: '4' } });
    fireEvent.click(screen.getByText('externalSources.assign'));
    expect(await screen.findByRole('alert')).toHaveTextContent('externalSources.error');
  });

  it('selects a nested approved source using its explicit root-relative path, without listing ancestors', async () => {
    list.mockResolvedValue({ path: '', entries: [{ type: 'dir', name: 'alice', path: 'tenants/alice' }], canNavigateUp: false });
    const onChange = vi.fn();
    mount(<FolderTreeNode path="" name="/external-media" depth={0} value="" onChange={onChange}
      expandedPaths={new Set([''])} toggleExpand={vi.fn()} />);
    fireEvent.click(await screen.findByText('alice'));
    expect(onChange).toHaveBeenCalledWith('tenants/alice');
    expect(list).toHaveBeenCalledExactlyOnceWith('');
  });
});
