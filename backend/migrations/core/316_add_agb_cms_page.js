'use strict';

/**
 * Migration: AGB legal page — same CMS structure as Impressum/Datenschutz.
 *
 * Editable in Admin → CMS Pages, served at /agb, shown in the gallery
 * footer next to Impressum/Datenschutz. Existing deployments get the row
 * here; fresh databases get it from the db.js default-page seed.
 */

exports.up = async function up(knex) {
  const existing = await knex('cms_pages').where('slug', 'agb').first();
  if (existing) return;
  await knex('cms_pages').insert({
    slug: 'agb',
    title_en: 'Terms & Conditions',
    title_de: 'AGB',
    content_en: '<h2>Terms & Conditions</h2><p>Please edit this content in the admin panel.</p>',
    content_de: '<h2>AGB</h2><p>Bitte bearbeiten Sie diesen Inhalt im Admin-Panel.</p>',
    updated_at: new Date(),
  });
};

exports.down = async function down(knex) {
  await knex('cms_pages').where('slug', 'agb').del();
};
