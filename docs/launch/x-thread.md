DRAFT — not posted; needs Alex's approval

# X thread

1/
Hitting Claude Code usage limits and can't tell why?

I built tknxray: it reads the transcripts Claude Code already keeps on your machine and explains where the tokens went. Local only, no telemetry, MIT.

github.com/alexnieves-cs/ccxray

[attach docs/demo.gif]

2/
It finds:
• cache rebuilds and their likely cause (idle gap past the TTL, upgrade, /model switch, compaction, CLAUDE.md edit)
• fixed overhead per fresh context, per CC version
• huge tool outputs and unchanged re-reads
• MCP tools you never call
• subagent and error-turn spend

3/
Every number is labeled [M] (measured from the logs' usage fields) or [E] (estimated, chars/4). Every finding points at the session and turn, so you can check it yourself.

No savings claims: it tells you where tokens went, not what you'd save.

4/
Privacy: no network calls (CI scans the build), no account. Reports leave out prompts and file contents unless you pass --include-content. The HTML report is one self-contained file.

[attach docs/report.png]

5/
Status: preview. Tested on synthetic fixtures; real-log validation is in progress. Not on npm yet, so it runs from source.

Feedback welcome, especially `doctor` output from CC versions I haven't seen. Not affiliated with Anthropic.
