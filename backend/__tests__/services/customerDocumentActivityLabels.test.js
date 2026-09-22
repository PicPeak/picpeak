/**
 * Every customer_document_* activity the backend logs has an en and a de
 * label in both places the admin UI reads them (#1444, plan slice 6):
 *
 *   admin.activities.<type>                 dashboard "Recent activity" and
 *                                           the customer record's timeline
 *   admin.notificationMessages.<camelCase>  the header notification list
 *
 * They reached the notification list as unlabelled rows: the list selects
 * every activity_logs row, and the locales had no customer_document key.
 * Source-scanned so a new type added later is caught without a test edit.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../src');
const LOCALES = path.resolve(__dirname, '../../../frontend/src/i18n/locales');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

function loggedDocumentTypes() {
  const types = new Set();
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    // The first argument only (a literal, or a ternary of two).
    for (const m of text.matchAll(/logActivity\(\s*([^,]+),/g)) {
      for (const lit of m[1].matchAll(/'(customer_document_[a-z_]+)'/g)) types.add(lit[1]);
    }
  }
  return [...types].sort();
}

const camel = (type) => type.replace(/_(\w)/g, (_m, c) => c.toUpperCase());

describe('customer document activity labels', () => {
  const types = loggedDocumentTypes();

  it('finds the logged types', () => {
    expect(types).toEqual(expect.arrayContaining([
      'customer_document_uploaded', 'customer_document_shared', 'customer_document_unshared',
      'customer_document_reviewed', 'customer_document_linked', 'customer_document_deleted',
      'customer_document_downloaded', 'customer_document_scan_rejected',
      'customer_document_request_created', 'customer_document_request_reminded',
    ]));
  });

  for (const lang of ['en', 'de']) {
    it(`labels every one in ${lang}`, () => {
      const locale = JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'));
      const missing = [];
      for (const type of types) {
        if (typeof locale.admin?.activities?.[type] !== 'string') missing.push(`admin.activities.${type}`);
        if (typeof locale.admin?.notificationMessages?.[camel(type)] !== 'string') {
          missing.push(`admin.notificationMessages.${camel(type)}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
