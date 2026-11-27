/**
 * The studio's photo editor presets (issue 2619): named edits every admin
 * with photos.edit can apply, behind the photoEditor feature flag. The params
 * are validated as strictly as a saved edit (photoEditMath).
 *
 *   GET    /settings   the editor's studio settings (develop RAW uploads automatically)
 *   PUT    /settings   { auto_develop_raw }
 *   GET    /        the presets, by name
 *   POST   /        { name, params }
 *   PUT    /:id     { name?, params? }
 *   DELETE /:id
 */

const express = require('express');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { parsePositiveInt32 } = require('../utils/parsers');
const { errorResponse } = require('../utils/routeHelpers');
const math = require('../utils/photoEditMath');

const router = express.Router();
const MAX_PRESETS = 200;
const NAME_MAX = 80;

router.use(adminAuth, requireFeatureFlag('photoEditor'), requirePermission('photos.edit'));

const actor = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.username });

/** A name as stored: trimmed, control characters out, at most NAME_MAX; null when nothing is left. */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  return name || null;
}

const toPayload = (row) => ({
  id: row.id,
  name: row.name,
  params: math.parseStoredParams(row.params) || { ...math.DEFAULT_PARAMS },
});

router.get('/settings', async (req, res) => {
  try {
    res.json({ auto_develop_raw: await require('../services/photoEdits').autoDevelopEnabled() });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load the editor settings');
  }
});

// Developing every RAW upload costs server CPU: a studio setting.
router.put('/settings', requirePermission('settings.edit'), async (req, res) => {
  try {
    const value = req.body?.auto_develop_raw;
    if (typeof value !== 'boolean') return res.status(400).json({ error: 'auto_develop_raw must be true or false' });
    const { AUTO_DEVELOP_SETTING } = require('../services/photoEdits');
    await require('../utils/appSettings').upsertAppSetting(AUTO_DEVELOP_SETTING, JSON.stringify(value), 'boolean');
    await logActivity('photo_editor_settings_updated', { auto_develop_raw: value }, null, actor(req));
    res.json({ auto_develop_raw: value });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to save the editor settings');
  }
});

router.get('/', async (req, res) => {
  try {
    const rows = await db('photo_edit_presets').orderBy('name', 'asc').orderBy('id', 'asc');
    res.json({ presets: rows.map(toPayload) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load the presets');
  }
});

router.post('/', async (req, res) => {
  try {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'A preset needs a name' });
    const { params, error } = math.validateEditParams(req.body?.params);
    if (error) return res.status(400).json({ error });
    const count = Number((await db('photo_edit_presets').count('id as count').first()).count);
    if (count >= MAX_PRESETS) return res.status(409).json({ error: `At most ${MAX_PRESETS} presets` });
    const now = new Date().toISOString();
    const inserted = await db('photo_edit_presets').insert({
      name, params: math.canonicalJson(params), created_by_admin_id: req.admin.id, created_at: now, updated_at: now,
    }).returning('id');
    const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
    await logActivity('photo_edit_preset_created', { preset_id: id }, null, actor(req));
    res.status(201).json(toPayload(await db('photo_edit_presets').where({ id }).first()));
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to save the preset');
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = parsePositiveInt32(req.params.id);
    const row = id ? await db('photo_edit_presets').where({ id }).first() : null;
    if (!row) return res.status(404).json({ error: 'Preset not found' });
    const update = { updated_at: new Date().toISOString() };
    if (req.body?.name !== undefined) {
      const name = cleanName(req.body.name);
      if (!name) return res.status(400).json({ error: 'A preset needs a name' });
      update.name = name;
    }
    if (req.body?.params !== undefined) {
      const { params, error } = math.validateEditParams(req.body.params);
      if (error) return res.status(400).json({ error });
      update.params = math.canonicalJson(params);
    }
    await db('photo_edit_presets').where({ id }).update(update);
    res.json(toPayload(await db('photo_edit_presets').where({ id }).first()));
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update the preset');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parsePositiveInt32(req.params.id);
    const deleted = id ? await db('photo_edit_presets').where({ id }).del() : 0;
    if (!deleted) return res.status(404).json({ error: 'Preset not found' });
    await logActivity('photo_edit_preset_deleted', { preset_id: id }, null, actor(req));
    res.status(204).end();
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to delete the preset');
  }
});

module.exports = router;
