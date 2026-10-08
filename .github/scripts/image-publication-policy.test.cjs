'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const policy = require('./image-publication-policy.cjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function fixture({ branch = 'stable', release = false, overrides = {}, inputs = {} } = {}) {
  const calls = [];
  const caller = release ? (branch === 'main' ? 'release-please-beta.yml' : 'release-please.yml') : 'docker-build.yml';
  const tag = branch === 'main' ? 'v3.4.5-beta.0' : 'v3.4.5';
  const responses = {
    '/branches/': { protected: true, commit: { sha: B } },
    '/compare/': ({ base }) => ({ status: 'ahead', merge_base_commit: { sha: base } }),
    '/git/ref/': { object: { type: 'commit', sha: A } },
    '/releases/tags/': { id: 42, tag_name: tag, draft: false, prerelease: branch === 'main' },
    '/environments/': { protection_rules: [{ type: 'required_reviewers', prevent_self_review: true,
      reviewers: [{ type: 'Team', reviewer: { id: 1 } }] }],
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
    ...overrides
  };
  return { calls, context: { repo: { owner: 'PicPeak', repo: 'picpeak' }, sha: B,
    eventName: 'push', ref: `refs/heads/${branch}` },
  workflowRef: `PicPeak/picpeak/.github/workflows/${caller}@refs/heads/${branch}`,
  inputs: { ...(release ? { release_tag: tag, release_sha: A, release_id: '42' } : {}), ...inputs },
  github: { request: async (route, parameters) => {
    calls.push({ route, parameters });
    const entry = Object.entries(responses).find(([fragment]) => route.includes(fragment));
    assert.ok(entry, `Unexpected API route ${route}`);
    const value = typeof entry[1] === 'function' ? await entry[1](parameters) : entry[1];
    return { data: value };
  } } };
}

test('PR and manual false are verify-only without environment/API access', async () => {
  for (const eventName of ['pull_request', 'workflow_dispatch']) {
    const f = fixture({ inputs: { push: 'false' } });
    f.context.eventName = eventName;
    f.context.ref = 'refs/tags/v99.99.99';
    assert.equal((await policy(f)).publish, 'false');
    assert.equal(f.calls.length, 0);
  }
});

test('protected rolling channels and explicit manual true retain their tags', async () => {
  for (const branch of ['main', 'stable']) {
    const f = fixture({ branch, inputs: { push: 'true' } });
    f.context.eventName = 'workflow_dispatch';
    const result = await policy(f);
    assert.equal(result.publish, 'true');
    assert.equal(result.sha, B);
    assert.match(result.tags, new RegExp(`value=${branch}(?:\\n|$)`));
    assert.equal(result.tags.includes('value=latest'), branch === 'stable');
    assert.equal(result.tags.includes('value=beta'), branch === 'main');
  }
});

test('trusted Release Please output publishes exact stable/beta tags and revision', async () => {
  for (const branch of ['main', 'stable']) {
    const f = fixture({ branch, release: true });
    const result = await policy(f);
    assert.equal(result.sha, A);
    assert.ok(result.tags.includes(`value=${f.inputs.release_tag}`));
    assert.equal(result.tags.includes('value=latest'), branch === 'stable');
    assert.ok(!result.tags.includes('value=main'));
    assert.ok(!result.tags.includes('value=beta\n'));
  }
});

test('arbitrary tag/release/branch and forged caller publication is refused', async () => {
  for (const [key, value] of [['ref', 'refs/tags/v3.4.5'], ['ref', 'refs/heads/unreviewed'],
    ['eventName', 'release'], ['eventName', 'pull_request_target']]) {
    const f = fixture(); f.context[key] = value;
    await assert.rejects(policy(f), /only protected/);
  }
  const f = fixture({ release: true });
  f.workflowRef = 'PicPeak/picpeak/.github/workflows/hostile.yml@refs/heads/stable';
  await assert.rejects(policy(f), /unexpected caller/);
  const direct = fixture({ release: false, inputs: { release_tag: 'v3.4.5', release_sha: A, release_id: '42' } });
  await assert.rejects(policy(direct), /unexpected caller/);
});

test('unprotected or unrelated history fails closed', async () => {
  for (const overrides of [{ '/branches/': { protected: false, commit: { sha: B } } },
    { '/compare/': { status: 'diverged', merge_base_commit: { sha: C } } },
    { '/compare/': { status: 'ahead', merge_base_commit: { sha: C } } }]) {
    await assert.rejects(policy(fixture({ overrides })), /not protected|outside protected/);
  }
});

test('tag rewrites, invalid encodings, release identity/channel and drafts are refused', async () => {
  for (const inputs of [{ release_tag: 'v3.4.5\nlatest' }, { release_tag: 'v03.4.5' },
    { release_tag: 'v3.4.5-beta.0' }, { release_sha: C }, { release_id: '0' }, { release_id: '42x' }]) {
    await assert.rejects(policy(fixture({ release: true, inputs })), /invalid|channel|differs/);
  }
  for (const values of [{ id: 41 }, { draft: true }, { prerelease: true }, { tag_name: 'v3.4.6' }]) {
    const f = fixture({ release: true, overrides: {
      '/releases/tags/': { id: 42, tag_name: 'v3.4.5', draft: false, prerelease: false, ...values }
    } });
    await assert.rejects(policy(f), /release identity/);
  }
});

test('annotated tags are peeled with a finite depth and exact target', async () => {
  const overrides = { '/git/ref/': { object: { type: 'tag', sha: C } },
    '/git/tags/': { object: { type: 'commit', sha: A } } };
  assert.equal((await policy(fixture({ release: true, overrides }))).sha, A);
  overrides['/git/tags/'] = { object: { type: 'tag', sha: C } };
  const f = fixture({ release: true, overrides });
  await assert.rejects(policy(f), /tag target/);
  assert.equal(f.calls.filter(({ route }) => route.includes('/git/tags/')).length, 5);
});

test('missing/weak environment or API failure cannot authorize publishing', async () => {
  for (const environment of [{}, { protection_rules: [] },
    { protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{}] }] }]) {
    await assert.rejects(policy(fixture({ overrides: { '/environments/': environment } })), /needs required/);
  }
  for (const target of ['/branches/', '/compare/', '/git/ref/', '/releases/tags/', '/environments/']) {
    const f = fixture({ release: true, overrides: { [target]: () => { throw new Error('API unavailable'); } } });
    await assert.rejects(policy(f), /API unavailable/);
  }
});
