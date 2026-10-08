const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const installer = fs.readFileSync(path.join(__dirname, '../../../scripts/picpeak-setup.sh'), 'utf8');
const legacyInstaller = fs.readFileSync(path.join(__dirname, '../../../scripts/install.sh'), 'utf8');
const pins = installer.split('\n').filter(line => /^readonly (NODE_(VERSION|MIN_VERSION)|(?:DOCKER|NODE_DEB|NODE_RPM)_BOOTSTRAP_(URL|SHA256))=/.test(line));
// Extract only the actual helper/callers: never source main, log redirection,
// root checks, or real installation/service code while testing.
function definition(name, subshell = false) {
  const start = installer.indexOf(name + '() ' + (subshell ? '(' : '{') + '\n');
  if (start < 0) throw new Error('Missing installer function: ' + name);
  const end = installer.indexOf('\n' + (subshell ? ')' : '}') + '\n', start);
  if (end < 0) throw new Error('Missing installer function boundary: ' + name);
  return installer.slice(start, end + 2);
}
const definitions = [
  definition('run_verified_bootstrap', true), definition('node_version_supported'),
  definition('install_nodejs'), definition('install_docker'), definition('update_native_installation')
];

const stubs = [
  'log_error() { printf "ERROR:%s\\n" "$*" >> "$EVENTS"; }',
  'log_success() { :; }; log_step() { :; }; print_header() { :; }',
  'die() { log_error "$1"; exit 1; }',
  'command_exists() {',
  '  [[ "$1" != "${MISSING_TOOL:-}" ]] || return 1',
  '  case "$1" in',
  '    node) [[ -f "$NODE_STATE" ]] ;;',
  '    docker) [[ "${EXISTING_DOCKER:-}" == yes ]] ;;',
  '    *) command -v "$1" >/dev/null 2>&1 ;;',
  '  esac',
  '}',
  'node() { [[ -f "$NODE_STATE" ]] && printf "v%s\\n" "$(command cat "$NODE_STATE")"; }',
  'detect_os() { printf "DETECT_OS\\n" >> "$EVENTS"; PACKAGE_MANAGER="$DETECTED_MANAGER"; }',
  'curl() {',
  '  local IFS=" "',
  '  printf "CURL:%s\\n" "$*" >> "$EVENTS"',
  '  local output=""; while [[ $# -gt 0 ]]; do',
  '    if [[ "$1" == --output ]]; then output="$2"; shift; fi; shift',
  '  done',
  '  [[ -n "$output" ]] || { command cat "$PAYLOAD"; return; }',
  '  printf "DOWNLOAD_PATH:%s\\n" "$output" >> "$EVENTS"',
  '  ls -ld "$(dirname "$output")" >> "$EVENTS"',
  '  command cp "$PAYLOAD" "$output"',
  '  case "${CURL_MODE:-}" in',
  '    fail) return 22 ;;',
  '    empty) : > "$output" ;;',
  '    tamper) command cat "$ATTACK_PAYLOAD" >> "$output" ;;',
  '  esac',
  '}',
  'sha256sum() {',
  '  printf "HASH\\n" >> "$EVENTS"',
  '  [[ "${HASH_MODE:-}" != fail ]] || return 1',
  '  command sha256sum "$@"',
  '}',
  'apt-get() { local IFS=" "; printf "PACKAGE:apt-get:%s\\n" "$*" >> "$EVENTS"; }',
  'dnf() { local IFS=" "; printf "PACKAGE:dnf:%s\\n" "$*" >> "$EVENTS"; }',
  'yum() { local IFS=" "; printf "PACKAGE:yum:%s\\n" "$*" >> "$EVENTS"; }',
  'systemctl() { local IFS=" "; printf "SERVICE:%s\\n" "$*" >> "$EVENTS"; }',
  'usermod() { local IFS=" "; printf "GROUP:%s\\n" "$*" >> "$EVENTS"; }'
].join('\n');

