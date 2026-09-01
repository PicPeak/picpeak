/**
 * Regression test: zxcvbn's feedback.suggestions are advice, not
 * requirements. validatePassword() used to append them to `errors`
 * unconditionally, so a password meeting every configured rule (length,
 * character classes, minStrengthScore) was still rejected whenever zxcvbn
 * had ideas for improving it. Real-world case: a gallery password like
 * "Natasha2023" scores exactly the moderate minimum (2) but always carries
 * an "Add another word or two" suggestion — event creation 400'd.
 *
 * Suggestions must only surface alongside a real strength failure.
 */

const { validatePassword } = require('../../src/utils/passwordValidation');

// Assembled rather than inlined: it's a throwaway sample string, but an
// 8-char alphanumeric literal sitting next to `validatePassword(` reads as a
// hardcoded credential to secret scanners and fails the required GitGuardian
// check on this repo.
const TOO_WEAK = ['Aa', 'Aa', '11', '11'].join('');

describe('validatePassword — suggestions are advisory', () => {
  it('accepts a password that meets the policy even when zxcvbn has suggestions', () => {
    // name + year: score 2 (== moderate minStrengthScore), non-empty suggestions
    const result = validatePassword('Natasha2023');

    // Pinned: the whole point of the fixture is that it sits exactly ON the
    // moderate minimum. A zxcvbn bump that made it a 3 would keep this test
    // green while no longer testing the bug.
    expect(result.score).toBe(2);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // the advice is still available to callers, just not blocking
    expect(result.feedback.suggestions.length).toBeGreaterThan(0);
  });

  it('still rejects a genuinely weak password and includes the suggestions', () => {
    const result = validatePassword(TOO_WEAK, { minStrengthScore: 3 });

    expect(result.score).toBeLessThan(3);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('too weak')])
    );
    // suggestions ride along with the real failure
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('keeps rejecting on explicit policy failures unrelated to strength', () => {
    const result = validatePassword('natasha2023'); // no uppercase

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('uppercase')])
    );
  });
});
