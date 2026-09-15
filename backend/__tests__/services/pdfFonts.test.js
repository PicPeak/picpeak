/**
 * PDF fonts (#1445): regular, bold and italic faces, and the fallbacks.
 */

const path = require('path');
const fonts = require('../../src/services/pdf/fonts');

test('a bundled family with an italic file uses it for italic text', () => {
  const files = fonts.resolveFontFiles({ fontFamily: 'Jost' });
  expect(path.basename(files.body)).toBe('400.ttf');
  expect(path.basename(files.bold)).toBe('700.ttf');
  expect(path.basename(files.italic)).toBe('400i.ttf');
});

test('a family without an italic file uses its upright regular', () => {
  const files = fonts.resolveFontFiles({ fontFamily: 'Inter' });
  expect(files).not.toBeNull();
  expect(files.italic).toBe(files.body);
});

test('no family, or an unknown one, means Helvetica', () => {
  expect(fonts.resolveFontFiles({})).toBeNull();
  expect(fonts.resolveFontFiles({ fontFamily: 'NoSuchFamily' })).toBeNull();
});

test('a family name cannot leave the fonts directory', () => {
  expect(fonts.resolveFontFiles({ fontFamily: '../../../etc' })).toBeNull();
});

test('registerFonts registers the three faces under stable names', () => {
  const registered = [];
  const doc = { registerFont: (name, file) => registered.push([name, path.basename(file)]) };
  expect(fonts.registerFonts(doc, { fontFamily: 'Jost' })).toEqual({
    body: 'crm-body', bold: 'crm-bold', italic: 'crm-italic',
  });
  expect(registered).toEqual([['crm-body', '400.ttf'], ['crm-bold', '700.ttf'], ['crm-italic', '400i.ttf']]);
});

test('registerFonts returns null for Helvetica', () => {
  expect(fonts.registerFonts({ registerFont: jest.fn() }, {})).toBeNull();
});

test('the italic files are not offered as families of their own', () => {
  const families = fonts.availableFamilies();
  expect(families).toContain('Jost');
  expect(families.every((f) => !/i\.ttf$/.test(f))).toBe(true);
});
