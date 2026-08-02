/**
 * Migration 167 (projects.created_by) — idempotent on re-run, reversible,
 * and backfills the owner from a project's single linked event (GHSA-wrg5).
 */
const path=require('path'), fs=require('fs'), os=require('os');
process.env.NODE_ENV='test';
process.env.TEST_DATABASE_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'picpeak-mig167-')),'db.sqlite');
process.env.JWT_SECRET='mig';
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const mig = require('../../migrations/core/167_add_projects_created_by');
describe('migration 167', () => {
  let db, cleanup;
  beforeAll(async()=>{ ({db,cleanup}=await bootCrmDb()); await seedMinimal(db); },120000);
  afterAll(async()=>{ if(cleanup) await cleanup(); });
  it('is idempotent on re-run and reversible', async () => {
    await mig.up(db);            // already applied by boot; must no-op
    await mig.up(db);            // and again
    expect(await db.schema.hasColumn('projects','created_by')).toBe(true);
    await mig.down(db);
    expect(await db.schema.hasColumn('projects','created_by')).toBe(false);
    await mig.up(db);            // re-apply cleanly
    expect(await db.schema.hasColumn('projects','created_by')).toBe(true);
  });
  it('backfills created_by from a single linked event owner', async () => {
    const p = await db('projects').insert({name:'bf',status:'active',created_at:new Date(),updated_at:new Date()}).returning('id');
    const pid = p[0]?.id ?? p[0];
    await db('events').insert({slug:'bf-ev',event_type:'wedding',event_name:'bf',event_date:'2026-08-01',
      host_email:'h@e.com',admin_email:'a@e.com',password_hash:'x',share_token:'t1',share_link:'/g/bf-ev/t1',
      created_by: 4242, project_id: pid, expires_at:new Date(Date.now()+864e5).toISOString(),
      is_active:1,is_archived:0,is_draft:0,created_at:new Date().toISOString()});
    await mig.up(db);
    const row = await db('projects').where({id:pid}).first();
    expect(row.created_by).toBe(4242);
  });
});
