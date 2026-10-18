# CLAUDE.md: rules for agents working in this repo

Read `docs/SPEC.md` before changing anything. The spec is the source of truth. If you need to deviate from it, update the spec in the same PR and explain why.

## Hard rules
1. **No telemetry, ever.** Nothing in the runtime code may make a network call: no analytics, update checks, crash reporting or remote pricing fetches. CI enforces this (`test/no-network.test.ts` plus a dependency allowlist). Any optional remote feature must be opt-in, behind an explicit flag, and documented.
2. **Honest numbers.** Every number shown to users is labeled either *measured* (taken directly from `usage` fields in the logs) or *estimated* (heuristic tokenizer, ~chars/4, attribution guesses). Never present an estimate as exact. Benchmarks and README claims must be reproducible from a script in `bench/`.
3. **Don't invent schema.** The transcript format is undocumented and changes between Claude Code versions. Parse defensively: unknown fields are ignored, missing fields are tolerated, and malformed lines are counted and skipped. Any assumption not confirmed against a real log or fixture is marked `// UNVERIFIED:` in code and listed in SPEC §4.4.
4. **Privacy.** Never commit real user transcripts. Fixtures are synthetic or scrubbed with `scripts/scrub-fixture.ts`. Reports must not embed prompt or file contents unless `--include-content` is passed. By default, paths are shown relative to the project.
5. **ToS.** No features for multi-account rotation, limit evasion, reusing subscription OAuth in other harnesses, or cache keep-alive pings. If in doubt, leave it out and ask Alex.
6. **CI green.** `pnpm lint && pnpm typecheck && pnpm test` must pass before you open a PR. Don't skip or delete failing tests to get green; fix them or mark them `it.todo` with an issue link.

## Workflow
- Branch per milestone or feature (`m1-parser`, `m2-analyzers`, ...). Use git worktrees for parallel work.
- **Open PRs as drafts.** Title format: `[M2] cache-bust analyzer`. Include what changed, how it was tested, and any UNVERIFIED assumptions.
- **Never merge, never `npm publish`, never push tags or releases, and never post launch content without Alex's explicit approval.** No force-pushes to `main`.
- Conventional commits. Keep PRs small enough to review (< ~600 changed lines excluding fixtures and snapshots).

## Stack
TypeScript (strict), Node >= 20, ESM, pnpm, vitest, tsup, eslint + prettier. Keep runtime dependencies minimal and audited.
