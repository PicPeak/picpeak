exports.up = async function(knex) {
  console.log('Fixing JSON columns in database...');
  
  // Fix email_templates variables column
  const templates = await knex('email_templates').select('id', 'template_key', 'variables');
  
  for (const template of templates) {
    if (template.variables && typeof template.variables === 'string') {
      try {
        // Check if it's already valid JSON
        JSON.parse(template.variables);
      } catch (e) {
        console.log(`Fixing invalid JSON in email template ${template.template_key}`);
        // Attempt to fix common issues
        let fixed = template.variables;
        
        // If it looks like an array but isn't valid JSON, try to fix it
        if (fixed.startsWith('[') && fixed.endsWith(']')) {
          // Extract the content and properly format it
          const content = fixed.slice(1, -1);
          const items = content.split(',').map(item => item.trim().replace(/['"]/g, ''));
          fixed = JSON.stringify(items);
        } else {
          // Default to empty array if we can't fix it
          fixed = JSON.stringify([]);
        }
        
        await knex('email_templates')
          .where('id', template.id)
          .update({ variables: fixed });
      }
    } else if (!template.variables) {
      // Set default empty array for null values
      await knex('email_templates')
        .where('id', template.id)
        .update({ variables: JSON.stringify([]) });
    }
  }
  
  // Fix activity_logs metadata column
  const activities = await knex('activity_logs').select('id', 'metadata');
  
  for (const activity of activities) {
    if (activity.metadata && typeof activity.metadata === 'string') {
      try {
        // Check if it's already valid JSON
        JSON.parse(activity.metadata);
      } catch (e) {
        console.log(`Fixing invalid JSON in activity log ${activity.id}`);
        // Default to empty object if we can't parse it
        await knex('activity_logs')
          .where('id', activity.id)
          .update({ metadata: JSON.stringify({}) });
      }
    } else if (!activity.metadata) {
      // Set default empty object for null values
      await knex('activity_logs')
        .where('id', activity.id)
        .update({ metadata: JSON.stringify({}) });
    }
  }
  
  console.log('JSON columns fixed successfully');
};

exports.down = async function(knex) {
  // No rollback needed - data fixes only
};