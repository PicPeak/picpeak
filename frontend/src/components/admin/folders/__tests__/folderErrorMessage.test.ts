import { describe, expect, it } from 'vitest';
import { folderErrorMessage } from '../folderQueries';

const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
  `${key}|${fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(options?.[k]))}`;
const reply = (data: Record<string, unknown>) => ({ response: { data } });

describe('folderErrorMessage', () => {
  it('translates the folder codes, with the limit the server sent', () => {
    expect(folderErrorMessage(reply({ error: 'x', code: 'FOLDER_LIMIT_REACHED', limit: 1000 }), t))
      .toBe('photos.folders.errors.limitReached|This gallery has reached its limit of 1000 folders.');
    expect(folderErrorMessage(reply({ error: 'x', code: 'FOLDER_REQUEST_LIMIT_REACHED', limit: 200 }), t))
      .toContain('photos.folders.errors.requestLimitReached|This gallery has reached its limit of 200 open folder requests. Ask an administrator');
    expect(folderErrorMessage(reply({ error: 'x', code: 'FOLDER_TOO_DEEP', limit: 3 }), t))
      .toBe('photos.folders.errors.tooDeep|Folders can be nested at most 3 levels deep.');
    expect(folderErrorMessage(reply({ error: 'x', code: 'FOLDER_EXISTS' }), t)).toContain('photos.folders.errors.exists');
  });

  it('falls back to the server message for an unknown code or none', () => {
    expect(folderErrorMessage(reply({ error: 'Folder name is required', code: 'FOLDER_INVALID' }), t)).toBe('Folder name is required');
    expect(folderErrorMessage(reply({ error: 'Plain' }), t)).toBe('Plain');
    expect(folderErrorMessage(new Error('network'), t)).toBeUndefined();
  });
});
