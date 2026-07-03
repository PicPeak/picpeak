const { DEFAULT_MAX_FILES_PER_UPLOAD, MAX_ALLOWED_FILES_PER_UPLOAD } = require('../../src/services/uploadSettings');

exports.up = async function up(knex) {
  const settingKey = 'general_max_files_per_upload';

  const existing = await knex('app_settings')
    .where({ setting_key: settingKey })
    .first();

  if (existing) {
    // Normalize existing value into allowed bounds
    let parsedValue;
    try {
      parsedValue = existing.setting_value != null ? JSON.parse(existing.setting_value) : null;
    } catch {
      parsedValue = existing.setting_value;
    }

    const numeric = Number(parsedValue);
    let normalized = DEFAULT_MAX_FILES_PER_UPLOAD;
    if (Number.isFinite(numeric) && numeric >= 1) {
      normalized = Math.min(MAX_ALLOWED_FILES_PER_UPLOAD, Math.floor(numeric));
    }

    if (normalized !== numeric) {
      await knex('app_settings')
        .where({ setting_key: settingKey })
        .update({
          setting_value: JSON.stringify(normalized),
          updated_at: new Date()
        });
    }
    return;
  }

  await knex('app_settings').insert({
    setting_key: settingKey,
    setting_value: JSON.stringify(DEFAULT_MAX_FILES_PER_UPLOAD),
    setting_type: 'general',
    updated_at: new Date()
  });
};

exports.down = async function down(knex) {
  await knex('app_settings')
    .where({ setting_key: 'general_max_files_per_upload' })
    .del();
};
