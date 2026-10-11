'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const policy = require('./image-publication-policy.cjs');
const workflowRoot = path.resolve(__dirname, '../workflows');
const docker = fs.readFileSync(path.join(workflowRoot, 'docker-build.yml'), 'utf8');

function job(name) {
  const block = docker.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(block, `Missing ${name}`);
  return block[1];
}

test('all publishers, revisions and manifests use the shared policy and approval', () => {
  assert.ok(!/^  release:/m.test(docker));
  assert.ok(!/^    tags: \[/m.test(docker));
  assert.ok(/^  workflow_call:/m.test(docker));
  for (const image of ['backend', 'frontend', 'aio', 'ml']) {
    const build = job(`build-${image}`);
    assert.match(build, /needs: \[publication-policy, approve-publication\]/);
    assert.match(build, /needs\.approve-publication\.result == 'success'/);
    assert.match(build, /ref: \$\{\{ needs\.publication-policy\.outputs\.sha \}\}/);
    assert.match(build, /PUBLISH: \$\{\{ needs\.publication-policy\.outputs\.publish \}\}/);
    assert.match(build, /org\.opencontainers\.image\.revision=\$\{\{ needs\.publication-policy\.outputs\.sha \}\}/);
    assert.match(build, /tags: \$\{\{ needs\.publication-policy\.outputs\.tags \|\| format\('type=raw,value=sha-/);
    assert.ok(!build.includes('continue-on-error: true\n      uses: docker/login-action'));
    const merge = job(`merge-${image}`);
    assert.match(merge, /needs: \[publication-policy, approve-publication, build-/);
    assert.match(merge, /environment: picpeak-publication/);
    assert.match(merge, /if: .*needs\.publication-policy\.outputs\.publish == 'true'/);
    assert.match(merge, /tags: \$\{\{ needs\.publication-policy\.outputs\.tags \}\}/);
    assert.match(merge, /flavor: latest=false/);
    assert.ok(!merge.includes('type=ref') && !merge.includes('type=semver'));
  }
  assert.match(job('publication-policy'), /gate_environment: \$\{\{ steps\.policy\.outputs\.gate_environment \}\}/);
  assert.match(job('approve-publication'),
    /environment: \$\{\{ needs\.publication-policy\.outputs\.gate_environment \}\}/);
  assert.match(job('approve-publication'), /if: needs\.publication-policy\.outputs\.publish == 'true'/);
  assert.ok(!job('approve-publication').includes('secrets.'));
  assert.match(job('summary'), /Require successful provenance and approval gates/);
  assert.match(job('dockerhub-descriptions'), /environment: picpeak-publication/);
  assert.match(job('dockerhub-descriptions'), /needs\.publication-policy\.outputs\.publish == 'true'/);
  assert.match(job('smoke-aio'), /ref: \$\{\{ needs\.publication-policy\.outputs\.sha \}\}/);
});

test('both trusted callers pass exact pinned-action outputs without broad secrets', () => {
  for (const name of ['release-please.yml', 'release-please-beta.yml']) {
    const caller = fs.readFileSync(path.join(workflowRoot, name), 'utf8');
    assert.match(caller, /googleapis\/release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071/);
    assert.match(caller, /sha: \$\{\{ steps\.release\.outputs\.sha \}\}/);
    assert.match(caller, /release_id: \$\{\{ steps\.release\.outputs\.id \}\}/);
    const publish = caller.split('  publish-images:')[1].split('  whatsnew:')[0];
    assert.match(publish, /release_created == 'true'/);
    assert.match(publish, /uses: \.\/\.github\/workflows\/docker-build.yml/);
    assert.match(publish, /release_sha: \$\{\{ needs\.release-please\.outputs\.sha \}\}/);
    assert.match(publish, /release_id: \$\{\{ needs\.release-please\.outputs\.release_id \}\}/);
    assert.ok(!publish.includes('secrets: inherit') && !publish.includes('RELEASE_PLEASE_TOKEN'));
    const secretNames = [...publish.matchAll(/^      ([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) \}\}/gm)];
    assert.deepEqual(secretNames.map((match) => [match[1], match[2]]), [
      ['DOCKERHUB_USERNAME', 'DOCKERHUB_USERNAME'], ['DOCKERHUB_TOKEN', 'DOCKERHUB_TOKEN']
    ]);
  }
  const call = docker.split('  workflow_call:')[1].split('# Separate rolling')[0];
  assert.match(call, /secrets:\n      DOCKERHUB_USERNAME:\n        required: true\n      DOCKERHUB_TOKEN:\n        required: true/);
});

// Evaluate the checked-in conditions, including GitHub's implicit success()
// for jobs without an explicit status function. This is not a hosted runner.
function eligible(name, needs, ml = true) {
  const block = job(name);
  const expression = block.match(/^    if: (.+)$/m)[1]
    .replace(/needs\.([a-z-]+)\./g, 'needs["$1"].');
  const dependencies = block.match(/^    needs: (.+)$/m)[1]
    .replace(/[\[\] ]/g, '').split(',');
  const implicitSuccess = /always\(\)/.test(expression) ||
    dependencies.every((dependency) => needs[dependency].result === 'success');
  return implicitSuccess && Function('needs', 'github', 'vars', 'always',
    `return (${expression});`)(needs, { repository: 'PicPeak/picpeak' },
    { FACENET_ONNX_URL: ml ? 'https://example.invalid/model' : '' }, () => true);
}

test('checked-in gates preserve automatic rolling, version approval and verify-only paths', () => {
  for (const release of [false, true]) {
    const needs = { 'publication-policy': { result: 'success', outputs: {
      publish: 'true', release_tag: release ? 'v3.4.5-beta.0' : '', channel: 'beta'
    } }, 'approve-publication': { result: 'success' } };
    assert.equal(eligible('approve-publication', needs), true);
    for (const image of ['backend', 'frontend', 'aio', 'ml']) {
      needs[`build-${image}`] = { result: 'success' };
      needs[`merge-${image}`] = { result: 'success' };
      assert.equal(eligible(`build-${image}`, needs), true);
      assert.equal(eligible(`merge-${image}`, needs), true);
      for (const result of ['failure', 'cancelled', 'skipped']) {
        needs['approve-publication'].result = result;
        assert.equal(eligible(`build-${image}`, needs), false);
        assert.equal(eligible(`merge-${image}`, needs), false);
      }
      needs['approve-publication'].result = 'success';
      needs[`build-${image}`].result = 'failure';
      assert.equal(eligible(`merge-${image}`, needs), false);
      needs[`build-${image}`].result = 'success';
    }
    assert.equal(eligible('dockerhub-descriptions', needs), !release);
    needs['merge-ml'].result = 'skipped';
    assert.equal(eligible('dockerhub-descriptions', needs, false), !release);
    assert.equal(eligible('build-ml', needs, false), false);
    assert.equal(eligible('merge-ml', needs, false), false);
    needs['publication-policy'].outputs.publish = 'false';
    needs['approve-publication'].result = 'skipped';
    assert.equal(eligible('approve-publication', needs), false);
    assert.equal(eligible('dockerhub-descriptions', needs), false);
    for (const image of ['backend', 'frontend', 'aio', 'ml']) {
      assert.equal(eligible(`build-${image}`, needs), true);
      assert.equal(eligible(`merge-${image}`, needs), false);
      needs['publication-policy'].result = 'failure';
      assert.equal(eligible(`build-${image}`, needs), false);
      needs['publication-policy'].result = 'success';
    }
  }
});

test('actual summary shell requires a successful automatic or reviewed publication gate', () => {
  const script = job('summary').split('    - name: Require successful provenance and approval gates')[1]
    .split('      run: |\n')[1].split('\n    - name:')[0].replace(/^        /gm, '');
  for (const publish of ['false', 'true']) {
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      const run = () => execFileSync('bash', ['-e', '-c', script], {
        env: { ...process.env, POLICY_RESULT: 'success', PUBLISH: publish, APPROVAL_RESULT: result },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (publish === 'false' || result === 'success') run();
      else assert.throws(run);
    }
  }
  assert.throws(() => execFileSync('bash', ['-e', '-c', script], {
    env: { ...process.env, POLICY_RESULT: 'failure', PUBLISH: 'false', APPROVAL_RESULT: 'skipped' },
    stdio: ['ignore', 'pipe', 'pipe']
  }));
});

test('real git history accepts protected ancestors and refuses a divergent publication', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-policy-history-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Policy fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Policy fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  try {
    git('init', '-q');
    git('commit', '--allow-empty', '-qm', 'root');
    const root = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-qm', 'reviewed');
    const reviewed = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'unreviewed', root);
    git('commit', '--allow-empty', '-qm', 'unrelated');
    const unrelated = git('rev-parse', 'HEAD');
    async function run(sha) {
      return policy({ context: { repo: { owner: 'PicPeak', repo: 'picpeak' }, sha,
        eventName: 'push', ref: 'refs/heads/stable' },
      workflowRef: 'PicPeak/picpeak/.github/workflows/docker-build.yml@refs/heads/stable',
      github: { request: async (route, parameters) => {
        if (route.includes('/branches/')) return { data: { protected: true, commit: { sha: reviewed } } };
        if (route.includes('/compare/')) {
          const mergeBase = git('merge-base', parameters.base, parameters.head);
          return { data: { status: mergeBase === parameters.base ? 'ahead' : 'diverged',
            merge_base_commit: { sha: mergeBase } } };
        }
        if (route.endsWith('/deployment_protection_rules')) return { data: {
          total_count: 0, custom_deployment_protection_rules: []
        } };
        if (route.includes('/environments/')) {
          assert.equal(parameters.environment_name, 'picpeak-publication');
          return { data: {
          protection_rules: [{ type: 'branch_policy' }],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
        } }; }
        throw new Error(`Unexpected API route ${route}`);
      } } });
    }
    assert.equal((await run(root)).sha, root);
    assert.equal((await run(reviewed)).sha, reviewed);
    await assert.rejects(run(unrelated), /outside protected branch history/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
