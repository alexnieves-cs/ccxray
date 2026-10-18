DRAFT — not posted; needs Alex's approval

# Show HN

## Title

Show HN: ccxray – see why Claude Code burns tokens, from your local transcripts

## URL

https://github.com/alexnieves-cs/ccxray

## Body

Hi HN, I'm Alex. I kept hitting Claude Code usage limits without knowing why, and the tools I found told me how many tokens I used, not where they went. Some of the most useful issue reports on the Claude Code tracker came from people reading `cache_creation_input_tokens` in their JSONL logs by hand. ccxray automates that.

It reads the transcripts Claude Code already writes under `~/.claude/projects` and reports:

- cache rebuilds, with the likely cause of each (idle gap past the cache TTL, Claude Code upgrade, model switch, compaction, CLAUDE.md edit);
- the fixed overhead of a fresh context per Claude Code version, and jumps between versions;
- huge tool outputs (grouped by short command, e.g. `pnpm test`) and files read again unchanged;
- MCP tools you never call, subagent spend, and wasted error turns.

Every number is labeled [M] (summed from the `usage` fields in the logs) or [E] (a chars/4 estimate or an attribution guess), and every finding points at the session and turn so you can check it by hand. There are terminal, JSON and single-file HTML reports, and a per-turn `session` view.

Privacy: it is local only. No network calls (CI scans the build for them), no telemetry, no account. Reports leave out prompt and file contents unless you pass `--include-content`.

Caveats, honestly:

- The transcript format is undocumented. The parser is defensive and `ccxray doctor` shows what it could not parse, but the analyzers have only been tested on synthetic fixtures so far. Real-log validation is in progress.
- I make no savings claims. Findings say where tokens went, not what you would save.
- It is not on npm yet (the name is taken); you run it from source with pnpm.
- There is a prototype hook to shorten huge Bash outputs, but I haven't verified that Claude Code lets a hook replace built-in Bash output, so it may do nothing.

Not affiliated with Anthropic. MIT licensed. I'd love feedback, especially `doctor` output from Claude Code versions I haven't seen.
