/**
 * The guest name the feedback routes take (likes, comments, ratings and the
 * bulk rating route). PicPeak ships German, Slovenian and more locales, so a
 * name with an umlaut or an accent must pass; markup and control characters
 * must not.
 */

const { validationResult } = require('express-validator');
const { validateFeedbackSubmission } = require('../../src/utils/feedbackValidation');

async function check(guestName) {
  const req = { body: { feedback_type: 'like', guest_name: guestName } };
  for (const chain of validateFeedbackSubmission) {
    await chain.run(req);
  }
  const errors = validationResult(req).array().filter((e) => e.path === 'guest_name');
  return { ok: errors.length === 0, name: req.body.guest_name, errors };
}

describe('feedback guest_name validation', () => {
  it.each([
    'Jörg', 'José', 'Zoë', 'Øyvind', 'Łukasz', 'Žiga Čeh', 'Müller-Lüdenscheidt',
    'O\'Brien', 'D’Angelo', 'J. R. R. Tolkien', 'Anna 2', 'Ли Мин', '山田 太郎',
    'Anna\u00A0Maria',
  ])('accepts %s', async (name) => {
    expect((await check(name)).ok).toBe(true);
  });

  it.each([
    '<script>', 'Anna <b>', 'a > b', 'Tom & Jerry', 'Anna "x"', 'a;b', 'a/b',
    'Anna\nMaria', 'Anna\tMaria', 'Anna\u0000', 'Anna\u200BMaria',
    '\u0301\u0308', '\u034F', '...', '\u2019-',
  ])('rejects %j', async (name) => {
    const result = await check(name);
    expect(result.ok).toBe(false);
    expect(result.errors[0].msg).toBe('Name contains invalid characters');
  });

  it('keeps the length limit', async () => {
    expect((await check('ö'.repeat(100))).ok).toBe(true);
    const result = await check('ö'.repeat(101));
    expect(result.ok).toBe(false);
    expect(result.errors[0].msg).toBe('Name must be less than 100 characters');
  });

  it('still allows a blank name', async () => {
    expect((await check('')).ok).toBe(true);
    expect((await check('   ')).ok).toBe(true);
  });

  it('stores the NFC form, so a decomposed umlaut is the same name', async () => {
    const decomposed = 'Jo\u0308rg';
    const result = await check(decomposed);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('J\u00F6rg');
  });

  it('stores the name trimmed, so no edge line break is kept', async () => {
    const result = await check('\nAnna\r');
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Anna');
  });
});
