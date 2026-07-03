exports.up = async function(knex) {
  // Add user upload settings to events table (check if columns exist first)
  const hasAllowUserUploads = await knex.schema.hasColumn('events', 'allow_user_uploads');
  if (!hasAllowUserUploads) {
    console.log('Adding allow_user_uploads column to events table...');
    await knex.schema.alterTable('events', function(table) {
      table.boolean('allow_user_uploads').defaultTo(false);
    });
  } else {
    console.log('Column allow_user_uploads already exists in events table, skipping...');
  }

  const hasUploadCategoryId = await knex.schema.hasColumn('events', 'upload_category_id');
  if (!hasUploadCategoryId) {
    console.log('Adding upload_category_id column to events table...');
    await knex.schema.alterTable('events', function(table) {
      table.integer('upload_category_id').references('id').inTable('photo_categories').onDelete('SET NULL');
    });
  } else {
    console.log('Column upload_category_id already exists in events table, skipping...');
  }

  // Add uploaded_by field to photos table to track who uploaded
  const hasUploadedBy = await knex.schema.hasColumn('photos', 'uploaded_by');
  if (!hasUploadedBy) {
    console.log('Adding uploaded_by column to photos table...');
    await knex.schema.alterTable('photos', function(table) {
      table.string('uploaded_by').defaultTo('admin'); // 'admin' or guest identifier
    });
  } else {
    console.log('Column uploaded_by already exists in photos table, skipping...');
  }
};

exports.down = async function(knex) {
  const hasAllowUserUploads = await knex.schema.hasColumn('events', 'allow_user_uploads');
  if (hasAllowUserUploads) {
    await knex.schema.alterTable('events', function(table) {
      table.dropColumn('allow_user_uploads');
    });
  }

  const hasUploadCategoryId = await knex.schema.hasColumn('events', 'upload_category_id');
  if (hasUploadCategoryId) {
    await knex.schema.alterTable('events', function(table) {
      table.dropColumn('upload_category_id');
    });
  }

  const hasUploadedBy = await knex.schema.hasColumn('photos', 'uploaded_by');
  if (hasUploadedBy) {
    await knex.schema.alterTable('photos', function(table) {
      table.dropColumn('uploaded_by');
    });
  }
};