describe('standalone root installer verified bootstrap boundary', () => {
  let fixture;
  beforeEach(() => { fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-installer-test-')); });
  afterEach(() => { fs.rmSync(fixture, { recursive: true, force: true }); });

  function run(command, options = {}) {
    const payload = 'printf "VERIFIED_EXECUTED\\n" >> "$EVENTS"\nprintf "%s" "${INSTALLED_NODE:-22.12.0}" > "$NODE_STATE"\n' + (options.payloadSuffix || '');
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const eventsPath = path.join(fixture, 'events');
    const nodeState = path.join(fixture, 'node-version');
    const payloadPath = path.join(fixture, 'payload.sh');
    const attackPath = path.join(fixture, 'attack.sh');
    fs.writeFileSync(payloadPath, payload);
    fs.writeFileSync(attackPath, '\nprintf "ATTACKER_EXECUTED\\n" >> "$EVENTS"\n');
    if (options.existingNode) fs.writeFileSync(nodeState, options.existingNode);
    const constants = pins.map(line => options.realPins ? line : line.replace(/(_SHA256=")[0-9a-f]+"$/, '$1' + digest + '"'));
    const script = [
      'set -euo pipefail', 'IFS=$\'\\n\\t\'', 'umask "${FIXTURE_UMASK:-0022}"', ...constants,
      'PACKAGE_MANAGER="${MANAGER-apt}"; SUDO_USER="${FIXTURE_SUDO_USER:-}"',
      ...definitions, stubs, command
    ].join('\n');
    const result = spawnSync('/bin/bash', ['-c', script], {
      cwd: fixture, timeout: 5000, encoding: 'utf8', input: options.input,
      env: {
        ...process.env, EVENTS: eventsPath, PAYLOAD: payloadPath, ATTACK_PAYLOAD: attackPath,
        NODE_STATE: nodeState, FIXTURE_ROOT: fixture,
        DETECTED_MANAGER: 'apt', FIXTURE_DIGEST: digest, ...options.env
      }
    });
    if (result.error) throw result.error;
    const events = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : '';
    for (const match of events.matchAll(/^DOWNLOAD_PATH:(.+)$/gm)) {
      expect(fs.existsSync(path.dirname(match[1]))).toBe(false);
    }
    return { ...result, events };
  }

  test('three immutable upstream pins and digests are embedded, not environment defaults', () => {
    expect(pins).toHaveLength(8);
    expect(pins.filter(line => line.includes('_URL='))).toHaveLength(3);
    for (const line of pins.filter(value => value.includes('_URL='))) {
      expect(line).toMatch(/^readonly [A-Z_]+="https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/.+"$/);
    }
    for (const line of pins.filter(value => value.includes('_SHA256='))) {
      expect(line).toMatch(/^readonly [A-Z0-9_]+="[0-9a-f]{64}"$/);
    }
    expect(installer).not.toMatch(/curl[^\n]*\|\s*(sh|bash)/);
  });

  test.each(['sh', 'bash'])('verified captured bytes execute once with %s and private cleanup', interpreter => {
    const result = run('run_verified_bootstrap "$DOCKER_BOOTSTRAP_URL" "$FIXTURE_DIGEST" ' + interpreter);
    expect(result.status).toBe(0);
    expect(result.events.match(/VERIFIED_EXECUTED/g)).toHaveLength(1);
    expect(result.events).toMatch(/drwx------/);
    expect(result.events.indexOf('HASH')).toBeLessThan(result.events.indexOf('VERIFIED_EXECUTED'));
    expect(result.events).toContain('--disable --fail --silent --show-error --location');
    expect(result.events).toContain('--proto =https --proto-redir =https --max-redirs 3');
    expect(result.events).toContain('--connect-timeout 10 --max-time 60 --max-filesize 1048576');
  });

  test.each(['sh', 'bash'])('verified %s child gets EOF on stdin, leaving a piped installer intact', interpreter => {
    const result = run('run_verified_bootstrap "$DOCKER_BOOTSTRAP_URL" "$FIXTURE_DIGEST" ' + interpreter
      + '; read -r rest || true; printf "PARENT_READ:%s\\n" "$rest" >> "$EVENTS"', {
      input: 'REST_OF_INSTALLER\n',
      payloadSuffix: 'if read -r line; then printf "CHILD_READ:%s\\n" "$line" >> "$EVENTS"; else printf "CHILD_EOF\\n" >> "$EVENTS"; fi\n'
    });
    expect(result.status).toBe(0);
    expect(result.events).toContain('CHILD_EOF');
    expect(result.events).not.toContain('CHILD_READ');
    expect(result.events).toContain('PARENT_READ:REST_OF_INSTALLER');
  });

  test('legacy scripts/install.sh is an exit-only stub with no remote download or execution', () => {
    expect(legacyInstaller).not.toMatch(/\b(curl|wget)\s+-/);
    expect(legacyInstaller).not.toMatch(/https?:\/\//);
    expect(legacyInstaller).not.toMatch(/releases\/latest/);
    expect(legacyInstaller).not.toMatch(/^\s*(sh|bash)\s+\S+\.sh\b/m);
    const result = spawnSync('/bin/bash', [path.join(__dirname, '../../../scripts/install.sh')], {
      cwd: fixture, timeout: 5000, encoding: 'utf8'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scripts/picpeak-setup.sh');
    expect(fs.readdirSync(fixture)).toEqual([]);
  });

  test.each(['0022', '0027'])('verified child keeps caller umask %s for public repository files', mask => {
    const result = run('install_nodejs; printf "CALLER_UMASK:%s\\n" "$(umask)" >> "$EVENTS"', {
      env: { FIXTURE_UMASK: mask },
      payloadSuffix: 'printf "CHILD_UMASK:%s\\n" "$(umask)" >> "$EVENTS"\nprintf repository | tee "$FIXTURE_ROOT/repository.sources" >/dev/null\n'
    });
    expect(result.status).toBe(0);
    expect(result.events).toContain('CHILD_UMASK:' + mask);
    expect(result.events).toContain('CALLER_UMASK:' + mask);
    expect(fs.statSync(path.join(fixture, 'repository.sources')).mode & 0o777).toBe(0o666 & ~parseInt(mask, 8));
  });

  test.each(['fail', 'tamper', 'empty'])('Docker refuses %s response before services/groups, even under if', mode => {
    const result = run('if install_docker; then printf UNEXPECTED_SUCCESS >> "$EVENTS"; fi', {
      env: { CURL_MODE: mode, FIXTURE_SUDO_USER: 'fixture-user' }
    });
    expect(result.status).toBe(1);
    expect(result.events).not.toMatch(/VERIFIED_EXECUTED|ATTACKER_EXECUTED|SERVICE:|GROUP:|UNEXPECTED_SUCCESS/);
  });

  test.each(['apt', 'dnf', 'yum'])('Node %s verifies bootstrap before package install and accepts the new version', manager => {
    const result = run('install_nodejs', { env: { MANAGER: manager } });
    expect(result.status).toBe(0);
    expect(result.events).toContain('VERIFIED_EXECUTED');
    expect(result.events).toContain(manager === 'apt' ? 'scripts/deb/setup_22.x' : 'scripts/rpm/setup_22.x');
    expect(result.events.indexOf('VERIFIED_EXECUTED')).toBeLessThan(result.events.indexOf('PACKAGE:'));
    expect(result.events).toContain('install -y nodejs');
  });

  test.each(['apt', 'dnf', 'yum'])('Node %s rejects altered bytes before package installation', manager => {
    const result = run('if install_nodejs; then :; fi', { env: { MANAGER: manager, CURL_MODE: 'tamper' } });
    expect(result.status).toBe(1);
    expect(result.events).not.toMatch(/VERIFIED_EXECUTED|ATTACKER_EXECUTED|PACKAGE:/);
  });

  test('successful Docker preserves service and sudo group setup', () => {
    const result = run('install_docker', { env: { FIXTURE_SUDO_USER: 'fixture-user' } });
    expect(result.status).toBe(0);
    expect(result.events).toContain('SERVICE:start docker');
    expect(result.events).toContain('SERVICE:enable docker');
    expect(result.events).toContain('GROUP:-aG docker fixture-user');
  });

  test.each(['dnf', 'yum'])('Docker %s retains native repository installation without bootstrap', manager => {
    const result = run('install_docker', { env: { MANAGER: manager } });
    expect(result.status).toBe(0);
    expect(result.events).toContain('config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo');
    expect(result.events).toContain('install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin');
    expect(result.events).not.toMatch(/CURL:|HASH|VERIFIED_EXECUTED/);
  });

  test('existing Docker skips download and service/group mutation', () => {
    const result = run('install_docker', { env: { EXISTING_DOCKER: 'yes', FIXTURE_SUDO_USER: 'fixture-user' } });
    expect(result.status).toBe(0);
    expect(result.events).toBe('');
  });

  test.each(['22.12.0', '22.99.0', '24.0.0'])('existing Node %s is unchanged without network or checksum tools', version => {
    const result = run('install_nodejs', { existingNode: version, env: { MISSING_TOOL: 'sha256sum' } });
    expect(result.status).toBe(0);
    expect(result.events).toBe('');
  });

  test.each(['18.20.0', '22.11.0', 'garbage'])('unsupported Node %s still follows verified installation', version => {
    const result = run('install_nodejs', { existingNode: version });
    expect(result.status).toBe(0);
    expect(result.events).toContain('VERIFIED_EXECUTED');
  });

  test('postinstall runtime verification remains enforced', () => {
    const result = run('install_nodejs', { env: { INSTALLED_NODE: '22.11.0' } });
    expect(result.status).toBe(1);
    expect(result.events).toContain('does not satisfy the backend requirement');
  });

  test.each(['curl', 'sha256sum', 'bash'])('missing %s fails closed before fetch/package install', tool => {
    const result = run('install_nodejs', { env: { MISSING_TOOL: tool } });
    expect(result.status).toBe(1);
    expect(result.events).not.toMatch(/CURL:|PACKAGE:|VERIFIED_EXECUTED/);
    expect(result.events).toContain('install these first');
  });

  test('hash command failure refuses execution and cleans the private download', () => {
    const result = run('install_nodejs', { env: { HASH_MODE: 'fail' } });
    expect(result.status).toBe(1);
    expect(result.events).not.toMatch(/VERIFIED_EXECUTED|PACKAGE:/);
  });

  test('environment-supplied digest cannot bless a response using production pins', () => {
    const result = run('install_docker', { realPins: true, env: { DOCKER_BOOTSTRAP_SHA256: 'ignored' } });
    expect(result.status).toBe(1);
    expect(result.events).toContain('SHA-256 mismatch');
    expect(result.events).not.toContain('VERIFIED_EXECUTED');
  });

  test('verified bootstrap failure propagates, without later package/service actions', () => {
    const result = run('install_nodejs', { payloadSuffix: 'exit 19\n' });
    expect(result.status).toBe(1);
    expect(result.events).toContain('VERIFIED_EXECUTED');
    expect(result.events).not.toMatch(/PACKAGE:|SERVICE:/);
  });

  test('native update detects OS on demand and refuses tampering before stopping PicPeak', () => {
    const result = run('update_native_installation', { env: { MANAGER: '', CURL_MODE: 'tamper', DETECTED_MANAGER: 'yum' } });
    expect(result.status).toBe(1);
    expect(result.events).toContain('DETECT_OS');
    expect(result.events).toContain('scripts/rpm/setup_22.x');
    expect(result.events).not.toMatch(/PACKAGE:|SERVICE:|VERIFIED_EXECUTED/);
  });

  test('update-style OS detection preserves an already supported higher Node major', () => {
    const result = run('install_nodejs', { existingNode: '24.0.0', env: { MANAGER: '' } });
    expect(result.status).toBe(0);
    expect(result.events).toBe('DETECT_OS\n');
  });

  test.each([
    ['http://raw.githubusercontent.com/docker/docker-install/' + 'a'.repeat(40) + '/install.sh', 'sh'],
    ['https://raw.githubusercontent.com/docker/docker-install/main/install.sh', 'sh'],
    ['https://raw.githubusercontent.com/docker/docker-install/' + 'a'.repeat(40) + '/install.sh', 'python']
  ])('invalid pin or interpreter refuses before download: %s, %s', (url, interpreter) => {
    const result = run('run_verified_bootstrap "$FIXTURE_URL" "$FIXTURE_DIGEST" "$FIXTURE_INTERPRETER"', {
      env: { FIXTURE_URL: url, FIXTURE_INTERPRETER: interpreter }
    });
    expect(result.status).toBe(1);
    expect(result.events).not.toMatch(/CURL:|VERIFIED_EXECUTED/);
  });
});
