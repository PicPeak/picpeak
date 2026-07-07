/**
 * Unit tests for emailProcessor.safeTemplateReplace.
 *
 * Covers the two regressions that hit picpeak.nothaft.cloud on the
 * 3.32.x betas:
 *   - {{#if VAR}}…{{/if}} blocks rendered as literal text in the email
 *     because the renderer only handled {{var}} substitution and the
 *     shipped templates use Handlebars-style conditionals.
 *   - {{var}} substitution inside a kept conditional block.
 *
 * The publish-from-draft password localisation lives inside the wider
 * processTemplate() pipeline (DB-backed), so it isn't covered here — the
 * sentinel string '(set at creation)' is asserted only at the i18n-map
 * level by integration in adminEvents.js.
 */

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const { safeTemplateReplace } = require('../../src/services/emailProcessor');

describe('safeTemplateReplace', () => {
  describe('flat variable substitution', () => {
    it('replaces {{var}} with the variable value', () => {
      expect(safeTemplateReplace('Hello {{name}}!', { name: 'Paul' }))
        .toBe('Hello Paul!');
    });

    it('leaves unknown variables untouched', () => {
      expect(safeTemplateReplace('Hello {{name}}!', {}))
        .toBe('Hello {{name}}!');
    });

    it('coerces non-string values to string', () => {
      expect(safeTemplateReplace('Count: {{n}}', { n: 42 }))
        .toBe('Count: 42');
    });

    it('handles empty templates and missing variables map', () => {
      expect(safeTemplateReplace('', { x: 1 })).toBe('');
      expect(safeTemplateReplace('plain text', undefined)).toBe('plain text');
      expect(safeTemplateReplace(null, {})).toBe(null);
    });
  });

  describe('{{#if VAR}}…{{/if}} blocks', () => {
    it('strips the block when the variable is missing', () => {
      const tpl = 'before {{#if welcome}}HELLO {{welcome}}{{/if}} after';
      expect(safeTemplateReplace(tpl, {})).toBe('before  after');
    });

    it('strips the block when the variable is an empty string', () => {
      const tpl = 'before {{#if welcome}}HELLO {{welcome}}{{/if}} after';
      expect(safeTemplateReplace(tpl, { welcome: '' })).toBe('before  after');
    });

    it('strips the block when the variable is null', () => {
      const tpl = '{{#if x}}kept{{/if}}';
      expect(safeTemplateReplace(tpl, { x: null })).toBe('');
    });

    it('keeps the block and substitutes inside it when truthy', () => {
      const tpl = 'before {{#if welcome}}HELLO {{welcome}}{{/if}} after';
      expect(safeTemplateReplace(tpl, { welcome: 'world' }))
        .toBe('before HELLO world after');
    });

    it('handles multi-line conditional blocks', () => {
      const tpl = [
        'Liebe(r) {{host_name}},',
        '',
        '{{#if welcome_message}}',
        'Persönliche Nachricht:',
        '{{welcome_message}}',
        '{{/if}}',
        'Galerie-Details:',
      ].join('\n');

      const withMsg = safeTemplateReplace(tpl, {
        host_name: 'Natalie',
        welcome_message: 'Schön, dass ihr da seid!',
      });
      expect(withMsg).toContain('Persönliche Nachricht:');
      expect(withMsg).toContain('Schön, dass ihr da seid!');
      expect(withMsg).not.toContain('{{#if');
      expect(withMsg).not.toContain('{{/if');

      const withoutMsg = safeTemplateReplace(tpl, {
        host_name: 'Natalie',
        welcome_message: '',
      });
      expect(withoutMsg).not.toContain('Persönliche Nachricht');
      expect(withoutMsg).not.toContain('{{#if');
      expect(withoutMsg).not.toContain('{{/if');
      expect(withoutMsg).toContain('Liebe(r) Natalie,');
      expect(withoutMsg).toContain('Galerie-Details:');
    });

    it('handles multiple sibling conditionals independently', () => {
      const tpl = '{{#if a}}A{{/if}}|{{#if b}}B{{/if}}|{{#if c}}C{{/if}}';
      expect(safeTemplateReplace(tpl, { a: 1, c: 'yes' })).toBe('A||C');
    });

    it('treats numeric 0 as falsy', () => {
      expect(safeTemplateReplace('{{#if n}}has-n{{/if}}', { n: 0 })).toBe('');
    });
  });

  describe('HTML escaping (escapeHtml: true)', () => {
    it('does not escape by default', () => {
      const tpl = 'Welcome to {{event_name}}';
      expect(safeTemplateReplace(tpl, { event_name: 'Test <script>' }))
        .toBe('Welcome to Test <script>');
    });

    it('escapes admin-supplied values when opted in', () => {
      const tpl = 'Welcome to {{event_name}}';
      expect(safeTemplateReplace(tpl, { event_name: 'Test <script>alert(1)</script>' }, { escapeHtml: true }))
        .toBe('Welcome to Test &lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes both the < > and & characters and quotes', () => {
      expect(safeTemplateReplace('{{x}}', { x: '<a href="evil">A & B\'s</a>' }, { escapeHtml: true }))
        .toBe('&lt;a href=&quot;evil&quot;&gt;A &amp; B&#39;s&lt;/a&gt;');
    });

    it('passes welcome_message through unescaped (already HTML from formatWelcomeMessage)', () => {
      const tpl = '<p>{{welcome_message}}</p>';
      expect(safeTemplateReplace(tpl, { welcome_message: 'Hi<br />there' }, { escapeHtml: true }))
        .toBe('<p>Hi<br />there</p>');
    });

    it('passes server-generated URLs through unescaped', () => {
      const tpl = '<a href="{{gallery_link}}">link</a>';
      expect(safeTemplateReplace(tpl, { gallery_link: 'https://example.com/g/abc?token=xyz&u=1' }, { escapeHtml: true }))
        .toBe('<a href="https://example.com/g/abc?token=xyz&u=1">link</a>');
    });
  });
});
