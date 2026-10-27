/**
 * The landing page footer links the AGB page only once the admin switched it
 * on (show_in_footer, migration 316). Pinned at source level like
 * publicSiteDocument.fonts.test.js: server.js cannot be required under jest.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const footer = source.slice(source.indexOf('function renderBrandFooter'), source.indexOf('function buildSeoMetaTags'));
const handler = source.slice(source.indexOf('async function handlePublicSiteRequest'));

describe('public site footer — AGB link', () => {
  it('renders the link only when showAgb is set, labelled like the rest of the English footer', () => {
    expect(footer).toContain("showAgb ? '<a href=\"/agb\">Terms &amp; Conditions</a>' : ''");
    expect(footer).not.toMatch(/>AGB</);
  });

  it('derives showAgb from the CMS page flag', () => {
    expect(handler).toContain("db('cms_pages').where('slug', 'agb').first('show_in_footer')");
    expect(source).toContain('renderBrandFooter(payload.branding, { showAgb: payload.showAgb === true })');
  });
});
