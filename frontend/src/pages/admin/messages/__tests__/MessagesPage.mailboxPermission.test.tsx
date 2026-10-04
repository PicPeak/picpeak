/**
 * Archive / Restore / Delete on the Messages page write the shared folders
 * (POST /admin/email/item/:kind/:id/state needs email.edit since the security
 * PR); a role with email.view alone must see a read-only page rather than
 * controls that answer 403. The page needs the whole admin shell to render,
 * so this pins the gate at source level.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../MessagesPage.tsx'), 'utf8');

describe('MessagesPage mailbox controls need email.edit', () => {
  it('reads the permission once at the page level', () => {
    expect(source).toContain("usePermission('email.edit')");
    expect(source).toMatch(/canEdit=\{canEditMailbox\}/);
  });

  it('renders Restore, Archive and Delete only for an editor', () => {
    const toolbar = source.slice(source.indexOf('const Toolbar: React.FC'), source.indexOf('// ───', source.indexOf('const Toolbar: React.FC') + 10));
    expect(toolbar).toContain("{canEdit && folderState && <Tb icon={RotateCcw}");
    expect(toolbar).toContain("{canEdit && folderState !== 'archived' && <Tb icon={Archive}");
    expect(toolbar).toMatch(/\{canEdit && \(\s*<Tb\s+icon=\{Trash2\}/);
  });
});
