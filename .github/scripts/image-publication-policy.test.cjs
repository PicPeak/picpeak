'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const policy = require('./image-publication-policy.cjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function environment(name) {
  return { protection_rules: [
    { type: 'branch_policy' },
    ...(name === 'picpeak-release' ? [{ type: 'required_reviewers', prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { login: 'the-luap', id: 1 } }] }] : [])
  ], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  can_admins_bypass: false };
}

function fixture({ branch = 'stable', release = false, overrides = {}, inputs = {} } = {}) {
  const calls = [];
  const caller = release ? (branch === 'main' ? 'release-please-beta.yml' : 'release-please.yml') : 'docker-build.yml';
  const tag = branch === 'main' ? 'v3.4.5-beta.0' : 'v3.4.5';
  const responses = {
    '/branches/': { protected: true, commit: { sha: B } },
    '/compare/': ({ base }) => ({ status: 'ahead', merge_base_commit: { sha: base } }),
    '/git/ref/': { object: { type: 'commit', sha: A } },
    '/releases/tags/': { id: 42, tag_name: tag, draft: false, prerelease: branch === 'main' },
    '/deployment_protection_rules': { total_count: 0, custom_deployment_protection_rules: [] },
    '/environments/': ({ environment_name }) => environment(environment_name),
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
    const result = await policy(f);
    assert.equal(result.publish, 'false');
    assert.equal(result.gate_environment, '');
    assert.equal(f.calls.length, 0);
  }
});

test('protected rolling pushes and explicit manual true authorize automatically with original tags', async () => {
  for (const branch of ['main', 'stable']) {
    for (const eventName of ['push', 'workflow_dispatch']) {
      const f = fixture({ branch, inputs: { push: 'true' } });
      f.context.eventName = eventName;
      const result = await policy(f);
      assert.equal(result.publish, 'true');
      assert.equal(result.sha, B);
      assert.equal(result.gate_environment, 'picpeak-publication');
      assert.deepEqual(f.calls.filter(({ route }) => route.includes('/environments/'))
        .map(({ parameters }) => parameters.environment_name),
      ['picpeak-publication', 'picpeak-publication']);
      assert.match(result.tags, new RegExp(`value=${branch}(?:\\n|$)`));
      assert.equal(result.tags.includes('value=latest'), branch === 'stable');
      assert.equal(result.tags.includes('value=beta'), branch === 'main');
    }
  }
});

test('trusted Release Please output publishes exact stable/beta tags and revision', async () => {
  for (const branch of ['main', 'stable']) {
    const f = fixture({ branch, release: true });
    const result = await policy(f);
    assert.equal(result.sha, A);
    assert.equal(result.gate_environment, 'picpeak-release');
    assert.deepEqual(f.calls.filter(({ route }) => route.includes('/environments/'))
      .map(({ parameters }) => parameters.environment_name),
    ['picpeak-publication', 'picpeak-publication', 'picpeak-release', 'picpeak-release']);
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
  for (const inputs of [{ release_tag: 'v3.4.5' }, { release_sha: A }, { release_id: '42' }]) {
    await assert.rejects(policy(fixture({ inputs })), /unexpected caller/);
  }
  const manualRelease = fixture({ release: true, inputs: { push: 'true' } });
  manualRelease.context.eventName = 'workflow_dispatch';
  await assert.rejects(policy(manualRelease), /must follow Release Please/);
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

test('missing or weak protected-branch controls cannot authorize either environment', async () => {
  for (const name of ['picpeak-publication', 'picpeak-release']) {
    for (const values of [{ protection_rules: undefined }, { deployment_branch_policy: null },
      { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
      { can_admins_bypass: true }]) {
      const f = fixture({ release: true, overrides: {
        '/environments/': ({ environment_name }) => ({
          ...environment(environment_name), ...(environment_name === name ? values : {})
        })
      } });
      await assert.rejects(policy(f), /protected-branch|admin bypass/);
    }
  }
});

test('rolling publication refuses reviewers, wait timers and unknown gates', async () => {
  for (const rule of [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{}] },
    { type: 'wait_timer', wait_timer: 1 }, { type: 'unknown' }]) {
    await assert.rejects(policy(fixture({ overrides: {
      '/environments/': { ...environment('picpeak-publication'), protection_rules: [rule] }
    } })), /publish automatically/);
  }
});

test('versions still need reviewers but must permit maintainer self-review', async () => {
  for (const rules of [[], [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{}] }],
    [{ type: 'required_reviewers', reviewers: [{}] }],
    [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [] }],
    [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{}] },
      { type: 'wait_timer', wait_timer: 1 }],
    [...environment('picpeak-release').protection_rules,
      { type: 'required_reviewers', prevent_self_review: true, reviewers: [{}] }]]) {
    await assert.rejects(policy(fixture({ release: true, overrides: {
      '/environments/': ({ environment_name }) => environment_name === 'picpeak-release' ?
        { ...environment(environment_name), protection_rules: rules } : environment(environment_name)
    } })), /required reviewers with self-review/);
  }
});

test('custom deployment gates or unreadable metadata fail closed in either environment', async () => {
  for (const name of ['picpeak-publication', 'picpeak-release']) {
    for (const custom of [{}, { total_count: 1, custom_deployment_protection_rules: [{ id: 1 }] },
      { total_count: 0, custom_deployment_protection_rules: [{ id: 1 }] }]) {
      await assert.rejects(policy(fixture({ release: true, overrides: {
        '/deployment_protection_rules': ({ environment_name }) => environment_name === name ?
          custom : { total_count: 0, custom_deployment_protection_rules: [] }
      } })), /custom deployment gates/);
    }
  }
});

test('all provenance and environment API failures refuse publication', async () => {
  for (const target of ['/branches/', '/compare/', '/git/ref/', '/releases/tags/']) {
    const f = fixture({ release: true, overrides: { [target]: () => { throw new Error('API unavailable'); } } });
    await assert.rejects(policy(f), /API unavailable/);
  }
  for (const target of ['/environments/', '/deployment_protection_rules']) {
    for (const name of ['picpeak-publication', 'picpeak-release']) {
      const f = fixture({ release: true, overrides: { [target]: ({ environment_name }) => {
        if (environment_name === name) throw new Error('API unavailable');
        return target === '/environments/' ? environment(environment_name) :
          { total_count: 0, custom_deployment_protection_rules: [] };
      } } });
      await assert.rejects(policy(f), /API unavailable/);
    }
  }
});

test('rolling runs do not require a release environment and callers cannot choose the gate', async () => {
  const f = fixture({ inputs: { gate_environment: 'unprotected', release_environment: 'unprotected' },
    overrides: { '/environments/': ({ environment_name }) => {
      assert.equal(environment_name, 'picpeak-publication');
      return environment(environment_name);
    } } });
  assert.equal((await policy(f)).gate_environment, 'picpeak-publication');
  const release = fixture({ release: true, inputs: { gate_environment: 'picpeak-publication' } });
  assert.equal((await policy(release)).gate_environment, 'picpeak-release');
});
