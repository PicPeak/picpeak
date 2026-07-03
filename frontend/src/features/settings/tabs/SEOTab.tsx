import React, { useState, useMemo } from 'react';
import { Save, Globe, Bot, X, Plus, Eye, Shield } from 'lucide-react';
import { Button, Card, Input } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import type { SeoSettings } from '../hooks/useSettingsState';

interface SEOTabProps {
  seoSettings: SeoSettings;
  setSeoSettings: React.Dispatch<React.SetStateAction<SeoSettings>>;
  saveSeoMutation: {
    mutate: () => void;
    isPending: boolean;
  };
}

export const SEOTab: React.FC<SEOTabProps> = ({
  seoSettings,
  setSeoSettings,
  saveSeoMutation,
}) => {
  const { t } = useTranslation();
  const [newAgent, setNewAgent] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [newRuleAgent, setNewRuleAgent] = useState('');
  const [newRulePath, setNewRulePath] = useState('/');

  const handleAddAgent = () => {
    const agent = newAgent.trim();
    if (agent && !seoSettings.blocked_ai_agents.includes(agent)) {
      setSeoSettings(prev => ({
        ...prev,
        blocked_ai_agents: [...prev.blocked_ai_agents, agent]
      }));
      setNewAgent('');
    }
  };

  const handleRemoveAgent = (agent: string) => {
    setSeoSettings(prev => ({
      ...prev,
      blocked_ai_agents: prev.blocked_ai_agents.filter(a => a !== agent)
    }));
  };

  const handleAddCustomRule = () => {
    const agent = newRuleAgent.trim();
    const path = newRulePath.trim();
    if (agent && path) {
      setSeoSettings(prev => ({
        ...prev,
        custom_rules: [...prev.custom_rules, { userAgent: agent, disallow: [path] }]
      }));
      setNewRuleAgent('');
      setNewRulePath('/');
    }
  };

  const handleRemoveCustomRule = (index: number) => {
    setSeoSettings(prev => ({
      ...prev,
      custom_rules: prev.custom_rules.filter((_, i) => i !== index)
    }));
  };

  const robotsTxtPreview = useMemo(() => {
    const lines: string[] = [];

    lines.push('# Protected paths');
    lines.push('User-agent: *');
    lines.push('Disallow: /admin');
    lines.push('Disallow: /api');
    lines.push('');

    if (!seoSettings.allow_indexing) {
      lines.push('# Indexing disabled');
      lines.push('User-agent: *');
      lines.push('Disallow: /');
      lines.push('');
    }

    if (seoSettings.block_ai_crawlers && seoSettings.blocked_ai_agents.length > 0) {
      lines.push('# AI/LLM crawler blocking');
      for (const agent of seoSettings.blocked_ai_agents) {
        lines.push(`User-agent: ${agent}`);
        lines.push('Disallow: /');
        lines.push('');
      }
    }

    if (seoSettings.block_social_bots) {
      lines.push('# Social media bot blocking');
      for (const bot of ['Twitterbot', 'facebookexternalhit', 'LinkedInBot', 'Slackbot', 'WhatsApp', 'TelegramBot', 'Discordbot']) {
        lines.push(`User-agent: ${bot}`);
        lines.push('Disallow: /');
        lines.push('');
      }
    }

    if (seoSettings.custom_rules.length > 0) {
      lines.push('# Custom rules');
      for (const rule of seoSettings.custom_rules) {
        lines.push(`User-agent: ${rule.userAgent}`);
        for (const path of rule.disallow) {
          lines.push(`Disallow: ${path}`);
        }
        lines.push('');
      }
    }

    if (seoSettings.sitemap_url) {
      lines.push(`Sitemap: ${seoSettings.sitemap_url}`);
    }

    return lines.join('\n');
  }, [seoSettings]);

  return (
    <div className="space-y-6">
      {/* Search Engine Indexing */}
      <Card padding="md">
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-5 h-5 text-primary-600" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('settings.seo.indexingTitle', 'Search Engine Indexing')}</h2>
        </div>

        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={seoSettings.allow_indexing}
              onChange={(e) => setSeoSettings(prev => ({ ...prev, allow_indexing: e.target.checked }))}
              className="w-4 h-4 mt-0.5 text-primary-600 rounded focus:ring-primary-500"
            />
            <div>
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('settings.seo.allowIndexing', 'Allow search engine indexing')}</span>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{t('settings.seo.allowIndexingHelp', 'When disabled, all crawlers are blocked via robots.txt. Recommended off for private photo platforms.')}</p>
            </div>
          </label>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 dark:text-neutral-300 mb-1">
              {t('settings.seo.sitemapUrl', 'Sitemap URL')}
            </label>
            <Input
              type="url"
              value={seoSettings.sitemap_url}
              onChange={(e) => setSeoSettings(prev => ({ ...prev, sitemap_url: e.target.value }))}
              placeholder="https://example.com/sitemap.xml"
            />
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{t('settings.seo.sitemapUrlHelp', 'Optional. Added to robots.txt if provided.')}</p>
          </div>
        </div>
      </Card>

      {/* AI & Bot Blocking */}
      <Card padding="md">
        <div className="flex items-center gap-2 mb-4">
          <Bot className="w-5 h-5 text-primary-600" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('settings.seo.aiBlockingTitle', 'AI & Bot Blocking')}</h2>
        </div>

        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={seoSettings.block_ai_crawlers}
              onChange={(e) => setSeoSettings(prev => ({ ...prev, block_ai_crawlers: e.target.checked }))}
              className="w-4 h-4 mt-0.5 text-primary-600 rounded focus:ring-primary-500"
            />
            <div>
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('settings.seo.blockAiCrawlers', 'Block AI/LLM crawlers')}</span>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{t('settings.seo.blockAiCrawlersHelp', 'Prevent AI training bots from accessing your content.')}</p>
            </div>
          </label>

          {seoSettings.block_ai_crawlers && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 dark:text-neutral-300 mb-2">
                {t('settings.seo.blockedAgents', 'Blocked AI agents')}
              </label>
              <div className="flex flex-wrap gap-2 mb-3">
                {seoSettings.blocked_ai_agents.map(agent => (
                  <span key={agent} className="inline-flex items-center gap-1 px-2.5 py-1 bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded-full text-sm">
                    {agent}
                    <button
                      onClick={() => handleRemoveAgent(agent)}
                      className="text-neutral-400 hover:text-red-500 transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={newAgent}
                  onChange={(e) => setNewAgent(e.target.value)}
                  placeholder={t('settings.seo.addAgentPlaceholder', 'Enter agent name...')}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddAgent())}
                />
                <Button variant="outline" size="sm" onClick={handleAddAgent}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={seoSettings.block_social_bots}
              onChange={(e) => setSeoSettings(prev => ({ ...prev, block_social_bots: e.target.checked }))}
              className="w-4 h-4 mt-0.5 text-primary-600 rounded focus:ring-primary-500"
            />
            <div>
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('settings.seo.blockSocialBots', 'Block social media preview bots')}</span>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{t('settings.seo.blockSocialBotsHelp', 'Prevent link previews on Twitter, Facebook, LinkedIn, etc.')}</p>
            </div>
          </label>
        </div>
      </Card>

      {/* Meta Tags & Custom Rules */}
      <Card padding="md">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-5 h-5 text-primary-600" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('settings.seo.metaTagsTitle', 'Meta Tags & Custom Rules')}</h2>
        </div>

        <div className="space-y-4">
          <div className="space-y-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={seoSettings.meta_noindex}
                onChange={(e) => setSeoSettings(prev => ({ ...prev, meta_noindex: e.target.checked }))}
                className="w-4 h-4 mt-0.5 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('settings.seo.metaNoindex', 'Add noindex meta tag')}</span>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{t('settings.seo.metaNoindexHelp', 'Tells search engines not to index pages (HTML-level, complements robots.txt).')}</p>
              </div>
            </label>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={seoSettings.meta_nofollow}
                onChange={(e) => setSeoSettings(prev => ({ ...prev, meta_nofollow: e.target.checked }))}
                className="w-4 h-4 mt-0.5 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('settings.seo.metaNofollow', 'Add nofollow meta tag')}</span>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{t('settings.seo.metaNofollowHelp', 'Tells search engines not to follow links on pages.')}</p>
              </div>
            </label>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={seoSettings.meta_noai}
                onChange={(e) => setSeoSettings(prev => ({ ...prev, meta_noai: e.target.checked }))}
                className="w-4 h-4 mt-0.5 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('settings.seo.metaNoai', 'Add noai/noimageai meta tag')}</span>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{t('settings.seo.metaNoaiHelp', 'Signals that content should not be used for AI training.')}</p>
              </div>
            </label>
          </div>

          {/* Custom Rules */}
          <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4">
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">{t('settings.seo.customRules', 'Custom robots.txt rules')}</h3>

            {seoSettings.custom_rules.length > 0 && (
              <div className="space-y-2 mb-3">
                {seoSettings.custom_rules.map((rule, index) => (
                  <div key={index} className="flex items-center gap-2 p-2 bg-neutral-50 dark:bg-neutral-800 rounded-lg text-sm">
                    <code className="flex-1 text-neutral-700 dark:text-neutral-300">
                      User-agent: {rule.userAgent} / Disallow: {rule.disallow.join(', ')}
                    </code>
                    <button
                      onClick={() => handleRemoveCustomRule(index)}
                      className="text-neutral-400 hover:text-red-500 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input
                type="text"
                value={newRuleAgent}
                onChange={(e) => setNewRuleAgent(e.target.value)}
                placeholder={t('settings.seo.ruleAgentPlaceholder', 'User-agent')}
              />
              <Input
                type="text"
                value={newRulePath}
                onChange={(e) => setNewRulePath(e.target.value)}
                placeholder={t('settings.seo.rulePathPlaceholder', 'Disallow path')}
              />
              <Button variant="outline" size="sm" onClick={handleAddCustomRule}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* robots.txt Preview */}
          <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4">
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700 transition-colors"
            >
              <Eye className="w-4 h-4" />
              {showPreview
                ? t('settings.seo.hidePreview', 'Hide robots.txt preview')
                : t('settings.seo.showPreview', 'Show robots.txt preview')}
            </button>

            {showPreview && (
              <pre className="mt-3 p-4 bg-neutral-900 text-neutral-100 rounded-lg text-sm overflow-x-auto whitespace-pre font-mono max-h-80 overflow-y-auto">
                {robotsTxtPreview}
              </pre>
            )}
          </div>
        </div>

        <div className="mt-6">
          <Button
            variant="primary"
            onClick={() => saveSeoMutation.mutate()}
            isLoading={saveSeoMutation.isPending}
            leftIcon={<Save className="w-5 h-5" />}
          >
            {t('settings.seo.saveSettings', 'Save SEO Settings')}
          </Button>
        </div>
      </Card>
    </div>
  );
};
