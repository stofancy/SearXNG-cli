# Releasing

Releases are tag-driven and must match the version in `package.json`.

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` in a pull request.
2. Merge only after CI and CodeQL pass.
3. Create and push an annotated `vMAJOR.MINOR.PATCH` tag.
4. The release workflow verifies the tag, runs checks, creates a GitHub release with the package archive, and publishes the scoped package to npm with provenance.

Before the first npm release, configure npm Trusted Publishing for repository `stofancy/SearXNG-cli`, workflow `release.yml`, and GitHub environment `npm`. Do not add a long-lived npm token to repository secrets.

If npm publishing fails after the GitHub release is created, do not move or recreate the tag. Correct the trusted publisher configuration and rerun the failed workflow job.
