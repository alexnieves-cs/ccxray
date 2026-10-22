# Releasing (maintainer only)

Only Alex publishes. Agents prepare the release and stop here.

1. Start from a clean, up-to-date `main`:
   ```sh
   git switch main && git pull
   pnpm install --frozen-lockfile
   ```
2. Check what will ship. `prepublishOnly` also runs lint, typecheck, tests and the build.
   ```sh
   pnpm lint && pnpm typecheck && pnpm test
   npm pack --dry-run   # expect 9 files: LICENSE, README.md, package.json, bin/, dist/, hooks/, schema/
   ```
3. Publish and confirm:
   ```sh
   npm login            # once per machine
   npm publish --access public
   npm view tknxray version
   npx tknxray@latest --version
   ```
4. Optional: tag the release commit and push the tag (`git tag v0.1.0 && git push origin v0.1.0`).

For the next release, bump `version` in package.json and add a section to CHANGELOG.md first.
