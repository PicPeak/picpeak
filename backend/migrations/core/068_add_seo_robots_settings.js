const DEFAULT_AI_AGENTS = [
  'GPTBot',
  'ChatGPT-User',
  'Google-Extended',
  'Claude-Web',
  'Anthropic-AI',
  'CCBot',
  'Bytespider',
  'FacebookBot',
  'Omgilibot',
  'Diffbot',
  'PetalBot',
  'Amazonbot',
  'PerplexityBot',
  'YouBot',
  'Applebot-Extended'
];

exports.up = async function(knex) {
  const defaults = [
    { setting_key: 'seo_allow_indexing', setting_value: JSON.stringify(false), setting_type: 'seo' },
    { setting_key: 'seo_block_ai_crawlers', setting_value: JSON.stringify(true), setting_type: 'seo' },
    { setting_key: 'seo_block_social_bots', setting_value: JSON.stringify(false), setting_type: 'seo' },
    { setting_key: 'seo_blocked_ai_agents', setting_value: JSON.stringify(DEFAULT_AI_AGENTS), setting_type: 'seo' },
    { setting_key: 'seo_custom_rules', setting_value: JSON.stringify([]), setting_type: 'seo' },
    { setting_key: 'seo_meta_noindex', setting_value: JSON.stringify(true), setting_type: 'seo' },
    { setting_key: 'seo_meta_nofollow', setting_value: JSON.stringify(false), setting_type: 'seo' },
    { setting_key: 'seo_meta_noai', setting_value: JSON.stringify(true), setting_type: 'seo' },
    { setting_key: 'seo_sitemap_url', setting_value: JSON.stringify(''), setting_type: 'seo' }
  ];

  for (const setting of defaults) {
    const exists = await knex('app_settings').where('setting_key', setting.setting_key).first();
    if (!exists) {
      await knex('app_settings').insert({ ...setting, updated_at: knex.fn.now() });
    }
  }
};

exports.down = async function(knex) {
  await knex('app_settings')
    .whereIn('setting_key', [
      'seo_allow_indexing',
      'seo_block_ai_crawlers',
      'seo_block_social_bots',
      'seo_blocked_ai_agents',
      'seo_custom_rules',
      'seo_meta_noindex',
      'seo_meta_nofollow',
      'seo_meta_noai',
      'seo_sitemap_url'
    ])
    .del();
};
