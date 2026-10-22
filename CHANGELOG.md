# Changelog

## 0.1.0 (unreleased)

First public release. tknxray reads the transcripts Claude Code writes under `~/.claude/projects`
and explains where the tokens went. It runs locally and makes no network calls.

**Reports**
- Token totals [M] by model, project, day, session and role (main vs subagent), with cost at API
  list prices [E] that matches `ccusage` to the cent on a 3.15 GB real corpus.
- Terminal, JSON (`schema/report.v1.json`) and a self-contained HTML report with an overview band,
  an interactive per-day chart and session replay.
- `session <id>` per-turn view, `watch` live view, `compare` before/after a change, `doctor`.
- An action plan of at most 5 changes, each with its estimated saving [E] and documented setting.

**Findings** (10 analyzers): cache rebuilds and their cause, cache TTL choice, fixed overhead per
version, context growth, big tool outputs, repeated reads, files read by many agents, subagent
cost, unused tools and MCP servers, API errors and repeated failed calls.

**Tools**: `fix mcp` (preview of a `permissions.deny` diff, dry run by default), the cc-slim
PostToolUse hook prototype, and opt-in `capture` (API key only, listens on 127.0.0.1).

**Validation** (see [bench/REVIEW.md](bench/REVIEW.md)): ccusage token totals +0.00% and cost
identical on 45,412 real turns; 20 of 20 findings pass a mechanical evidence check; an advice
review of 20 findings on a second real corpus found 3 wrong, all fixed before release:
- a failed call retried with a corrected argument of the same length is no longer counted as waste;
- a call repeated after a new prompt (for example a permission granted) is no longer counted;
- breaks over 1h no longer get "batch prompts" advice, which cannot bridge them;
- "N of M tools never called" counts tools that were loaded later.

Also fixed before release: a resumed transcript that starts with the earlier session's records is
now its own session (keyed by its file name, as ccusage does).

**Known limits**: the transcript format is undocumented, so some parsing rules are marked
UNVERIFIED in the code and in docs/SPEC.md §4.4. [E] token estimates run about 45% low on real
logs. Savings are per-window estimates from your own logs, not a product claim.
