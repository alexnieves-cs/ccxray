# My sessions (aggregate)

**PENDING: run `pnpm my-sessions` locally.**

This file is a template. `pnpm my-sessions` (script: [`my-sessions.ts`](my-sessions.ts)) reads your own
Claude Code logs on your machine (default roots: `CLAUDE_CONFIG_DIR`, `~/.config/claude`, `~/.claude`)
and overwrites this file with aggregate counts only:

- sessions, subagent transcripts, assistant turns, Claude Code version count;
- token totals by type (input, cache write, cache read, output) and the cache hit ratio, all [M];
- findings per analyzer, with token sums labeled [M] (measured) or [E] (estimated).

It never writes paths, project names, prompts, commands, file names or ids
(`test/my-sessions.test.ts` checks this against the synthetic fixtures). Review the result before
committing it. Finding token sums overlap between analyzers and are not savings.
