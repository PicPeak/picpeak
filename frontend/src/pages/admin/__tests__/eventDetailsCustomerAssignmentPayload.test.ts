/**
 * The event editor must not echo customer_account_ids on every save.
 *
 * Replacing the assignment set needs customers.events, and an editor without
 * customers.view is shown an empty list — so an unconditional echo turned a
 * name-only edit into a 403 (or an attempt to clear assignments the editor
 * cannot see). The page is too wide to mount here, so this pins the payload
 * construction at source level.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../EventDetailsPage.tsx'), 'utf8');

describe('EventDetailsPage — customer_account_ids in the update payload', () => {
  it('is not part of the unconditional payload literal', () => {
    expect(source).not.toMatch(/^\s*customer_account_ids: editForm\.customer_accounts\.map/m);
  });

  it('is added only when the edited set differs from the loaded one', () => {
    expect(source).toContain('loadedCustomerIds.some((id, i) => id !== editedCustomerIds[i])');
    expect(source).toContain('updateData.customer_account_ids = editedCustomerIds;');
  });
});
