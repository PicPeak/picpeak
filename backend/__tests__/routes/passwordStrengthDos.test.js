/**
 * POST /api/auth/password-strength is unauthenticated and feeds its body into
 * zxcvbn, whose matching is superlinear and runs synchronously on the event
 * loop. Behind express.json({ limit: '50mb' }) that made a single request a
 * whole-process denial of service: measured on this codebase, 1,000 characters
 * blocked for ~5 seconds and 5,000 did not return in two minutes.
 *
 * The control is the length cap inside validatePassword(), so it holds for
 * every caller. These tests pin the cap itself rather than the route, and use
 * a wall-clock ceiling that only an unbounded zxcvbn call can breach.
 */
const { validatePassword, MAX_PASSWORD_LENGTH } = require('../../src/utils/passwordValidation');

describe('password validation length cap (zxcvbn DoS)', () => {
  it('rejects an over-length password without doing superlinear work', () => {
    const huge = 'aA1!'.repeat(MAX_PASSWORD_LENGTH); // 4x the cap
    const started = Date.now();
    const result = validatePassword(huge);
    const elapsed = Date.now() - started;

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/at most 128 characters/);
    // Unbounded, this input would not return for minutes.
    expect(elapsed).toBeLessThan(250);
  });

  it('is bounded at the cap itself, the worst input it will still analyse', () => {
    const atCap = 'aA1!'.repeat(MAX_PASSWORD_LENGTH / 4);
    expect(atCap).toHaveLength(MAX_PASSWORD_LENGTH);

    // 128 was chosen so the worst input the validator will still analyse costs
    // about as much as an ordinary request (~41ms measured); 512 cost 1.4s.
    const started = Date.now();
    validatePassword(atCap);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still accepts an ordinary strong password', () => {
    const result = validatePassword('Tr0ub4dour&3-horse-battery');
    expect(result.valid).toBe(true);
  });

  it('does not spin when a caller asks for a length the cap forbids', async () => {
    // Codex review. generateSecurePassword retried by recursing on any invalid
    // candidate, so the new cap made every candidate invalid for length > 128
    // and turned the call into unbounded recursion. It now refuses up front,
    // and the retry loop is bounded.
    const { generateSecurePassword } = require('../../src/utils/passwordValidation');

    expect(generateSecurePassword({ length: 16 })).toHaveLength(16);
    expect(generateSecurePassword({ length: MAX_PASSWORD_LENGTH }))
      .toHaveLength(MAX_PASSWORD_LENGTH);
    expect(() => generateSecurePassword({ length: MAX_PASSWORD_LENGTH + 1 }))
      .toThrow(/at most 128/);
  });

  it('does not echo the rejected password back in the error body', async () => {
    // Codex review round 2. express-validator's errors.array() carries the
    // submitted `value`, so the 400 for an oversized password returned the
    // password itself -- reflecting a credential, and re-allocating up to the
    // 50mb body limit on an unauthenticated endpoint, which partly undid the
    // DoS fix this branch exists for.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/routes/auth.js'), 'utf8');

    // No route may hand errors.array() straight to the response.
    expect(src).not.toMatch(/errors:\s*errors\.array\(\)/);
    // ...and the shared helper that replaces it must drop `value`.
    const helper = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/utils/routeHelpers.js'), 'utf8');
    expect(helper).toMatch(/safeValidationErrors\s*=\s*\(errors\)\s*=>\s*errors\.array\(\)\.map\(\(\{ value, \.\.\.rest \}\)/);
  });

  it('applies the cap through the context wrapper too', async () => {
    const { validatePasswordInContext } = require('../../src/utils/passwordValidation');
    const huge = 'aA1!'.repeat(MAX_PASSWORD_LENGTH);
    const result = await validatePasswordInContext(huge, 'admin', {});
    expect(result.valid).toBe(false);
  });
});
