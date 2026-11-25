# Releasing (maintainer only)

Only Alex publishes to npm. Agents prepare a release (version, CHANGELOG, README, a passing
`npm pack --dry-run`) on a branch and stop before any push, merge, tag or `npm publish`.

## Current state

- v0.1.0 is tagged and has a [GitHub release](https://github.com/alexnieves-cs/ccxray/releases/tag/v0.1.0)
  with `tknxray-0.1.0.tgz` attached. It was never published to npm.
- 0.2.0 is prepared on the `release-0.2` branch: `package.json` and `src/version.ts` say
  `0.2.0`, CHANGELOG.md has its section, and the README treats `npx tknxray` as the install
  command (true once the publish below is done).

## One-time setup (before the first publish)

`.github/workflows/release.yml` publishes with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
when a `vX.Y.Z` tag is pushed. It needs:

1. **An npm token.** On npmjs.com, sign in as the account that will own `tknxray` and create a
   granular access token with read and write access to packages. `tknxray` does not exist yet,
   so the first token can't be limited to it; narrow it, or switch to a trusted publisher, once
   the package exists.
2. **The repo secret** `NPM_TOKEN` holding that token: GitHub → Settings → Secrets and variables →
   Actions → New repository secret.
3. **Recommended: an `npm` environment with you as a required reviewer** (Settings →
   Environments → `npm`). The job runs in that environment, so every publish then waits for your
   approval in the Actions tab. Without it, pushing the tag is the approval.

## Publish a release

1. Merge the release branch to `main` with CI green, then update your checkout:
   ```sh
   git switch main && git pull
   ```
2. Optional local check of what will ship (the workflow runs the same checks):
   ```sh
   pnpm install --frozen-lockfile
   pnpm lint && pnpm typecheck && pnpm test
   npm pack --dry-run   # LICENSE, README.md, package.json, bin/, dist/, hooks/, schema/
   ```
3. Tag and push. This is the one command that publishes:
   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```
   The workflow checks that the tag matches `package.json`, runs lint, typecheck and tests, then
   runs `npm publish --provenance --access public`. Approve it in the Actions tab if you set up
   the environment.
4. Confirm it worked, then make the GitHub release with the tarball:
   ```sh
   npm view tknxray version          # expect 0.2.0
   npx tknxray@latest --version
   pnpm build && npm pack
   gh release create v0.2.0 tknxray-0.2.0.tgz --title v0.2.0 --notes-file <notes>
   ```

**Without the workflow** (no provenance): `npm login`, `npm whoami`, then
`npm publish --access public` from a clean `main` at the tag; `prepublishOnly` runs lint,
typecheck and tests first. Then delete the README sentence that says releases carry provenance.

## Next release

1. Bump `version` in `package.json` and `src/version.ts`, and add a dated section to
   CHANGELOG.md.
2. Merge to `main` with CI green.
3. Tag and push as above.
