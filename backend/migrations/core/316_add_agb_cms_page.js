'use strict';

/**
 * Migration: AGB legal page — same CMS structure as Impressum/Datenschutz.
 *
 * Editable in Admin → CMS Pages and served at /agb. Unlike Impressum and
 * Datenschutz it ships HIDDEN (show_in_footer = false): a placeholder terms
 * page the operator never wrote is worse than no link, and many installs
 * sell nothing. The operator who needs it writes it and switches it on in
 * CMS Pages; every footer honours the flag.
 *
 * Existing deployments get the row here. A fresh database gets it from the
 * db.js seed, which runs before migration 089 adds show_in_footer (default
 * true) — so a seeded row still holding the placeholder text is hidden here.
 */

const PLACEHOLDER_EN = '<h2>Terms & Conditions</h2><p>Please edit this content in the admin panel.</p>';
const PLACEHOLDER_DE = '<h2>AGB</h2><p>Bitte bearbeiten Sie diesen Inhalt im Admin-Panel.</p>';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('cms_pages'))) return;
  const existing = await knex('cms_pages').where('slug', 'agb').first();
  if (!existing) {
    await knex('cms_pages').insert({
      slug: 'agb',
      title_en: 'Terms & Conditions',
      title_de: 'AGB',
      content_en: PLACEHOLDER_EN,
      content_de: PLACEHOLDER_DE,
      show_in_footer: false,
      updated_at: new Date().toISOString(),
    });
    return;
  }
  if (existing.content_en === PLACEHOLDER_EN && existing.content_de === PLACEHOLDER_DE) {
    await knex('cms_pages').where('slug', 'agb').update({ show_in_footer: false });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('cms_pages'))) return;
  await knex('cms_pages').where('slug', 'agb').del();
};
