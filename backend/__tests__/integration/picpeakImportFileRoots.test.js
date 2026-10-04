'use strict';

// The importer copied every regular file under an archive's files/ tree to
// the same relative live path, so a crafted .picpeak could plant
// files/fonts/payload.html + payload.js under STORAGE_PATH/fonts, which the
// /fonts mount served from the app origin. Only the storage subtrees the
// exporter writes are accepted, and never active web content.
// Scanner finding 8265db38.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const StreamZip = require('node-stream-zip');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

let db;
let cleanup;
let createPicpeak;
let importFromPicpeak;
let importFilePathProblem;
let adminId;

async function getMarker() {
  const row = await db('app_settings').where({ setting_key: 'fileroots_marker' }).first();
  return row ? decodeSettingValue(db, row.setting_value) : null;
}
async function setMarker(value) {
  await db('app_settings')
    .insert({ setting_key: 'fileroots_marker', setting_value: JSON.stringify(value), setting_type: 'string' })
    .onConflict('setting_key').merge();
}

// Re-zip a genuine export with extra entries added.
async function withExtraEntries(sourcePath, extras) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-fileroots-'));
  const outPath = path.join(outDir, 'poisoned.picpeak');
  const zip = new StreamZip.async({ file: sourcePath });
  try {
    const entries = Object.values(await zip.entries());
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outPath);
      const archive = archiver('zip');
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      (async () => {
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          archive.append(await zip.stream(entry.name), { name: entry.name });
        }
        for (const [name, content] of Object.entries(extras)) archive.append(content, { name });
        archive.finalize();
      })().catch(reject);
    });
  } finally {
    await zip.close();
  }
  return outPath;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  // A genuine business document so the legitimate archive carries a files/ tree.
  const docDir = path.join(process.env.STORAGE_PATH, 'business-docs');
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, 'invoice-1.pdf'), '%PDF-1.4 fixture');
  const logoDir = path.join(process.env.STORAGE_PATH, 'uploads', 'logos');
  fs.mkdirSync(logoDir, { recursive: true });
  fs.writeFileSync(path.join(logoDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak, importFilePathProblem } = require('../../src/services/picpeakImportService'));
}, 120000);

afterAll(async () => {
  await cleanup();
});

describe('.picpeak import — files/ roots and content types', () => {
  it('refuses an archive that plants HTML and JavaScript under fonts/, before touching live state', async () => {
    await setMarker('in_backup');
    const { filePath } = await createPicpeak({ includePhotos: false });
    await setMarker('current');
    const poisoned = await withExtraEntries(filePath, {
      'files/fonts/payload.html': '<script src="/fonts/payload.js"></script>',
      'files/fonts/payload.js': 'document.cookie',
    });
    try {
      await expect(importFromPicpeak({ picpeakPath: poisoned, currentAdminId: adminId }))
        .rejects.toMatchObject({
          statusCode: 400,
          code: 'UNSUPPORTED_ARCHIVE_FILE',
          message: expect.stringMatching(/files\/fonts\/payload\.(html|js)/),
        });
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
      fs.rmSync(path.dirname(poisoned), { recursive: true, force: true });
    }
    expect(await getMarker()).toBe('current');
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'fonts', 'payload.html'))).toBe(false);
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'fonts', 'payload.js'))).toBe(false);
  });

  it('refuses active content even inside an exported folder', async () => {
    await setMarker('in_backup');
    const { filePath } = await createPicpeak({ includePhotos: false });
    await setMarker('current');
    const poisoned = await withExtraEntries(filePath, {
      'files/uploads/logos/logo.HTML': '<script>1</script>',
    });
    try {
      await expect(importFromPicpeak({ picpeakPath: poisoned, currentAdminId: adminId }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/active web content/) });
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
      fs.rmSync(path.dirname(poisoned), { recursive: true, force: true });
    }
    expect(await getMarker()).toBe('current');
  });

  it('imports a genuine export whose transfer attachments are named like web content', async () => {
    // The exporter takes all of uploads/, and a transfer keeps the client's
    // filename; those objects are attachments, never served as pages.
    await setMarker('in_backup');
    const { filePath } = await createPicpeak({ includePhotos: false });
    await setMarker('current');
    const withTransfer = await withExtraEntries(filePath, {
      'files/uploads/transfers/7/payload.js': 'console.log(1)',
      'files/uploads/transfers/7/page.html': '<p>client file</p>',
    });
    try {
      await importFromPicpeak({ picpeakPath: withTransfer, currentAdminId: adminId });
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
      fs.rmSync(path.dirname(withTransfer), { recursive: true, force: true });
    }
    expect(await getMarker()).toBe('in_backup');
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'uploads', 'transfers', '7', 'payload.js'))).toBe(true);
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'uploads', 'transfers', '7', 'page.html'))).toBe(true);
  });

  it('still imports a genuine export with business documents and an SVG logo', async () => {
    await setMarker('in_backup');
    const { filePath } = await createPicpeak({ includePhotos: false });
    await setMarker('current');
    fs.rmSync(path.join(process.env.STORAGE_PATH, 'business-docs', 'invoice-1.pdf'));
    try {
      const result = await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId });
      expect(result.restored).toBe(true);
      expect(result.filesRestored).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
    expect(await getMarker()).toBe('in_backup');
    expect(fs.readFileSync(path.join(process.env.STORAGE_PATH, 'business-docs', 'invoice-1.pdf'), 'utf8')).toBe('%PDF-1.4 fixture');
  });
});

describe('importFilePathProblem', () => {
  it.each([
    'business-docs/invoice-1.pdf',
    'business-docs/legacy/invoice-1.pdf',
    'uploads/logos/logo.svg',
    'uploads/contracts/signed/c-1.pdf',
    'events/active/wedding/individual/a.jpg',
    'events/archived/old.zip',
    // Attachment-only trees keep whatever name the client gave the file.
    'uploads/transfers/12/payload.js',
    'uploads/transfers/12/page.html',
    'uploads/contracts/signed/notes.htm',
    'business-docs/inbound/report.html',
    'events/active/wedding/script.mjs',
  ])('accepts %s', (rel) => {
    expect(importFilePathProblem(rel)).toBeNull();
  });

  it.each([
    ['fonts/Inter/400.woff2', /not under an exported storage folder/],
    ['fonts/payload.html', /not under an exported storage folder/],
    ['thumbnails/x.jpg', /not under an exported storage folder/],
    ['events/x.jpg', /not under an exported storage folder/],
    ['events/active', /not under an exported storage folder/],
    ['uploads', /not under an exported storage folder/],
    ['uploads-evil/x.jpg', /not under an exported storage folder/],
    ['uploads/logos/x.html', /active web content/],
    ['uploads/logos/x.htm', /active web content/],
    ['uploads/logos/x.xhtml', /active web content/],
    ['uploads/logos/x.shtml', /active web content/],
    ['uploads/logos/x.js', /active web content/],
    ['uploads/logos/x.mjs', /active web content/],
    ['uploads/favicons/x.html', /active web content/],
    ['uploads/favicons/deep/x.js', /active web content/],
    ['uploads/Logos/x.HTML', /active web content/],
    ['business-docs/../fonts/x.woff2', /malformed/],
    ['uploads//x.jpg', /malformed/],
  ])('refuses %s', (rel, reason) => {
    expect(importFilePathProblem(rel)).toMatch(reason);
  });
});
