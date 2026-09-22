'use strict';

/**
 * Content checks for the office formats customers may upload (#1444, plan
 * slice 7): OOXML (docx, xlsx) and ODF (odt, ods). All four are zip
 * containers; the checks read the directory and a few small XML parts and
 * never inflate anything else.
 *
 * Refused:
 *   - not a zip from its first byte (so a `%PDF-` prefix glued to a zip, or
 *     any other polyglot, fails here even though zip readers would accept it)
 *   - more entries or more declared bytes than the budget (decompression
 *     bomb), entry names that escape the archive root, encrypted entries
 *   - the wrong document type for the extension: OOXML must declare the
 *     expected main part in [Content_Types].xml, ODF must start with a
 *     `mimetype` entry holding the expected value
 *   - macros and embedded code: vbaProject.bin / vbaData.xml, *.bin under
 *     word/embeddings or xl/embeddings, activeX parts, ODF Basic/ and
 *     Scripts/ — and macro-enabled main parts (docm/xlsm renamed .docx)
 *   - any relationship with TargetMode="External": remote-template injection
 *     loads code from a URL named in the rels. This refuses documents with
 *     plain external hyperlinks too; see the note in documentFormats.js.
 *   - ODF documents encrypted with a password (manifest encryption-data)
 *
 * Run through officeValidation (a worker with heap, time and concurrency
 * budgets), not directly in the server process.
 */

const fs = require('fs');
const path = require('path');
const StreamZip = require('node-stream-zip');

const DEFAULTS = {
  maxEntries: 2000,
  maxExpandedBytes: 200 * 1024 * 1024,
  // Budget for the few XML parts actually read.
  maxPartBytes: 4 * 1024 * 1024,
};

const OOXML_MAIN = {
  docx: { part: '/word/document.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
  xlsx: { part: '/xl/workbook.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
};
const ODF_MIMETYPE = {
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

class InspectError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.statusCode = 400;
  }
}
const notValid = (msg) => new InspectError(msg, 'DOCUMENT_NOT_VALID');
const active = (msg) => new InspectError(msg, 'DOCUMENT_ACTIVE_CONTENT');
const tooComplex = (msg) => new InspectError(msg, 'DOCUMENT_TOO_COMPLEX');

const ACTIVE_ENTRY = [
  /(^|\/)vbaProject\.bin$/i,
  /(^|\/)vbaData\.xml$/i,
  /^(word|xl|ppt)\/embeddings\/.*\.bin$/i,
  /^(word|xl|ppt)\/activeX\//i,
  /^Basic\//,
  /^Scripts\//,
];

async function readPart(zip, name, limit) {
  const stream = await zip.stream(name);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy();
      throw tooComplex('A part of the document is too large to check');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startsWithZipSignature(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } finally {
    await fh.close();
  }
}

/**
 * @param {string} file     local path of the upload
 * @param {'docx'|'xlsx'|'odt'|'ods'} format
 */
async function inspectOffice(file, format, limits = {}) {
  const lim = { ...DEFAULTS, ...limits };
  if (!OOXML_MAIN[format] && !ODF_MIMETYPE[format]) throw notValid('Unsupported format');
  if (!(await startsWithZipSignature(file))) throw notValid('The file is not a valid document of this type');

  let zip;
  try {
    zip = new StreamZip.async({ file, storeEntries: true });
    let entries;
    try {
      entries = await zip.entries();
    } catch (_) {
      throw notValid('The file is not a valid document of this type');
    }
    const names = Object.keys(entries);
    if (names.length > lim.maxEntries) throw tooComplex('The document has too many parts to check');
    let declared = 0;
    const root = path.resolve('/document-root');
    for (const name of names) {
      const entry = entries[name];
      if (entry.encrypted) throw new InspectError('Password-protected documents cannot be uploaded', 'DOCUMENT_ENCRYPTED');
      if (name.includes('\0') || path.isAbsolute(name) || !path.resolve(root, name).startsWith(`${root}${path.sep}`)) {
        throw notValid('The document contains an invalid part name');
      }
      if (ACTIVE_ENTRY.some((re) => re.test(name))) {
        throw active('The document contains macros or embedded code');
      }
      if (!entry.isDirectory) declared += Number(entry.size) || 0;
      if (declared > lim.maxExpandedBytes) throw tooComplex('The document expands to more than can be checked');
    }

    if (OOXML_MAIN[format]) {
      if (!entries['[Content_Types].xml']) throw notValid('The file is not a valid document of this type');
      const types = await readPart(zip, '[Content_Types].xml', lim.maxPartBytes);
      if (/macroEnabled/i.test(types)) throw active('Macro-enabled documents cannot be uploaded');
      const main = OOXML_MAIN[format];
      const override = new RegExp(
        `<Override\\b[^>]*PartName="${main.part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"[^>]*>`, 'i',
      );
      const match = types.match(override);
      if (!match || !match[0].includes(`ContentType="${main.type}"`)) {
        throw notValid('The file is not a valid document of this type');
      }
      for (const name of names) {
        if (!/\.rels$/i.test(name) || entries[name].isDirectory) continue;
        const rels = await readPart(zip, name, lim.maxPartBytes);
        if (/TargetMode\s*=\s*["']External["']/i.test(rels)) {
          throw active('The document links to external content (such as a remote template) and cannot be uploaded');
        }
      }
    } else {
      if (names[0] !== 'mimetype' || entries.mimetype.isDirectory) {
        throw notValid('The file is not a valid document of this type');
      }
      const mimetype = (await readPart(zip, 'mimetype', 256)).trim();
      if (mimetype !== ODF_MIMETYPE[format]) throw notValid('The file is not a valid document of this type');
      if (entries['META-INF/manifest.xml']) {
        const manifest = await readPart(zip, 'META-INF/manifest.xml', lim.maxPartBytes);
        if (/encryption-data/i.test(manifest)) {
          throw new InspectError('Password-protected documents cannot be uploaded', 'DOCUMENT_ENCRYPTED');
        }
      }
    }
    return { entries: names.length, expandedBytes: declared };
  } finally {
    if (zip) await zip.close().catch(() => {});
  }
}

/**
 * txt / csv: valid UTF-8 (a BOM is fine), no NUL bytes. Stored verbatim and
 * always served as an attachment; a CSV that starts a cell with `=` is a
 * formula for whoever opens it in a spreadsheet — documented, not rewritten.
 */
async function inspectText(file, limits = {}) {
  const buf = await fs.promises.readFile(file);
  if (limits.maxBytes && buf.length > limits.maxBytes) throw tooComplex('The file is too large');
  if (buf.includes(0)) throw new InspectError('The file is not a text file', 'DOCUMENT_NOT_TEXT');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    throw new InspectError('The file is not UTF-8 text', 'DOCUMENT_NOT_TEXT');
  }
  return { bytes: buf.length };
}

module.exports = { inspectOffice, inspectText, InspectError, DEFAULTS, _internal: { OOXML_MAIN, ODF_MIMETYPE } };
