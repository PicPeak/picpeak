/**
 * Regression tests for the Docker update instructions (environmentService).
 *
 * A production install (docker-compose.production.yml) must get `-f
 * docker-compose.production.yml` in every update command — bare `docker compose`
 * targets docker-compose.yml, a different build-based stack that also starts the
 * dev-only mailhog, which left production users stranded on the old version
 * (reported against 3.44.0 → 3.45.2).
 */
const { detectEnvironment, generateUpdateInstructions } = require('../../src/services/environmentService');

describe('detectEnvironment — production compose detection', () => {
  const orig = process.env.PICPEAK_RELEASE_CHANNEL;
  afterEach(() => {
    if (orig === undefined) delete process.env.PICPEAK_RELEASE_CHANNEL;
    else process.env.PICPEAK_RELEASE_CHANNEL = orig;
  });

  it('flags isProductionCompose when PICPEAK_RELEASE_CHANNEL is set', async () => {
    process.env.PICPEAK_RELEASE_CHANNEL = 'stable';
    const env = await detectEnvironment();
    expect(env.isProductionCompose).toBe(true);
  });

  it('does not flag it when the var is absent (default docker-compose.yml)', async () => {
    delete process.env.PICPEAK_RELEASE_CHANNEL;
    const env = await detectEnvironment();
    expect(env.isProductionCompose).toBe(false);
  });
});

describe('generateUpdateInstructions — Docker commands', () => {
  const cmds = (env) => generateUpdateInstructions(env, '3.45.2').steps.map((s) => s.command);

  it('targets docker-compose.production.yml for a production install', () => {
    const commands = cmds({ isDocker: true, isProductionCompose: true });
    expect(commands).toEqual([
      'docker compose -f docker-compose.production.yml pull',
      'docker compose -f docker-compose.production.yml up -d',
      'docker compose -f docker-compose.production.yml logs -f backend',
    ]);
    // And the warning tells them where to run it.
    const { warnings } = generateUpdateInstructions({ isDocker: true, isProductionCompose: true }, '3.45.2');
    expect(warnings.join(' ')).toMatch(/docker-compose\.production\.yml/);
  });

  it('uses bare commands + a hint when not a production compose', () => {
    const commands = cmds({ isDocker: true, isProductionCompose: false });
    expect(commands).toEqual([
      'docker compose pull',
      'docker compose up -d',
      'docker compose logs -f backend',
    ]);
    const { warnings } = generateUpdateInstructions({ isDocker: true, isProductionCompose: false }, '3.45.2');
    // Still nudges production users to add -f in case detection missed.
    expect(warnings.join(' ')).toMatch(/-f docker-compose\.production\.yml/);
  });
});
