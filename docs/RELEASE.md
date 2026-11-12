# Releasing (maintainer only)

Only Alex publishes to npm. Agents prepare the release (CHANGELOG, tag, GitHub release with an
`npm pack` tarball) and stop before `npm publish`.

## Current state

- v0.1.0 is tagged and has a [GitHub release](https://github.com/alexnieves-cs/ccxray/releases/tag/v0.1.0)
  with `tknxray-0.1.0.tgz` attached.
- The `tknxray` package is **not on npm yet**, so `npx tknxray` fails until step 3 below is done.

## Publish to npm

1. Start from a clean, up-to-date `main` at the release tag:
   ```sh
   git switch main && git pull
   git checkout v0.1.0          # or stay on main if it equals the tag
   pnpm install --frozen-lockfile
   ```
2. Check what will ship. `prepublishOnly` also runs lint, typecheck and tests (the build runs as
   part of `pnpm test`).
   ```sh
   pnpm lint && pnpm typecheck && pnpm test
   npm pack --dry-run   # expect LICENSE, README.md, package.json, bin/, dist/, hooks/, schema/
   ```
3. Log in and publish (needs the npm account that will own `tknxray`; 2FA prompts for an OTP):
   ```sh
   npm login                    # once per machine
   npm whoami                   # confirm the account
   npm publish --access public
   ```
4. Confirm it worked:
   ```sh
   npm view tknxray version     # expect 0.1.0
   npx tknxray@latest --version
   ```
5. Update the README: remove the "not published yet" notes in **Install and usage** and make
   `npx tknxray` the main install command again.

## Next release

1. Bump `version` in package.json and add a dated section to CHANGELOG.md.
2. Merge to `main` with CI green.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Create the GitHub release with the tarball:
   ```sh
   pnpm build && npm pack
   gh release create vX.Y.Z tknxray-X.Y.Z.tgz --title vX.Y.Z --notes-file <notes>
   ```
5. Publish to npm as above.
