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
 *   - macros and embedded code: vbaProject.bin / vbaData.xml, anything but a
 *     picture under word|xl|ppt/embeddings (an OLE .bin, a .docm, an .xlsm,
 *     another document), activeX parts, ODF Basic/ and Scripts/, ODF
 *     sub-documents under any directory, embedded-object, script and macro
 *     event elements — and macro-enabled main parts (docm/xlsm renamed
 *     .docx), OLE/package/control/externalLink relationships and content
 *     types, and Word fields that run a program or load a file (DDE,
 *     DDEAUTO, INCLUDETEXT, INCLUDEPICTURE, QUOTE character codes)
 *   - an ODF xlink:href in content.xml or styles.xml that points outside the
 *     package (http:, https:, file:, ftp:, a network, parent or absolute path)
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
  // A Word part read for its fields: the body of a long document is larger
  // than the package parts above.
  maxWordPartBytes: 32 * 1024 * 1024,
  // txt / csv when the caller passes no cap (the upload limit's default).
  maxTextBytes: 25 * 1024 * 1024,
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
  /^(word|xl|ppt)\/activeX\//i,
  /^Basic\//,
  /^Scripts\//,
  // ODF embedded sub-documents ("Object 1/content.xml"): another document,
  // with its own macros and links, that nothing here inspects.
  /^Object \d+\//,
];

// OOXML embeddings may be pictures; anything else in there — an OLE .bin,
// a .docm or .xlsm, another .docx — is a document inside the document, and
// only its container was checked.
const EMBEDDINGS = /^(word|xl|ppt)\/embeddings\//i;
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|emf|wmf|tiff?|svg)$/i;
// A picture's name is only a name: an OLE compound file or a zip (another
// package) behind it is an object.
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
// ODF: the parts that make a directory a (sub-)document, and the elements
// that embed an object, a script or a macro binding.
const ODF_DOCUMENT_PART = /(^|\/)(content|styles|meta|settings)\.xml$/i;
const ODF_ACTIVE_ELEMENT = new Set(['object', 'object-ole', 'applet', 'plugin', 'script', 'event-listener']);
// Word: every XML part may hold fields — Word finds headers, footers and
// notes through relationships, not by path — except the package's own
// bookkeeping. Field names refused: DDE/DDEAUTO start another program,
// INCLUDETEXT/INCLUDEPICTURE/IMPORT/LINK load a file or URL, and QUOTE with
// character codes spells text out of numbers.
const WORD_SKIPPED_PART = /(^|\/)_rels\/|^\[Content_Types\]\.xml$|^docProps\/|^customXml\//i;
const ACTIVE_FIELD = /^\s*(DDE|DDEAUTO|INCLUDETEXT|INCLUDEPICTURE|IMPORT|LINK)\b|^\s*QUOTE\s+\d/i;
// Content types and relationship types of code and embedded objects.
const ACTIVE_TYPE = /macroEnabled|vbaProject|vbaData|activeX|oleObject|\.package\b/i;
const ACTIVE_RELATIONSHIP = /\/(oleObject|package|control|activeXControl\w*|vbaProject\w*|wordVbaData|keyMapCustomizations|externalLink)$/i;

// An ODF link that leaves the package: any URL scheme (not only http/file —
// vnd.sun.star.script: and macro: run code on click), a network path, an
// absolute path, or a parent-directory segment anywhere in it. Package-
// internal links ("Pictures/x", "./Object 1", "#bookmark") stay allowed.
const EXTERNAL_HREF = /^\s*([A-Za-z][A-Za-z0-9+.-]*:|\/|\\)|(^|[/\\])\.\.([/\\]|$)/;

// Attribute values as an XML consumer reads them: character references and
// the predefined entities decoded. Matching the raw text instead lets
// `TargetMode="&#69;xternal"` or `xlink:href="&#104;ttps://…"` through.
function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, ref) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[ref.toLowerCase()];
    if (named) return named;
    const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    try {
      return String.fromCodePoint(cp);
    } catch (_) {
      return whole;
    }
  });
}

/**
 * A part as tokens, read the way an XML parser reads it: comments and
 * processing instructions skipped whole, quoted values taken as one token, so
 * text inside a comment or another value can't hide a real attribute (or
 * fake one). A DTD is refused — OOXML and ODF parts have none, and entities
 * declared in one could spell any value — and so is anything malformed,
 * which no office suite reads either.
 *
 * Yields { kind: 'open', name, attrs: [{ name, value }] }, { kind: 'close',
 * name } and { kind: 'text', text }: names with their namespace prefix,
 * values and text decoded. Namespace declarations (xmlns, xmlns:x) are not
 * attributes and are left out, so `xmlns:TargetMode` can't stand in for
 * TargetMode.
 */
