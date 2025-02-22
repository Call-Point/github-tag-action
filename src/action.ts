import * as core from '@actions/core';
import { gte, inc, parse, ReleaseType, SemVer, valid } from 'semver';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes } from '@semantic-release/release-notes-generator';
import {
  getBranchFromRef,
  isPr,
  getCommits,
  getLatestPrereleaseTag,
  getLatestTag,
  getValidTags,
  mapCustomReleaseRules,
  mergeWithDefaultChangelogRules,
} from './utils';
import { createTag } from './github';
import { Await } from './ts';

export default async function main() {
  const bump = core.getInput('bump') as ReleaseType;
  const tagPrefix = core.getInput('tag_prefix');
  const customTag = core.getInput('custom_tag');
  const releaseBranches = core.getInput('release_branches');
  const preReleaseBranches = core.getInput('pre_release_branches');
  const appendToPreReleaseTag = core.getInput('append_to_pre_release_tag');
  const createAnnotatedTag = !!core.getInput('create_annotated_tag');
  const tagMessage = core.getInput('tag_message')
  const dryRun = core.getInput('dry_run');
  const customReleaseRules = core.getInput('custom_release_rules');
  const shouldFetchAllTags = core.getInput('fetch_all_tags');
  const commitSha = core.getInput('commit_sha');

  let mappedReleaseRules;
  if (customReleaseRules) {
    mappedReleaseRules = mapCustomReleaseRules(customReleaseRules);
  }

  const { GITHUB_REF, GITHUB_SHA } = process.env;

  if (!GITHUB_REF) {
    core.setFailed('Missing GITHUB_REF.');
    return;
  }

  const commitRef = commitSha || GITHUB_SHA;
  if (!commitRef) {
    core.setFailed('Missing commit_sha or GITHUB_SHA.');
    return;
  }

  const currentBranch = getBranchFromRef(GITHUB_REF);
  const isReleaseBranch = releaseBranches
    .split(',')
    .some((branch) => currentBranch.match(branch));
  const isPreReleaseBranch = preReleaseBranches
    .split(',')
    .some((branch) => currentBranch.match(branch));
  const isPullRequest = isPr(GITHUB_REF);
  const isPrerelease = !isReleaseBranch && !isPullRequest && isPreReleaseBranch;

  // Sanitize identifier according to
  // https://semver.org/#backusnaur-form-grammar-for-valid-semver-versions
  const identifier = (
    appendToPreReleaseTag ? appendToPreReleaseTag : currentBranch
  ).replace(/[^a-zA-Z0-9-]/g, '-');

  const prefixRegex = new RegExp(`^${tagPrefix}`);

  const validTags = await getValidTags(
    prefixRegex,
    /true/i.test(shouldFetchAllTags)
  );
  const latestTag = getLatestTag(validTags, prefixRegex, tagPrefix);
  const latestPrereleaseTag = getLatestPrereleaseTag(
    validTags,
    identifier,
    prefixRegex
  );

  let commits: Await<ReturnType<typeof getCommits>>;

  let newVersion: string;

  if (customTag) {
    commits = await getCommits(latestTag.commit.sha, commitRef);

    core.setOutput('release_type', 'custom');
    newVersion = customTag;
  } else {
    let previousTag: ReturnType<typeof getLatestTag> | null;
    let previousVersion: SemVer | null;
    if (!latestPrereleaseTag) {
      previousTag = latestTag;
    } else {
      previousTag = gte(
        latestTag.name.replace(prefixRegex, ''),
        latestPrereleaseTag.name.replace(prefixRegex, '')
      )
        ? latestTag
        : latestPrereleaseTag;
    }

    if (!previousTag) {
      core.setFailed('Could not find previous tag.');
      return;
    }

    previousVersion = parse(previousTag.name.replace(prefixRegex, ''));

    if (!previousVersion) {
      core.setFailed('Could not parse previous tag.');
      return;
    }

    core.info(
      `Previous tag was ${previousTag.name}, previous version was ${previousVersion.version}.`
    );
    core.setOutput('previous_version', previousVersion.version);
    core.setOutput('previous_tag', previousTag.name);

    commits = await getCommits(previousTag.commit.sha, commitRef);

    core.setOutput('release_type', bump);

    const incrementedVersion = inc(previousVersion, bump, identifier);

    if (!incrementedVersion) {
      core.setFailed('Could not increment version.');
      return;
    }

    if (!valid(incrementedVersion)) {
      core.setFailed(`${incrementedVersion} is not a valid semver.`);
      return;
    }

    newVersion = incrementedVersion;
  }

  core.info(`New version is ${newVersion}.`);
  core.setOutput('new_version', newVersion);

  const newTag = `${tagPrefix}${newVersion}`;
  core.info(`New tag after applying prefix is ${newTag}.`);
  core.setOutput('new_tag', newTag);

  const changelog = await generateNotes(
    {
      preset: 'conventionalcommits',
      presetConfig: {
        types: mergeWithDefaultChangelogRules(mappedReleaseRules),
      },
    },
    {
      commits,
      logger: { log: console.info.bind(console) },
      options: {
        repositoryUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`,
      },
      lastRelease: { gitTag: latestTag.name },
      nextRelease: { gitTag: newTag, version: newVersion },
    }
  );
  core.info(`Changelog is ${changelog}.`);
  core.setOutput('changelog', changelog);

  if (!isReleaseBranch && !isPreReleaseBranch) {
    core.info(
      'This branch is neither a release nor a pre-release branch. Skipping the tag creation.'
    );
    return;
  }

  if (validTags.map((tag) => tag.name).includes(newTag)) {
    core.info('This tag already exists. Skipping the tag creation.');
    return;
  }

  if (/true/i.test(dryRun)) {
    core.info('Dry run: not performing tag action.');
    return;
  }

  await createTag(newTag, createAnnotatedTag, commitRef, tagMessage);
}
