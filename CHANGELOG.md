# Changelog

## 0.2.0 (2026-11-25)

The first release meant for npm (`npx tknxray`). It was checked on six other people's public
Claude Code logs as well as the maintainer's (see [bench/REVIEW.md](bench/REVIEW.md#outside-logs)).

**New**
- `tknxray share` writes `tknxray-share.json`, a report you can send to help check the findings
  without sending transcripts: numbers, analyzer ids, built-in tool names, `claude-*` model ids
  and Claude Code versions only, with salted session hashes and a review slot per finding.
  The finding titles are printed on your terminal, never written to the file.
  [`schema/share.v1.json`](schema/share.v1.json) is closed. See [docs/share.md](docs/share.md).
- Prices as of 2026-11-25, adding Fable 5.2 and Mythos 5.2 (the Mythos 5.2 API id is UNVERIFIED).

**Changed**
- **Token estimates for tool output are now `ceil(chars / 2.2)`** instead of chars/4, which ran
  43% to 54% low on all seven corpora checked. On the six outside logs the calibration medians are now 0.84 to 1.03.
  Other text (tool definitions, CLAUDE.md) still uses chars/4, uncalibrated. Because tool
  outputs now estimate about 1.8× larger, big-tool-output (A5) findings start at about 11,000
  chars and appear more often (12 to 39 on the outside logs), and their $ estimates rise.
- The cc-slim hook follows Claude Code's now-documented PostToolUse contract: it leaves a failed
  call's error text and image output alone and keeps every field of the response. Whether a live
  Claude Code applies the replacement is still UNVERIFIED (docs/cc-slim.md §6 has a recipe).

**Fixed**
- Advisor-tool calls (`usage.iterations[]`, `advisor_message`) now count in token totals and $,
  under the advisor's model. One outside log was 57% low on input tokens without them; all six
  now match ccusage exactly.
- One file read from two directories of the same checkout (for example `repo/` and
  `repo/paper/`) is now one cross-agent-read finding instead of two.

**Known limits**: subagents started by the `Workflow` tool cannot be linked to the call that
started them (they still count under their parent session). No savings benchmark yet, so the
README makes no savings claim.

## 0.1.0 (2026-11-12)

First public release, tagged as [v0.1.0](https://github.com/alexnieves-cs/ccxray/releases/tag/v0.1.0) on GitHub. Not yet published to npm; see [docs/RELEASE.md](docs/RELEASE.md). tknxray reads the transcripts Claude Code writes under `~/.claude/projects`
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
