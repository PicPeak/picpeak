/**
 * `updateUser` builds the PUT body field by field. `email` has to be in it:
 * re-saving an admin's address as a Super Admin is what confirms it for SSO
 * email linking (`email_link_eligible`, migration 227), and the Users page has
 * no other way to reach that.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../config/api';
import { userManagementService } from '../userManagement.service';

vi.mock('../../config/api', () => ({ api: { put: vi.fn(), get: vi.fn() } }));
const put = vi.mocked(api.put);

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({ data: { user: { id: 7, username: 'mara', email: 'mara@example.com' } } });
});

it('sends the email so a Super Admin can confirm it for SSO', async () => {
  await userManagementService.updateUser(7, { email: 'mara@example.com' });

  expect(put).toHaveBeenCalledWith('/admin/users/7', { email: 'mara@example.com' });
});

it('still sends a role change on its own', async () => {
  await userManagementService.updateUser(7, { roleId: 3 });

  expect(put).toHaveBeenCalledWith('/admin/users/7', { role_id: 3 });
});

it('reads the eligibility flag off the response', async () => {
  put.mockResolvedValue({
    data: { user: { id: 7, username: 'mara', email: 'mara@example.com', emailLinkEligible: false } },
  });

  const user = await userManagementService.updateUser(7, { roleId: 3 });

  expect(user.emailLinkEligible).toBe(false);
});
