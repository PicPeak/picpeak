exports.up = async function(knex) {
  // Check current column structure
  const hasSubjectEn = await knex.schema.hasColumn('email_templates', 'subject_en');
  const hasSubject = await knex.schema.hasColumn('email_templates', 'subject');
  
  if (hasSubjectEn && !hasSubject) {
    // The language migration was applied, need to add back basic columns
    await knex.schema.alterTable('email_templates', function(table) {
      table.string('subject');
      table.text('body_html');
      table.text('body_text');
    });
    
    // Copy English values to the basic columns
    await knex('email_templates').update({
      subject: knex.raw('subject_en'),
      body_html: knex.raw('body_html_en'),
      body_text: knex.raw('body_text_en')
    });
  }
};

exports.down = async function(knex) {
  // Check if we have the basic columns
  const hasSubject = await knex.schema.hasColumn('email_templates', 'subject');
  const hasSubjectEn = await knex.schema.hasColumn('email_templates', 'subject_en');
  
  if (hasSubject && hasSubjectEn) {
    await knex.schema.alterTable('email_templates', function(table) {
      table.dropColumn('subject');
      table.dropColumn('body_html');
      table.dropColumn('body_text');
    });
  }
};