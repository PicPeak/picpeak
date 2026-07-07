exports.up = async function(knex) {
  // Check if photo_counter column already exists to make migration idempotent
  const hasPhotoCounter = await knex.schema.hasColumn('photo_categories', 'photo_counter');

  if (!hasPhotoCounter) {
    // Add photo_counter column to photo_categories table
    await knex.schema.alterTable('photo_categories', function(table) {
      table.integer('photo_counter').defaultTo(0).notNullable();
    });

    // Initialize counters based on existing photos
    const categories = await knex('photo_categories').select('id');

    for (const category of categories) {
      const photoCount = await knex('photos')
        .where('category_id', category.id)
        .count('id as count')
        .first();

      if (photoCount && photoCount.count > 0) {
        await knex('photo_categories')
          .where('id', category.id)
          .update({ photo_counter: photoCount.count });
      }
    }
  }
};

exports.down = async function(knex) {
  await knex.schema.alterTable('photo_categories', function(table) {
    table.dropColumn('photo_counter');
  });
};