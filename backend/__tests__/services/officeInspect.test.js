/**
 * utils/officeInspect and its worker gate (#1444 slice 7, review round 1).
 * Crafted archives, built with archiver in memory and written to a temp dir.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');

const { inspectOffice, inspectText } = require('../../src/utils/officeInspect');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-inspect-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function zipFile(entries) {
  n += 1;
  const file = path.join(tmp, `f${n}.zip`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const archive = archiver('zip');
    out.on('close', () => resolve(file));
    archive.on('error', reject);
    archive.pipe(out);
    for (const [name, content, opts] of entries) archive.append(content, { name, ...(opts || {}) });
    archive.finalize();
  });
}

const CT = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const docx = (extra = []) => zipFile([
  ['[Content_Types].xml', CT],
  ['word/document.xml', '<w:document/>'],
  ...extra,
]);
const ODT = 'application/vnd.oasis.opendocument.text';
const odt = (extra = [], content = '<office:document-content/>') => zipFile([
  ['mimetype', ODT, { store: true }],
  ['content.xml', content],
  ...extra,
]);

const code = (p) => p.then(() => 'ok', (e) => e.code);

describe('OOXML embeddings', () => {
  it.each(['x.docm', 'x.xlsm', 'x.docx', 'oleObject1.bin', 'package.zip', 'script'])(
    'refuses word/embeddings/%s', async (leaf) => {
      expect(await code(inspectOffice(await docx([[`word/embeddings/${leaf}`, 'PK']]), 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    },
  );

  it('refuses one under xl/ and ppt/ too', async () => {
    expect(await code(inspectOffice(await docx([['xl/embeddings/Book1.xlsm', 'x']]), 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    expect(await code(inspectOffice(await docx([['ppt/embeddings/deck.pptm', 'x']]), 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it.each(['image1.png', 'image2.JPG', 'image3.jpeg', 'a.gif', 'b.bmp', 'c.emf', 'd.wmf', 'e.tif', 'f.tiff', 'g.svg'])(
    'allows a picture: %s', async (leaf) => {
      expect(await code(inspectOffice(await docx([[`word/embeddings/${leaf}`, 'img']]), 'docx'))).toBe('ok');
    },
  );
});

describe('OOXML external relationships', () => {
  const rels = (mode) => ['word/_rels/settings.xml.rels',
    `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode=${mode}/></Relationships>`];

  it.each(['"External"', "'External'", '"&#69;xternal"', '"&#x45;xternal"', '"Ext&#101;rnal"', '" External "'])(
    'refuses TargetMode=%s', async (mode) => {
      expect(await code(inspectOffice(await docx([rels(mode)]), 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    },
  );

  it('allows internal relationships', async () => {
    expect(await code(inspectOffice(await docx([rels('"Internal"')]), 'docx'))).toBe('ok');
  });
});

describe('ODF', () => {
  it('refuses an embedded sub-document (Object N/)', async () => {
    const file = await odt([['Object 1/content.xml', '<office:document-content/>']]);
    expect(await code(inspectOffice(file, 'odt'))).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it.each([
    'https://evil.example/t.ott', 'http://x', 'file:///etc/passwd', 'ftp://x/y', '../../secret.odt',
    '/etc/passwd', '//server/share/x', 'C:\\\\Windows\\\\x',
    '&#104;ttps://evil.example/t.ott', 'https&#x3a;//x', 'vnd.sun.star.script:Lib.Mod.run?language=Basic',
    'macro:///Standard.Module1.Main', 'smb://server/x', './../secret.odt', 'Pictures/%2e%2e/%2e%2e/x',
  ])('refuses an xlink:href to %s in content.xml', async (href) => {
    const content = `<office:document-content><text:a xlink:href="${href}">x</text:a></office:document-content>`;
    expect(await code(inspectOffice(await odt([], content), 'odt'))).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it('refuses an href under any prefix bound to xlink', async () => {
    const content = '<office:document-content xmlns:x="http://www.w3.org/1999/xlink"><text:a x:href="https://x">x</text:a></office:document-content>';
    expect(await code(inspectOffice(await odt([], content), 'odt'))).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it('refuses one in styles.xml too', async () => {
    const file = await odt([['styles.xml', '<office:document-styles><draw:image xlink:href=\'https://x/y.png\'/></office:document-styles>']]);
    expect(await code(inspectOffice(file, 'odt'))).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it('allows package-internal links', async () => {
    const content = '<office:document-content><draw:image xlink:href="Pictures/a.png"/><text:a xlink:href="#top">x</text:a></office:document-content>';
    expect(await code(inspectOffice(await odt([], content), 'odt'))).toBe('ok');
  });

  it('decides "mimetype first" by the archive order, not by the reader\'s key order', async () => {
    // An entry named "0" sorts first among an object's keys; mimetype is
    // still the first entry in the file, so this is a valid ODF package.
    const valid = await zipFile([['mimetype', ODT, { store: true }], ['0', 'x'], ['content.xml', '<x/>']]);
    expect(await code(inspectOffice(valid, 'odt'))).toBe('ok');
    // And mimetype not first in the file is refused, whatever the keys say.
    const second = await zipFile([['content.xml', '<x/>'], ['mimetype', ODT, { store: true }]]);
    expect(await code(inspectOffice(second, 'odt'))).toBe('DOCUMENT_NOT_VALID');
  });
});

describe('inspectText', () => {
  it('stops reading past the cap', async () => {
    const file = path.join(tmp, 'big.txt');
    fs.writeFileSync(file, 'a'.repeat(300 * 1024));
    expect(await code(inspectText(file, { maxBytes: 100 * 1024 }))).toBe('DOCUMENT_TOO_COMPLEX');
    expect(await code(inspectText(file, { maxBytes: 400 * 1024 }))).toBe('ok');
  });

  it('refuses UTF-8 cut in half at the end, and accepts a multibyte character split across chunks', async () => {
    const cut = path.join(tmp, 'cut.txt');
    fs.writeFileSync(cut, Buffer.from([0x61, 0xc3]));
    expect(await code(inspectText(cut))).toBe('DOCUMENT_NOT_TEXT');
    const split = path.join(tmp, 'split.txt');
    fs.writeFileSync(split, Buffer.concat([Buffer.alloc(64 * 1024 - 1, 0x61), Buffer.from('ä')]));
    expect(await code(inspectText(split))).toBe('ok');
  });
});

describe('officeValidation without a worker', () => {
  it('refuses rather than inspecting in the main thread', async () => {
    jest.resetModules();
    jest.doMock('worker_threads', () => ({ Worker: function NoWorker() { throw new Error('no workers here'); } }));
    const inspect = jest.fn();
    jest.doMock('../../src/utils/officeInspect', () => ({ inspectOffice: inspect }));
    const { validateOffice } = require('../../src/utils/officeValidation');
    const err = await validateOffice(await docx(), 'docx').catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('DOCUMENT_CHECK_UNAVAILABLE');
    expect(inspect).not.toHaveBeenCalled();
    jest.dontMock('worker_threads');
    jest.dontMock('../../src/utils/officeInspect');
  });
});
