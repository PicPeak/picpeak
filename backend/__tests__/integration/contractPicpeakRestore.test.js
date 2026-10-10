'use strict';

/**
 * Historical contracts survive a backup and restore (#1445, plan slice 11).
 *
 * A template with an attachment, a contract made from it and sent: export a
 * .picpeak, restore it into an emptied storage directory over a wiped
 * database, and the contract's stored PDF re-hashes to the sha256 recorded
 * for it, every attachment in its manifest re-hashes to the sha256 recorded
 * there, and the template version it was made from is still there with its
 * content hash. "Historical contracts remain reproducible", pinned.
 *
 * The storage directory is emptied in place, not swapped for one at another
 * path: generated documents record absolute paths, so a restore expects the
 * same STORAGE_PATH (the case for the Docker images, /app/storage).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
const { formatBoolean } = require('../../src/utils/dbCompat');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(180000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const execFileAsync = promisify(execFile);

async function checkTemplateInColdRuntime() {
  // Restore repairs execute in a real child, and every old application cache
  // must be retired at the restart barrier. A parent-process module spy cannot
  // observe that lifecycle. Start a fresh runtime with the actual Node lease
  // and durable coordinator before performing the normal startup check.
  const script = `
    const coordinator = require('./src/services/portableRestoreCoordinator');
    const work = require('./src/services/activeApplicationWork');
    const { db } = require('./src/database/db');
    (async () => {
      try {
        // What server.js does at boot: the committed restore left the fence
        // up, so this cold runtime recovers it before anything else starts.
        if (!(await coordinator.pendingAtBoot())) throw new Error('The committed restore left no fence for the next start');
        await coordinator.initialize();
        await coordinator.waitForStartupAdmission();
        await work.track('cold contract template startup', () =>
          require('./src/services/contract/defaultTemplate').ensureDefaultTemplate());
        const control = await db('portable_restore_control').where({ id: 1 }).first();
        const system = await db('contract_templates').where({ is_system: require('./src/utils/dbCompat').formatBoolean(true) }).first();
        const version = await db('contract_template_versions').where({ template_id: system.id, status: 'published' }).first();
        process.stdout.write('PICPEAK_COLD_TEMPLATE=' + JSON.stringify({
          instanceId: coordinator.instanceId(), ready: !coordinator.isFenced(),
          state: control.state, generation: control.generation, templateId: system.id,
          revision: version.system_revision, contentSha256: version.content_sha256,
        }) + '\\n');
      } finally {
        await coordinator.stop();
        await require('./src/services/serviceShutdown').stopServices();
        await db.destroy();
      }
    })().catch(error => { process.stderr.write(String(error.stack)); process.exitCode = 1; });
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--eval', script], {
    cwd: path.resolve(__dirname, '../..'), env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 60000, maxBuffer: 256 * 1024,
  });
  const line = stdout.split('\n').find(value => value.startsWith('PICPEAK_COLD_TEMPLATE='));
  expect(line).toBeDefined();
  return JSON.parse(line.slice('PICPEAK_COLD_TEMPLATE='.length));
}

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A stored file's bytes, wherever the row says it is (relative to storage, or absolute). */
function readStored(file) {
  return fs.readFileSync(path.isAbsolute(file) ? file : path.join(process.env.STORAGE_PATH, file));
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  for (const key of ['contracts', 'quotes']) {
    const updated = await db('feature_flags').where({ key }).update({ value: true });
    if (!updated) await db('feature_flags').insert({ key, value: true });
  }
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  const profile = await db('business_profile').where({ id: 1 }).first();
  const columns = { email: 'studio@example.com', company_name: 'Studio Test' };
  if (profile) await db('business_profile').where({ id: 1 }).update(columns);
  else await db('business_profile').insert({ id: 1, ...columns });
}, 180000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a sent contract, its attachments and its template version come back byte for byte from a .picpeak', async () => {
  const attachmentsApp = buildRouteApp('/api/admin/document-attachments', require('../../src/routes/adminDocumentAttachments'));
  const templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
  const contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));

  // An attachment merged into the PDF and one delivered separately.
  const pdf = async (pages, size) => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i += 1) doc.addPage(size);
    return Buffer.from(await doc.save());
  };
  const upload = async (buffer, name) => (await ok(request(attachmentsApp).post('/api/admin/document-attachments').set(auth)
    .field('name', name).attach('file', buffer, { filename: `${name}.pdf`, contentType: 'application/pdf' }))).attachment;
  const terms = await upload(await pdf(2, [300, 400]), 'AGB');
  const privacy = await upload(await pdf(1, [200, 200]), 'Datenschutz');

  // A template with both, published, made the default.
  const created = await ok(request(templatesApp).post('/api/admin/contract-templates').set(auth).send({ name: 'Mit Anhängen' }));
  const saved = await ok(request(templatesApp).put(`/api/admin/contract-templates/${created.template.id}/draft`).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [{ kind: 'text', section: 'scope', heading: 'Leistung', body: { de: 'Für {{customer_name}}.', en: 'For {{customer_name}}.' } }],
    attachments: [{ attachmentId: terms.id, delivery: 'merged' }, { attachmentId: privacy.id, delivery: 'separate' }],
  }));
  await ok(request(templatesApp).post(`/api/admin/contract-templates/${created.template.id}/publish`).set(auth)
    .send({ lockVersion: saved.template.lockVersion }));
  await ok(request(templatesApp).post(`/api/admin/contract-templates/${created.template.id}/default`).set(auth));

  // A contract from it, sent.
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth).send({ customerAccountId: customerId }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${contract.id}/send`).set(auth));

  const before = {
    contract: await db('contracts').where({ id: contract.id }).first(),
    document: await db('generated_documents').where({ doc_type: 'contract', doc_id: contract.id, kind: 'unsigned' }).first(),
    version: await db('contract_template_versions').where({ template_id: created.template.id, status: 'published' }).first(),
  };
  const manifest = parsed(before.document.manifest);
  expect(manifest.attachments.map((a) => a.delivery).sort()).toEqual(['merged', 'separate']);
  expect(sha256(readStored(before.document.path))).toBe(before.document.sha256);

  // Export, then restore into an empty storage directory over a wiped database.
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { importFromPicpeak } = require('../../src/services/picpeakImportService');
  const { filePath } = await createPicpeak({ includePhotos: false });
  const storage = process.env.STORAGE_PATH;
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-before-restore-'));
  try {
    // Nothing of the old storage stays: every file must come from the archive.
    fs.renameSync(path.join(storage, 'business-docs'), path.join(moved, 'business-docs'));
    for (const table of ['contract_attachment_inclusions', 'generated_documents', 'contract_block_inclusions',
      'contract_text_sections', 'contracts', 'contract_template_version_attachments', 'contract_template_version_items',
      'contract_template_versions', 'contract_templates', 'document_attachments']) {
      await db(table).del().catch(() => {});
    }
    const result = await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId });
    expect(result.restored).toBe(true);

    const restored = {
      contract: await db('contracts').where({ id: contract.id }).first(),
      document: await db('generated_documents').where({ id: before.document.id }).first(),
      version: await db('contract_template_versions').where({ id: before.version.id }).first(),
    };
    // The records are the same records…
    expect(restored.contract.rendered_content_sha256).toBe(before.contract.rendered_content_sha256);
    expect(restored.contract.pdf_sha256).toBe(before.contract.pdf_sha256);
    expect(restored.document.sha256).toBe(before.document.sha256);
    expect(restored.version.content_sha256).toBe(before.version.content_sha256);
    // …and the files behind them are the same bytes, read from the new storage.
    expect(path.isAbsolute(restored.document.path) ? restored.document.path.startsWith(storage) : true).toBe(true);
    expect(sha256(readStored(restored.document.path))).toBe(restored.document.sha256);
    for (const entry of parsed(restored.document.manifest).attachments) {
      const row = await db('document_attachments').where({ id: entry.attachmentId }).first();
      expect(sha256(readStored(row.storage_key))).toBe(entry.sha256);
    }
    // The frozen content still hashes to what the signature is bound to.
    const { canonicalSha256 } = require('../../src/utils/canonicalJson');
    expect(canonicalSha256(parsed(restored.contract.rendered_content))).toBe(restored.contract.rendered_content_sha256);
  } finally {
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('after a restore the retired PDF font path is moved and the standard template is checked again', async () => {
  const legacyDir = path.join(process.env.STORAGE_PATH, 'fonts');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../../assets/fonts/Jost/400.ttf'), path.join(legacyDir, 'restored.ttf'));
  const fontSha256 = sha256(fs.readFileSync(path.join(legacyDir, 'restored.ttf')));
  await db('business_profile').where({ id: 1 }).update({ pdf_font_ttf_path: 'fonts/restored.ttf' });
  // Prime the old process's template cache (also when this case runs alone).
  await require('../../src/services/contract/defaultTemplate').ensureDefaultTemplate();
  // Archive a system
  // template needing a startup repair, without deleting any historical/custom
  // version used by an issued contract or changing the user's chosen default.
  const system = await db('contract_templates').where({ is_system: formatBoolean(true) }).first();
  const systemVersions = await db('contract_template_versions').where({ template_id: system.id }).pluck('id');
  expect(await db('contracts').whereIn('template_version_id', systemVersions)).toHaveLength(0);
  const defaultBefore = await db('app_settings').where({ setting_key: 'crm_contracts_default_template_id' }).first();
  const historical = await db('contracts').whereNotNull('template_version_id').first();
  const historicalVersion = historical
    ? await db('contract_template_versions').where({ id: historical.template_version_id }).first() : null;
  await db('contract_template_version_attachments').whereIn('version_id', systemVersions).del();
  await db('contract_template_version_items').whereIn('version_id', systemVersions).del();
  await db('contract_template_versions').whereIn('id', systemVersions).del();
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { importFromPicpeak } = require('../../src/services/picpeakImportService');
  const { filePath } = await createPicpeak({ includePhotos: false });
  try {
    await db('business_profile').where({ id: 1 }).update({ pdf_font_ttf_path: null });
    const result = await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId });
    expect(result.restored).toBe(true);
    // Moved during the restore, not at the next restart.
    expect((await db('business_profile').where({ id: 1 }).first()).pdf_font_ttf_path).toBeNull();
    const font = await db('pdf_fonts').where({ display_name: 'Custom font (earlier setting)' }).first();
    expect(font).toBeTruthy();
    const fontFile = await db('pdf_font_files').where({ font_id: font.id, style: '400' }).first();
    expect(fontFile.sha256).toBe(fontSha256);
    expect(sha256(readStored(fontFile.storage_key))).toBe(fontSha256);
    const beforeRestart = await db('portable_restore_control').where({ id: 1 }).first();
    expect(beforeRestart.state).toBe('restart_required');
    const cold = await checkTemplateInColdRuntime();
    expect(cold).toMatchObject({ ready: true, state: 'open', generation: beforeRestart.generation,
      templateId: system.id, revision: require('../../src/services/contract/defaultTemplate').SYSTEM_TEMPLATE_REVISION });
    expect(cold.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const restartedInstance = await db('portable_restore_instances').where({ instance_id: cold.instanceId,
      generation: cold.generation, startup_ready_epoch: beforeRestart.epoch }).first();
    expect(restartedInstance).toBeTruthy();
    expect(cold.instanceId).not.toBe(beforeRestart.owner_instance_id);
    const lease = parsed(restartedInstance.lease_json);
    expect(await require('../../src/services/linuxKernelLease').probe(lease.path, lease)).toBe('free');
    expect((await db('app_settings').where({ setting_key: 'crm_contracts_default_template_id' }).first()).setting_value)
      .toBe(defaultBefore.setting_value);
    if (historicalVersion) {
      expect((await db('contract_template_versions').where({ id: historicalVersion.id }).first()).content_sha256)
        .toBe(historicalVersion.content_sha256);
    }
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});
