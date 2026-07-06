const { addColumnIfNotExists } = require('../helpers');

/**
 * Migration: Add video support to photos table
 * - Adds columns for video metadata (media_type, duration, codecs, dimensions)
 * - Updates existing photos to have media_type 'image'
 */

exports.up = async function(knex) {
  console.log('Running migration: 042_add_video_support');

  // Add media_type column (image or video)
  await addColumnIfNotExists(knex, 'photos', 'media_type', (table) => {
    table.string('media_type').defaultTo('image');
  });

  // Add mime_type column if not exists
  await addColumnIfNotExists(knex, 'photos', 'mime_type', (table) => {
    table.string('mime_type');
  });

  // Add duration column (for videos, in seconds)
  await addColumnIfNotExists(knex, 'photos', 'duration', (table) => {
    table.integer('duration');
  });

  // Add video codec information
  await addColumnIfNotExists(knex, 'photos', 'video_codec', (table) => {
    table.string('video_codec');
  });

  // Add audio codec information
  await addColumnIfNotExists(knex, 'photos', 'audio_codec', (table) => {
    table.string('audio_codec');
  });

  // Add width dimension
  await addColumnIfNotExists(knex, 'photos', 'width', (table) => {
    table.integer('width');
  });

  // Add height dimension
  await addColumnIfNotExists(knex, 'photos', 'height', (table) => {
    table.integer('height');
  });

  // Update existing photos to have media_type 'image' if not set
  const hasMediaType = await knex.schema.hasColumn('photos', 'media_type');
  if (hasMediaType) {
    await knex('photos')
      .whereNull('media_type')
      .orWhere('media_type', '')
      .update({ media_type: 'image' });
    console.log('Updated existing photos to have media_type "image"');
  }

  console.log('Migration 042_add_video_support completed');
};

exports.down = async function(knex) {
  console.log('Rolling back migration: 042_add_video_support');

  // Remove video support columns
  const hasMediaType = await knex.schema.hasColumn('photos', 'media_type');
  if (hasMediaType) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('media_type');
    });
  }

  const hasDuration = await knex.schema.hasColumn('photos', 'duration');
  if (hasDuration) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('duration');
    });
  }

  const hasVideoCodec = await knex.schema.hasColumn('photos', 'video_codec');
  if (hasVideoCodec) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('video_codec');
    });
  }

  const hasAudioCodec = await knex.schema.hasColumn('photos', 'audio_codec');
  if (hasAudioCodec) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('audio_codec');
    });
  }

  const hasWidth = await knex.schema.hasColumn('photos', 'width');
  if (hasWidth) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('width');
    });
  }

  const hasHeight = await knex.schema.hasColumn('photos', 'height');
  if (hasHeight) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('height');
    });
  }

  // Note: We don't drop mime_type as it may be used by images as well

  console.log('Rollback of 042_add_video_support completed');
};