function* xmlTokens(xml) {
  const malformed = () => notValid('The document contains a part that is not well-formed XML');
  const attr = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')|\s*(\/?>)/y;
  const tagName = /[^\s/>]+/y;
  const skipTo = (end, from) => {
    const at = xml.indexOf(end, from);
    if (at < 0) throw malformed();
    return at + end.length;
  };
  let i = 0;
  for (;;) {
    const lt = xml.indexOf('<', i);
    if (lt > i || (lt < 0 && i < xml.length)) yield { kind: 'text', text: decodeXml(xml.slice(i, lt < 0 ? undefined : lt)) };
    if (lt < 0) return;
    if (xml.startsWith('<!--', lt)) { i = skipTo('-->', lt + 4); continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      i = skipTo(']]>', lt + 9);
      yield { kind: 'text', text: xml.slice(lt + 9, i - 3) };
      continue;
    }
    if (xml.startsWith('<?', lt)) { i = skipTo('?>', lt + 2); continue; }
    if (xml[lt + 1] === '!') throw notValid('The document contains a DTD, which office documents do not use');
    if (xml[lt + 1] === '/') {
      i = skipTo('>', lt + 2);
      yield { kind: 'close', name: xml.slice(lt + 2, i - 1).trim() };
      continue;
    }
    tagName.lastIndex = lt + 1;
    const element = tagName.exec(xml);
    if (!element) throw malformed();
    let j = tagName.lastIndex;
    const attrs = [];
    let selfClosing = false;
    for (;;) {
      attr.lastIndex = j;
      const m = attr.exec(xml);
      if (!m) throw malformed();
      j = attr.lastIndex;
      if (m[4]) { selfClosing = m[4] === '/>'; break; }
      const raw = m[2] !== undefined ? m[2] : m[3];
      if (raw.includes('<')) throw malformed();
      if (m[1] === 'xmlns' || m[1].startsWith('xmlns:')) continue;
      attrs.push({ name: m[1], value: decodeXml(raw) });
    }
    yield { kind: 'open', name: element[0], attrs };
    if (selfClosing) yield { kind: 'close', name: element[0] };
    i = j;
  }
}

/** Every start tag, as { name, attrs }. */
function* xmlElements(xml) {
  for (const t of xmlTokens(xml)) if (t.kind === 'open') yield t;
}

const localName = (name) => name.slice(name.indexOf(':') + 1).toLowerCase();

/**
 * An element's attribute exactly as named (unprefixed, as OOXML reads it),
 * or undefined. For a positive check: this is the value Office uses.
 */
const attrOf = (el, name) => {
  const a = el.attrs.find((x) => x.name === name);
  return a ? a.value : undefined;
};

/**
 * Every value of an attribute with this local name, under any prefix. For a
 * refusal: whichever one a reader takes, all of them were checked.
 */
const attrsOf = (el, name) => el.attrs
  .filter((x) => localName(x.name) === name.toLowerCase())
  .map((x) => String(x.value).trim());

/**
 * Every field instruction in a WordprocessingML part, one string per field:
 * a complex field's instrText runs joined between its begin and its
 * separate/end, a simple field's instr attribute on its own. A field whose
 * name is itself a nested field (`{ {QUOTE 68 68 69} … }`, `{ {IF …} … }`)
 * is computed when Word updates it, so it can't be checked and is refused.
 */
function fieldInstructions(xml) {
  const done = [];
  const stack = [];
  let loose = '';
  let inInstr = 0;
  for (const t of xmlTokens(xml)) {
    if (t.kind === 'open') {
      const name = localName(t.name);
      if (name === 'fldsimple') done.push(...attrsOf(t, 'instr'));
      else if (name === 'instrtext') inInstr += 1;
      else if (name === 'fldchar') {
        const type = (attrsOf(t, 'fldCharType')[0] || '').toLowerCase();
        if (type === 'begin') {
          const outer = stack[stack.length - 1];
          if (outer && !outer.closed && outer.instr.trim() === '') {
            throw active('The document contains a field whose type is computed');
          }
          stack.push({ instr: '', closed: false });
        } else if (type === 'separate' && stack.length) {
          stack[stack.length - 1].closed = true;
        } else if (type === 'end' && stack.length) {
          done.push(stack.pop().instr);
        }
      }
    } else if (t.kind === 'close') {
      if (localName(t.name) === 'instrtext' && inInstr > 0) inInstr -= 1;
    } else if (inInstr > 0) {
      const top = stack[stack.length - 1];
      if (top && !top.closed) top.instr += t.text;
      else loose += t.text;
    }
  }
  // Unterminated fields and instrText outside any field are checked too.
  return [...done, ...stack.map((f) => f.instr), loose];
}

