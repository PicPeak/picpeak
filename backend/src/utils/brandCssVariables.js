/**
 * The `--brand-*` custom properties the single-page public site's stylesheet
 * (and every custom CSS written for it) reads. Shared by that page
 * (server.js composeInlineStyles) and the website builder (issue 2618),
 * whose imported landing page keeps using them. The colours come from
 * publicSiteService.fetchBrandingContext, already reduced to valid colours.
 */
function brandCssVariables(colors) {
  return `:root {
  --brand-primary: ${colors.primary};
  --brand-accent: ${colors.accent};
  --brand-background: ${colors.background};
  --brand-text: ${colors.text};
  --brand-surface: ${colors.surface || '#ffffff'};
  --brand-elevated: ${colors.elevated || '#f5f5f5'};
  --brand-border: ${colors.border || '#e5e5e5'};
  --brand-muted-text: ${colors.mutedText || '#737373'};
}`;
}

module.exports = { brandCssVariables };
