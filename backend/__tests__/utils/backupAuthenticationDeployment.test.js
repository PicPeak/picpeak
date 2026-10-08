const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { recoveryDigest } = require('../../src/utils/manifestCanonical');

const repository = path.resolve(__dirname, '../../..');
const installer = fs.readFileSync(path.join(repository, 'scripts/picpeak-setup.sh'), 'utf8');
const start = installer.indexOf('preserve_backup_manifest_env() {\n');
const end = installer.indexOf('\n}\n', start);
const preserve = installer.slice(start, end + 2);
const envDefault = (name, fallback = '') => name + '=$' + '{' + name + ':-' + fallback + '}';

describe('backup authentication deployment and offline recovery', () => {
  let fixture;
  beforeEach(() => { fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-auth-deployment-')); });
  afterEach(() => { fs.rmSync(fixture, { recursive: true, force: true }); });

  test('installer retains raw trusted-key configuration but never one-artifact recovery approval', () => {
    expect(start).toBeGreaterThan(0);
    const retained = [
      'BACKUP_MANIFEST_KEY=' + 'c1'.repeat(32),
      'export BACKUP_MANIFEST_KEY_FILE="/private/key with spaces"',
      'BACKUP_MANIFEST_KEYS_OLD=' + 'd2'.repeat(32) + ',' + 'e3'.repeat(32),
      "BACKUP_MANIFEST_LEGACY_KEY='a retained $(printf never-evaluated) $$ legacy key'",
    ].join('\n');
    const input = path.join(fixture, '.env');
    fs.writeFileSync(input, [
      '# BACKUP_MANIFEST_KEY=not-an-assignment', retained,
      'BACKUP_MANIFEST_RECOVERY_SHA256=' + 'f4'.repeat(32),
      'BACKUP_MANIFEST_RECOVERY_REASON=temporary recovery approval',
      'UNRELATED=value',
    ].join('\n'));
    const result = spawnSync('/bin/bash', ['-c', preserve + '\npreserve_backup_manifest_env "$FIXTURE_ENV"'], {
      cwd: fixture, env: { ...process.env, FIXTURE_ENV: input }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd()).toBe(retained);
    expect(result.stdout).not.toContain('RECOVERY_');
    expect(installer).toMatch(/manifest_env=\$\(preserve_backup_manifest_env "\$app_dir\/\.env"\)/);
    expect(installer).toMatch(/manifest_env=\$\(preserve_backup_manifest_env "\$NATIVE_APP_DIR\/app\/backend\/\.env"\)/);
    expect(installer.match(/\n\$manifest_env\n/g)).toHaveLength(2);
  });

  test('installer accepts a missing old file without creating keys or approval', () => {
    const result = spawnSync('/bin/bash', ['-c', preserve + '\npreserve_backup_manifest_env "$FIXTURE_ENV"'], {
      cwd: fixture, env: { ...process.env, FIXTURE_ENV: path.join(fixture, 'absent') }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.readdirSync(fixture)).toEqual([]);
  });

  function init(name, key) {
    const compose = yaml.load(fs.readFileSync(path.join(repository, name), 'utf8'));
    const replacements = { '/run/secrets': path.join(fixture, 'secrets'), '/run/db-secret': path.join(fixture, 'db'), '/run/redis-secret': path.join(fixture, 'redis') };
    let script = compose.services['secrets-init'].entrypoint[2].replace(/\$\$/g, '$');
    for (const [from, to] of Object.entries(replacements)) script = script.split(from).join(to);
    const result = spawnSync('/bin/sh', ['-c', script], {
      cwd: fixture, env: { ...process.env, JWT_SECRET: 'fixture-jwt', DB_PASSWORD: 'fixture-db', REDIS_PASSWORD: 'fixture-redis', BACKUP_MANIFEST_KEY: key }, encoding: 'utf8', timeout: 5000,
    });
    return { compose, result, keyPath: path.join(replacements['/run/secrets'], 'backup_manifest_key') };
  }

  test.each(['docker-compose.yml', 'docker-compose.production.yml'])('%s provisions and retains only the backend signing key', name => {
    const { compose, result, keyPath } = init(name, '');
    expect(result.status).toBe(0);
    const first = fs.readFileSync(keyPath, 'utf8');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(keyPath).mode & 0o022).toBe(0);
    expect(init(name, '').result.status).toBe(0);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(first);
    expect(fs.readdirSync(path.join(fixture, 'db'))).toEqual(['db_password']);
    expect(fs.readdirSync(path.join(fixture, 'redis'))).toEqual(['redis_password']);
    expect(compose.services.backend.volumes).toContain('picpeak-secrets:/run/secrets:ro');
    expect(compose.services.postgres.volumes).not.toContain('picpeak-secrets:/run/secrets:ro');
    expect(compose.services.redis.volumes).not.toContain('picpeak-secrets:/run/secrets:ro');
    // Existing empty/invalid key is never silently replaced after loss.
    fs.writeFileSync(keyPath, '');
    expect(init(name, '').result.status).toBe(0);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('');
  });

  test.each(['docker-compose.yml', 'docker-compose.production.yml'])('%s seeds a configured fresh key without changing it', name => {
    const key = 'a6'.repeat(32);
    const { compose, result, keyPath } = init(name, key);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(key);
    expect(compose.services.backend.environment).toContain(envDefault('BACKUP_MANIFEST_KEY_FILE', '/run/secrets/backup_manifest_key'));
    if (name === 'docker-compose.yml') {
      for (const variable of ['KEY', 'KEYS_OLD', 'LEGACY_KEY', 'RECOVERY_SHA256', 'RECOVERY_REASON']) {
        expect(compose.services.backend.environment).toContain(envDefault('BACKUP_MANIFEST_' + variable));
      }
    } else expect(compose.services.backend.env_file).toBe('.env');
  });

  // A passphrase seeded on first start used to stay in the secret for good:
  // the corrected value must replace it, and nothing may be lost doing so.
  test.each(['docker-compose.yml', 'docker-compose.production.yml'])('%s replaces a seeded key when BACKUP_MANIFEST_KEY changes and keeps the old one', name => {
    const { keyPath } = init(name, 'not a hex key');
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('not a hex key');
    const corrected = 'a7'.repeat(32);
    expect(init(name, corrected).result.status).toBe(0);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(corrected);
    expect(fs.readFileSync(keyPath + '.previous', 'utf8')).toBe('not a hex key\n');
    expect(fs.statSync(keyPath + '.previous').mode & 0o077).toBe(0);
    // Unchanged value: no rewrite, no second retained copy.
    expect(init(name, corrected).result.status).toBe(0);
    expect(fs.readFileSync(keyPath + '.previous', 'utf8')).toBe('not a hex key\n');
    // Removing the variable keeps the corrected key.
    expect(init(name, '').result.status).toBe(0);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(corrected);
  });

  test.each(['json', 'yaml'])('offline %s digest is exact, warned, and never creates a trust anchor', format => {
    const manifest = { backup: { id: 'fixture' }, nested: { b: 2, a: 1 }, verification: { total_checksum: 'untrusted' } };
    const input = path.join(fixture, 'manifest.' + format);
    fs.writeFileSync(input, format === 'yaml' ? yaml.dump(manifest) : JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [path.join(repository, 'backend/scripts/backup-manifest-recovery-digest.js'), input], {
      cwd: fixture, env: { ...process.env, DATA_DIR: fixture, BACKUP_MANIFEST_KEY_FILE: path.join(fixture, 'must-not-create') }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(recoveryDigest(manifest));
    expect(result.stderr).toMatch(/UNAUTHENTICATED/);
    expect(fs.readdirSync(fixture)).toEqual(['manifest.' + format]);
  });

  test.each(['array', 'invalid', 'oversized', 'missing'])('offline helper refuses %s input without approval output', kind => {
    const input = path.join(fixture, 'manifest.json');
    if (kind !== 'missing') fs.writeFileSync(input, kind === 'array' ? '[]' : kind === 'invalid' ? '{' : Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    const result = spawnSync(process.execPath, [path.join(repository, 'backend/scripts/backup-manifest-recovery-digest.js'), input], {
      cwd: fixture, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