/** The first `n` bytes of an entry, without inflating the rest. */
async function readHead(zip, name, n) {
  const stream = await zip.stream(name);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, n);
}

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
  return decodeText(Buffer.concat(chunks));
}

// Encodings whose bytes spell ASCII the way UTF-8 does, so the checks below
// see every attribute an XML consumer sees.
const ASCII_COMPATIBLE = /^(utf-?8|us-ascii|ascii|iso-8859-\d+|latin-?1|windows-125\d)$/i;

/**
 * A part as text, decoded the way an XML consumer would: UTF-16 by its BOM,
 * UTF-8 otherwise. Anything else — UTF-16 without a BOM, UTF-32, UTF-7,
 * EBCDIC — is refused, because read as UTF-8 it hides its attributes from
 * the checks while Office reads them fine.
 */
function decodeText(buf) {
  let text;
  if (buf.length >= 4 && (buf.readUInt32LE(0) === 0x0000feff || buf.readUInt32BE(0) === 0x0000feff)) {
    throw notValid('The document uses a text encoding that cannot be checked');
  } else if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le');
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2));
    if (le.length % 2) throw notValid('The document uses a text encoding that cannot be checked');
    le.swap16();
    text = le.toString('utf16le');
  } else {
    text = buf.toString('utf8');
    const declared = text.match(/^\uFEFF?\s*<\?xml[^>]*?\bencoding\s*=\s*["']([^"']*)["']/);
    if (declared && !ASCII_COMPATIBLE.test(declared[1].trim())) {
      throw notValid('The document uses a text encoding that cannot be checked');
    }
  }
  if (text.includes('\0')) throw notValid('The document uses a text encoding that cannot be checked');
  return text;
}

/**
 * The zip signature at byte 0, and the name of the FIRST entry in the file
 * (the first local header) — the real order, which ODF's "mimetype comes
 * first" rule is about. The reader's entry map is an object, and an object
 * puts integer-like keys ("0") before every other key whatever the archive
 * order was.
 */
