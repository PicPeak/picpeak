const fs = require('fs');
const path = require('path');

const {
  EXTENSION_TO_MIME,
  extensionsToMimeTypes,
} = require('../../src/services/uploadSettings');
const { validateFileType, ALLOWED_MEDIA_TYPES } = require('../../src/utils/fileSecurityUtils');

// Every format the browser types badly or not at all: the RAW set, plus HEIC
// and HEIF. These are the entries most likely to be dropped by an accidental
// map edit, because none of them is in DEFAULT_ALLOWED_FILE_TYPES and so none
// is covered by the default-path tests.
const RAW_AND_HEIF_TYPES = {
  heic: 'image/heic',
  heif: 'image/heif',
  dng: 'image/x-adobe-dng',
  arw: 'image/x-sony-arw',
  sr2: 'image/x-sony-sr2',
  srf: 'image/x-sony-srf',
  cr2: 'image/x-canon-cr2',
  nef: 'image/x-nikon-nef',
  nrw: 'image/x-nikon-nrw',
  orf: 'image/x-olympus-orf',
  pef: 'image/x-pentax-pef',
  srw: 'image/x-samsung-srw',
};

function getFrontendExtensionMap() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../../frontend/src/utils/fileTypes.ts'),
    'utf8'
  );
  const match = source.match(/const EXTENSION_TO_MIME[^=]*= \{([\s\S]*?)\n\};/);
  if (!match) throw new Error('Could not find frontend EXTENSION_TO_MIME');

  // Parse `key: 'mime',` entries — quoted keys and trailing `//` comments are
  // tolerated; any other non-blank, non-comment line inside the map is a parse
  // failure, so a syntax the parser can't read fails loudly instead of silently
  // dropping the entry from the comparison.
  const entries = [];
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const entry = trimmed.match(/^'?(\w+)'?\s*:\s*'([^']+)'\s*,?\s*(?:\/\/.*)?$/);
    if (!entry) throw new Error(`Unparsable EXTENSION_TO_MIME line in frontend fileTypes.ts: "${trimmed}"`);
    entries.push([entry[1], entry[2]]);
  }
  return Object.fromEntries(entries);
}

describe('configured upload file types', () => {
  test('supports configured RAW, HEIC, and HEIF uploads', () => {
    const extensions = Object.keys(RAW_AND_HEIF_TYPES);
    expect(extensionsToMimeTypes(extensions.join(','))).toEqual(Object.values(RAW_AND_HEIF_TYPES));

    for (const [extension, mimeType] of Object.entries(RAW_AND_HEIF_TYPES)) {
      expect(validateFileType(`image.${extension}`, mimeType, [mimeType])).toBe(true);
    }
  });

  test('every extension in the map resolves to a type the validator knows', () => {
    // The two tables are separate by design — uploadSettings decides what an
    // admin may configure, fileSecurityUtils decides what the bytes must look
    // like — so nothing but this stops an extension being configurable and
    // then rejected at the gate.
    for (const [extension, mimeType] of Object.entries(EXTENSION_TO_MIME)) {
      const typeConfig = ALLOWED_MEDIA_TYPES[mimeType];
      expect(typeConfig).toBeDefined();
      expect(typeConfig.extensions).toContain(`.${extension}`);
    }
  });

  test('uses the same extension-to-MIME map as the frontend', () => {
    expect(getFrontendExtensionMap()).toEqual(EXTENSION_TO_MIME);
  });
});
