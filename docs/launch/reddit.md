DRAFT — not posted; needs Alex's approval

# r/ClaudeAI

## Title

I built a local tool that reads your Claude Code transcripts and explains where the tokens went (cache rebuilds, big tool outputs, unused MCP tools)

## Flair

Built with Claude / Open source (whichever the sub uses)

## Body

If you've hit usage limits and couldn't tell why, this might help. **tknxray** reads the JSONL transcripts Claude Code already keeps in `~/.claude/projects` and tells you *why* tokens were used, not just how many:

- **Cache rebuilds** and their likely cause: an idle gap longer than the cache TTL, a Claude Code upgrade, a `/model` switch, compaction, or a CLAUDE.md edit mid-session.
- **Fixed overhead** of each fresh context, per Claude Code version.
- **Huge tool outputs** (e.g. a test run dumping its whole log) and **files re-read** without changes.
- **MCP tools you never call**, with a preview command that writes a `permissions.deny` diff (dry run by default).
- **Subagent cost** and **error turns**.

Things I care about:

- **Local only.** No network calls, no telemetry, no login. CI checks the build for network code.
- **Honest numbers.** Everything is labeled [M] measured (straight from the logs' `usage` fields) or [E] estimated (chars/4 heuristic). Findings link to the exact session and turn.
- **Privacy.** Reports don't include your prompts or file contents unless you ask with `--include-content`. The HTML report is one self-contained file you can attach to a bug report.

Status: preview. Tested on synthetic fixtures; validation on real logs is still in progress, and I'm not claiming any savings. Not on npm yet, so it runs from source:

```
git clone https://github.com/alexnieves-cs/ccxray && cd ccxray
pnpm install && pnpm build && node dist/cli.js
```

Repo: https://github.com/alexnieves-cs/ccxray (MIT). Not affiliated with Anthropic.

If you try it, `node dist/cli.js doctor` output (counts only, no content) would really help me support more Claude Code versions.