async function readFirstEntry(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(30);
    const { bytesRead } = await fh.read(head, 0, 30, 0);
    if (bytesRead < 30 || head.readUInt32LE(0) !== 0x04034b50) return { zip: false, firstName: null };
    const nameLength = head.readUInt16LE(26);
    const name = Buffer.alloc(nameLength);
    await fh.read(name, 0, nameLength, 30);
    return { zip: true, firstName: name.toString('utf8') };
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
  const first = await readFirstEntry(file);
  if (!first.zip) throw notValid('The file is not a valid document of this type');

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
      if (EMBEDDINGS.test(name) && !entry.isDirectory && !IMAGE_EXT.test(name)) {
        throw active('The document contains an embedded document');
      }
      if (!entry.isDirectory) declared += Number(entry.size) || 0;
      if (declared > lim.maxExpandedBytes) throw tooComplex('The document expands to more than can be checked');
    }

    if (OOXML_MAIN[format]) {
      if (!entries['[Content_Types].xml']) throw notValid('The file is not a valid document of this type');
      const types = [...xmlElements(await readPart(zip, '[Content_Types].xml', lim.maxPartBytes))];
      const main = OOXML_MAIN[format];
      const typeFor = (el) => String(attrOf(el, 'ContentType') || '').trim();
      const kind = (el) => localName(el.name);
      if (types.some((el) => ['default', 'override'].includes(kind(el))
        && attrsOf(el, 'ContentType').some((type) => ACTIVE_TYPE.test(type)))) {
        throw active('Macro-enabled documents and embedded objects cannot be uploaded');
      }
      const mainOverrides = types.filter((el) => kind(el) === 'override'
        && String(attrOf(el, 'PartName') || '').trim().toLowerCase() === main.part.toLowerCase());
      if (mainOverrides.length !== 1 || typeFor(mainOverrides[0]) !== main.type) {
        throw notValid('The file is not a valid document of this type');
      }
      // A part under embeddings/ declared as anything but a picture is an
      // object, whatever its file name says (object1.png typed oleObject).
      const defaults = new Map(types.filter((el) => kind(el) === 'default')
        .map((el) => [String(attrOf(el, 'Extension') || '').trim().toLowerCase(), typeFor(el)]));
      const overrides = new Map(types.filter((el) => kind(el) === 'override')
        .map((el) => [String(attrOf(el, 'PartName') || '').trim().toLowerCase(), typeFor(el)]));
      for (const name of names) {
        if (!EMBEDDINGS.test(name) || entries[name].isDirectory) continue;
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
        const declaredType = overrides.get(`/${name}`.toLowerCase()) ?? defaults.get(ext) ?? '';
        if (!/^image\//i.test(declaredType)) throw active('The document contains an embedded document');
        const head = await readHead(zip, name, 8);
        if (OLE_MAGIC.equals(head.subarray(0, 8)) || head.subarray(0, 4).equals(ZIP_MAGIC)) {
          throw active('The document contains an embedded document');
        }
      }
      for (const name of names) {
        if (!/\.rels$/i.test(name) || entries[name].isDirectory) continue;
        for (const el of xmlElements(await readPart(zip, name, lim.maxPartBytes))) {
          if (localName(el.name) !== 'relationship') continue;
          if (attrsOf(el, 'TargetMode').some((mode) => mode.toLowerCase() === 'external')) {
            throw active('The document links to external content (such as a remote template) and cannot be uploaded');
          }
          if (attrsOf(el, 'Type').some((type) => ACTIVE_RELATIONSHIP.test(type))) {
            throw active('The document contains macros or embedded objects');
          }
        }
      }
      // Word fields that run a program or fetch content (ACTIVE_FIELD).
      for (const name of names) {
        if (format !== 'docx' || !/\.xml$/i.test(name) || WORD_SKIPPED_PART.test(name) || entries[name].isDirectory) continue;
        const fields = fieldInstructions(await readPart(zip, name, lim.maxWordPartBytes));
        if (fields.some((instr) => ACTIVE_FIELD.test(instr))) {
          throw active('The document contains fields that run programs or load outside content');
        }
      }
    } else {
      if (first.firstName !== 'mimetype' || !entries.mimetype || entries.mimetype.isDirectory) {
        throw notValid('The file is not a valid document of this type');
      }
      const mimetype = (await readPart(zip, 'mimetype', 256)).trim();
      if (mimetype !== ODF_MIMETYPE[format]) throw notValid('The file is not a valid document of this type');
      // A sub-document can live under any directory name, not only
      // "Object N/": its own content.xml is one that nothing here reads.
      for (const name of names) {
        if (name.includes('/') && !name.startsWith('META-INF/') && ODF_DOCUMENT_PART.test(name)) {
          throw active('The document contains an embedded document');
        }
      }
      for (const part of ['content.xml', 'styles.xml']) {
        if (!entries[part] || entries[part].isDirectory) continue;
        for (const el of xmlElements(await readPart(zip, part, lim.maxPartBytes))) {
          if (ODF_ACTIVE_ELEMENT.has(localName(el.name))) {
            throw active('The document contains embedded objects, scripts or macro bindings');
          }
          for (const a of el.attrs) {
            if (localName(a.name) !== 'href') continue;
            const href = a.value;
            if (EXTERNAL_HREF.test(href) || EXTERNAL_HREF.test(href.replace(/%2e/gi, '.').replace(/%2f/gi, '/').replace(/%5c/gi, '\\'))) {
              throw active('The document links to external content and cannot be uploaded');
            }
          }
        }
      }
      if (entries['META-INF/manifest.xml']) {
        for (const el of xmlElements(await readPart(zip, 'META-INF/manifest.xml', lim.maxPartBytes))) {
          if (localName(el.name) === 'encryption-data') {
            throw new InspectError('Password-protected documents cannot be uploaded', 'DOCUMENT_ENCRYPTED');
          }
          if (localName(el.name) !== 'file-entry') continue;
          const embedded = attrsOf(el, 'media-type')
            .some((type) => /^application\/vnd\.(oasis\.opendocument|sun\.xml\.(writer|calc|draw|impress|math))/i.test(type));
          if (embedded && attrsOf(el, 'full-path').some((p) => p !== '/')) {
            throw active('The document contains an embedded document');
          }
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
  // Streamed, and never more than the cap read: the file is not held in
  // memory whole, and a file larger than allowed stops being read.
  const cap = limits.maxBytes || DEFAULTS.maxTextBytes;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > cap) throw tooComplex('The file is too large');
      if (chunk.includes(0)) throw new InspectError('The file is not a text file', 'DOCUMENT_NOT_TEXT');
      try {
        decoder.decode(chunk, { stream: true });
      } catch (_) {
        throw new InspectError('The file is not UTF-8 text', 'DOCUMENT_NOT_TEXT');
      }
    }
    try {
      decoder.decode();
    } catch (_) {
      throw new InspectError('The file is not UTF-8 text', 'DOCUMENT_NOT_TEXT');
    }
  } finally {
    stream.destroy();
  }
  return { bytes };
}

module.exports = { inspectOffice, inspectText, InspectError, DEFAULTS, _internal: { OOXML_MAIN, ODF_MIMETYPE } };
