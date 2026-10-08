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
    assert.match(merge, /environment: picpeak-release/);
    assert.match(merge, /if: .*needs\.publication-policy\.outputs\.publish == 'true'/);
    assert.match(merge, /tags: \$\{\{ needs\.publication-policy\.outputs\.tags \}\}/);
    assert.match(merge, /flavor: latest=false/);
    assert.ok(!merge.includes('type=ref') && !merge.includes('type=semver'));
  }
  assert.match(job('approve-publication'), /environment: picpeak-release/);
  assert.match(job('summary'), /Require successful provenance and approval gates/);
  assert.match(job('dockerhub-descriptions'), /environment: picpeak-release/);
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
    assert.ok(!publish.includes('secrets:') && !publish.includes('RELEASE_PLEASE_TOKEN'));
  }
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
        if (route.includes('/environments/')) return { data: {
          protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{}] }],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
        } };
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
