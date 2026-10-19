# Thresholds

Every analyzer threshold, with its default (`DEFAULT_THRESHOLDS` in `src/model/thresholds.ts`).
Override any of them with `--threshold.<key>=<value>` (numbers only; unknown keys are an error),
on the default command and on `tknxray session`. `test/thresholds.test.ts` checks that every key
is listed here and used by the code.

| Key | Default | Used by | Meaning |
|---|---|---|---|
| `rebuildMinCacheWrite` | 10000 | A2 cache-rebuild, `session` 🔁 flag | Minimum `cache_creation` tokens [M] for a turn to count as a cache rebuild. |
| `rebuildPrevContextFraction` | 0.5 | A2 cache-rebuild, `session` 🔁 flag | The rebuild's `cache_creation` must also be ≥ this fraction of the previous turn's context (input + cache read + cache write). |
| `rebuildReadDropFraction` | 0.5 | A2 cache-rebuild, `session` 🔁 flag | `cache_read` must drop by at least this fraction vs the previous turn. |
| `ttl5mMs` | 300000 (5 min) | A3 rebuild-cause, `session` `*` gap mark | Idle gap that expires a 5-minute cache entry. |
| `ttl1hMs` | 3600000 (1 h) | A3 rebuild-cause, `session` `*` gap mark | Idle gap that expires a 1-hour cache entry; applies when the session wrote any `ephemeral_1h` tokens. |
| `baselineJumpTokens` | 2000 | A4 fixed-overhead | Increase of the median first-turn context [M] between two consecutive Claude Code versions worth flagging. |
| `baselineMinSessions` | 3 | A4 fixed-overhead | Fresh sessions a Claude Code version needs before its median baseline is compared for a jump; versions with fewer are reported but not compared. |
| `bigToolOutputTokens` | 5000 | A5 big-tool-output, `session` 📦 flag | Estimated tokens [E, chars/4] of the inline content for one `tool_result` to count as big (an output Claude Code already persisted counts by its inline preview). |
| `contextLargeTokens` | 150000 | A8 context-growth | Peak context per turn [M] that flags a session. Flagged subagents of one session are reported together in one finding. |
| `compactionsPerSession` | 2 | A8 context-growth | Compactions in one session that flag it (markers with no assistant turn between them count once). |
| `crossAgentReadMinAgents` | 3 | A11 cross-agent-read | Agents of one session tree (the main session, its subagents and inline sidechain agents) that must each Read the same file (canonical path) to flag it. |

## Fixed constants (not configurable)

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `RETRY_WINDOW_MS` | 60000 | A10 error-waste | A turn on the same model at most this long after an API error counts as its retry. |
| `RECALL_LOOKAHEAD_TURNS` | 3 | A10 error-waste | Turns searched after a failed tool call for an identical re-call. |
| `CURVE_POINTS` | 50 | A8 context-growth | Maximum points in `data.curve` (bucket maxima). |
| prefix length | 4 | `session` | Shortest session-id prefix accepted. |
| `TRIMMED_OUTPUT_TOKENS` | 1000 | A5 big-tool-output impact | Estimated tokens a trimmed output keeps (about 100 lines); A5 savings are the carry cost of the rest. |
