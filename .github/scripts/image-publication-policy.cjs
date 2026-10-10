'use strict';

// Read-only policy. Repository/tag protections remain an essential external
// boundary: an old tagged workflow cannot be secured by editing this file.
const SHA = /^[a-f0-9]{40}$/;
const VERSION_TAG = /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-beta\.(0|[1-9][0-9]{0,8}))?$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Image publication refused: ${message}`);
}

async function imagePublicationPolicy({ github, context, workflowRef, inputs = {} }) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  requireCondition(SHA.test(context.sha), 'invalid triggering commit');
  const releaseRequested = ['release_tag', 'release_sha', 'release_id']
    .some((key) => inputs[key] !== undefined && inputs[key] !== '');
  const verifyOnly = context.eventName === 'pull_request' ||
    (context.eventName === 'workflow_dispatch' && inputs.push !== 'true');
  if (verifyOnly) {
    requireCondition(!releaseRequested, 'release inputs are not allowed in verify-only runs');
    return { publish: 'false', sha: context.sha, release_tag: '', channel: '', tags: '' };
  }

  const branch = context.ref === 'refs/heads/main' ? 'main' :
    context.ref === 'refs/heads/stable' ? 'stable' : null;
  requireCondition(branch && ['push', 'workflow_dispatch'].includes(context.eventName),
    'only protected main/stable branch runs can publish');
  const releaseWorkflow = branch === 'main' ? 'release-please-beta.yml' : 'release-please.yml';
  const expectedWorkflow = releaseRequested ? releaseWorkflow : 'docker-build.yml';
  requireCondition(workflowRef === `${repository}/.github/workflows/${expectedWorkflow}@refs/heads/${branch}`,
    'unexpected caller workflow or ref');
  if (releaseRequested) {
    requireCondition(context.eventName === 'push', 'release publication must follow Release Please');
  }
  const read = async (route, parameters = {}) => (await github.request(route,
    { owner, repo, ...parameters })).data;
  const protectedBranch = await read('GET /repos/{owner}/{repo}/branches/{branch}', { branch });
  requireCondition(protectedBranch.protected === true && SHA.test(protectedBranch.commit?.sha),
    'source branch is not protected');
  async function requireAncestor(base, head) {
    const comparison = await read('GET /repos/{owner}/{repo}/compare/{base}...{head}', { base, head });
    requireCondition(['ahead', 'identical'].includes(comparison.status) &&
      comparison.merge_base_commit?.sha === base, 'source is outside protected branch history');
  }
  await requireAncestor(context.sha, protectedBranch.commit.sha);

  let sha = context.sha;
  let tag = '';
  let version;
  if (releaseRequested) {
    tag = inputs.release_tag;
    version = typeof tag === 'string' && tag.match(VERSION_TAG);
    requireCondition(version && SHA.test(inputs.release_sha) &&
      /^[1-9][0-9]*$/.test(inputs.release_id) && Number.isSafeInteger(Number(inputs.release_id)),
    'invalid Release Please output');
    requireCondition(Boolean(version[4]) === (branch === 'main'), 'tag does not match release channel');
    let object = (await read('GET /repos/{owner}/{repo}/git/ref/{ref}', { ref: `tags/${tag}` })).object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
      requireCondition(SHA.test(object.sha), 'invalid annotated tag object');
      object = (await read('GET /repos/{owner}/{repo}/git/tags/{tag_sha}', { tag_sha: object.sha })).object;
    }
    requireCondition(object?.type === 'commit' && object.sha === inputs.release_sha,
      'tag target differs from Release Please output');
    sha = object.sha;
    await requireAncestor(sha, context.sha);
    const release = await read('GET /repos/{owner}/{repo}/releases/tags/{tag}', { tag });
    requireCondition(String(release.id) === inputs.release_id && release.tag_name === tag &&
      release.draft === false && release.prerelease === Boolean(version[4]),
    'release identity or channel differs from Release Please output');
  }

  // A job referencing a nonexistent environment would silently create it with
  // no reviewers. Check it before any environment job or registry write.
  const environment = await read('GET /repos/{owner}/{repo}/environments/{environment_name}',
    { environment_name: 'picpeak-release' });
  const approval = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  requireCondition(approval?.prevent_self_review === true && approval.reviewers?.length > 0 &&
    environment.deployment_branch_policy?.protected_branches === true &&
    environment.deployment_branch_policy?.custom_branch_policies === false,
  'picpeak-release needs required reviewers, no self-review and protected-branch deployments');
  // REST does not consistently expose the admin-bypass setting. Disabling it
  // is an explicit operator prerequisite; do not pretend its absence proves it.
  requireCondition(environment.can_admins_bypass !== true, 'environment permits admin bypass');

  const channel = branch === 'main' ? 'beta' : 'stable';
  const tags = tag ? [tag.slice(1), tag] : [branch];
  if (version && channel === 'stable') tags.push(`${version[1]}.${version[2]}`, version[1]);
  if (channel === 'stable') tags.push('latest', 'stable');
  if (!tag && branch === 'main') tags.push('beta');
  tags.push(`sha-${sha.slice(0, 7)}`);
  return { publish: 'true', sha, release_tag: tag, channel,
    tags: [...new Set(tags)].map((value) => `type=raw,value=${value}`).join('\n') };
}

module.exports = imagePublicationPolicy;
