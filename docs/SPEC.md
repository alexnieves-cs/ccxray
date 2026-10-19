# tknxray: specification

The tool was called ccxray until 2026-10-19; it was renamed because `ccxray` is taken on npm (§10). The repo is still `alexnieves-cs/ccxray`.

Version 0.1 (draft), 2026-10-18. Owner: Alex Nieves (@alexnieves-cs). Status: **in development, no code yet.**

Labels used throughout: **[M]** = measured or verified against a real source · **[E]** = estimate · **[UNVERIFIED]** = an assumption that must be confirmed against real logs before it is relied on.

---

## 1. Problem

Claude Code users, Max subscribers especially, regularly hit usage limits and can't tell why. Existing tools (e.g. [ccusage](https://github.com/ccusage/ccusage), ~19k★) report **totals** by day, session or model. They don't explain **which parts of the context** consumed the tokens, or **what to change**.

### Evidence (GitHub API counts, 2026-10-18)
| Signal | Count | Link |
|---|---|---|
| "Instantly hitting usage limits with Max" | 695 👍 / 1,499 comments | [anthropics/claude-code#16157](https://github.com/anthropics/claude-code/issues/16157) |
| "Max session limits exhausted abnormally fast" | 476 👍 / 879 comments | [#38335](https://github.com/anthropics/claude-code/issues/38335) |
| "Cache TTL silently regressed 1h→5m" (found by users reading their own logs) | 244 👍 | [#46829](https://github.com/anthropics/claude-code/issues/46829) |
| "v2.1.100+ inflates cache_creation by ~20K tokens" (found the same way) | 215 👍 | [#46917](https://github.com/anthropics/claude-code/issues/46917) |
| "Lazy-load MCP servers/tools" | 96 👍 | [#7336](https://github.com/anthropics/claude-code/issues/7336) |
| "Disable specific MCP functions to save tokens" | 50 👍 | [#6759](https://github.com/anthropics/claude-code/issues/6759) |
| "Expose token usage/cost in hook inputs" | 33 👍 | [#11008](https://github.com/anthropics/claude-code/issues/11008) |
| "cache_read never hits in --print --resume" | 41 👍 | [#34629](https://github.com/anthropics/claude-code/issues/34629) |
| statusline shows cumulative tokens | 42 👍 | [#13783](https://github.com/anthropics/claude-code/issues/13783) |

**[M] Fixed overhead measurement** (Claude Code 2.1.296, the first request of `claude -p "say hi"` captured with a local `ANTHROPIC_BASE_URL` server that forwarded nothing): 81,057-byte request body. Of that, **23 tool definitions = 66,689 chars (~82%)**, system prompt 6,109 chars, messages 9,491 chars. That works out to roughly 20k tokens of fixed overhead per fresh context **[E: chars/4, not tokenized]**, before CLAUDE.md or any MCP server is added.

The cache issues above were diagnosed by hand, by users reading `cache_creation_input_tokens` in JSONL. tknxray automates that forensic work.

## 2. Users
1. **Max/Pro subscriber hitting limits.** Wants "why did I burn 40% in a day?" answered in one command, plus fixes.
2. **API-key user / team lead.** Wants cost attribution and regression detection across Claude Code versions.
3. **Power user with many MCP servers.** Wants to know which tools they never use and how much those tools cost on every cold turn.
4. **Issue reporters.** Want a shareable, privacy-safe JSON/HTML report to attach to bug reports like #46917.

Non-goals: live proxying of subscription traffic, multi-account management, prompt rewriting, and anything that changes Claude Code's requests.

## 3. CLI UX

```
npx tknxray                       # analyze all sessions in the last 7 days (default)
npx tknxray --since 2026-10-01    # date range
npx tknxray --project myrepo      # filter by project dir (substring)
npx tknxray session <id|latest>   # per-turn drill-down for one session
npx tknxray --html report.html    # self-contained HTML report (no external assets)
npx tknxray --json > report.json  # machine-readable output (schema-versioned)
npx tknxray --include-content     # allow snippets of prompts/outputs in reports (off by default)
npx tknxray doctor                # show discovered log dirs, CC versions, parse stats, unknown record types
npx tknxray watch [latest|<id>]   # live full-screen view of one session (polls its files; --once prints one frame)
npx tknxray compare --at 2026-10-12            # the 7 days before vs the 7 days from that day
npx tknxray compare --before A..B --after C..D # explicit windows (inclusive UTC days)
```

### 3.1 compare

`compare` answers "did my change help?" It builds a full report for each window, with the same
analyzers and thresholds, and prints one row per metric: before, after, the change, and
better / worse / same for metrics with a direction (moves under 5% relative count as the same).

| Metric | Label | Better |
|---|---|---|
| main sessions, assistant turns | [M] | none (workload size) |
| $ per turn, $ per main session | [E] list prices | lower |
| cache hit ratio | [M] | higher |
| cache writes per turn | [M] | lower |
| output per turn | [M] | none |
| median peak context per main session (input + cache read + cache write of its largest turn) | [M] | lower |
| compactions per main session | [M] | lower |
| cache rebuilds per 100 turns (A3 count) | [M] | lower |
| subagent share of $ | [E] | none |
| fixable waste: the action plan's combined share (§5.3) | [E] | lower |

Below the metrics, "waste by kind" sums each analyzer's priced savings (§5.2) as a % of that
window's $ (`≤` marks upper bounds). Rates are normalized because workloads differ; the verdict
says what moved, never why. A window with fewer than 3 main sessions or 100 turns is flagged as
thin. Exit 1 when either window has no sessions. `--json` prints the comparison object
(`src/compare.ts` `Comparison`); it is not part of report.v1.

Config dir discovery: `CLAUDE_CONFIG_DIR` (comma-separated allowed), `~/.config/claude/projects`, `~/.claude/projects` (same rules as ccusage **[M: ccusage docs]**).

### Example output (illustrative only; these numbers are made up)
```
tknxray · 42 sessions · 1,318 assistant turns · Oct 11–18 2026 · Claude Code 2.1.290–2.1.296

TOKENS (measured from usage fields)
  input (uncached)        1.2M    3%
  cache write (creation)  9.8M   24%
  cache read             28.4M   70%
  output                  1.1M    3%
  cache hit ratio  72%  (read / (read + write + input))

COST [E] what these tokens would cost at API list prices (prices of 2026-10-19)
  total                  $61.40  100%   main $41.10 · subagents $20.30
  ...

WHAT TO CHANGE FIRST (savings at API list prices [E])
 1. Batch prompts so gaps stay under 5 minutes                                  ~$9.80  16% of cost
      29 breaks longer than the 5-minute cache TTL made Claude Code write 2.2M tokens of cache again
      change:
        Send related prompts in one sitting so idle gaps stay under the cache TTL; ...
      tokens measured, $ estimated · from finding 1
 2. Trim big tool outputs (`pnpm test`)                                         ~$3.10   5% of cost
      ...
  These 2 changes would have cut about 20% of this window's cost [E] (~$12.30 of $61.40; ...)

WHERE IT WENT (estimated attribution)
  fixed overhead (system + tools)   ~21k / cold turn   × 96 cold turns
  tool outputs                      ~31%  of non-cached input  · Bash 61%, Read 27%, Grep 9%
  repeated reads                    14 files re-read unchanged · ~182k tokens

TOP FINDINGS
 1. CACHE REBUILDS  38 rebuilds cost 4.1M cache-write tokens
      29 × idle gap > 5 min (TTL expiry)      → batch work, or check whether a 1h TTL applies to your plan
       6 × CLAUDE.md edited mid-session        → edit CLAUDE.md between sessions
       3 × Claude Code version changed          → known: #46917 (2.1.100+)
 2. HUGE TOOL OUTPUTS  `pnpm test` returned 48k chars (×11)
      → pipe through `| tail -50` or enable cc-slim (planned)
 3. REPEATED READS  src/api/client.ts read 7× unchanged in session 3fa2…
      → planned cc-slim read-dedupe hook
 4. UNUSED TOOLS  9 MCP tools from "github" server never called in 42 sessions (~6.3k tokens/cold turn [E])
      → run `tknxray fix mcp` to preview a permissions.deny diff

Run `tknxray session 3fa2` for per-turn detail · `--html` for a shareable report
```

Default command flags (M2): `--since DATE` (default: 7 days before now), `--until DATE` (a date-only value is inclusive: the end of that UTC day), `--project NAME`, `--json` (stdout), `--html FILE` (writes the file, **overwriting** it, and prints its path; with `--json` the JSON is printed first and the path goes to stderr), `--include-content`, `--root DIR` (repeatable), `--threshold.KEY=VALUE` (repeatable; unknown or non-own keys, empty or non-numeric values, `…Fraction` values outside [0, 1] and negative values are errors), `--no-color`. Dates are `YYYY-MM-DD` (a real calendar day; `2026-02-30` is rejected) or ISO 8601 `YYYY-MM-DDTHH:MM[:SS[.sss]]` with an optional `Z`/`±HH:MM` offset; **a date-time without an offset is UTC**, never local time. Anything else is an error. A subcommand (`doctor`, `session`) is recognized only as the first argument, so in `--project doctor` the word is the flag's value. Exit codes: 0 success, 1 no sessions in the window (the empty state is still printed), 2 bad arguments or an `--html` file that cannot be written (with its own message).

`session` view: one row per assistant turn with timestamp, gap since the previous turn, model, input, cache write, cache read, output, the tool calls made in that turn, and a flag column (🔁 rebuild, 📄 dup read, 📦 big output; `R`/`D`/`B` with NO_COLOR or a non-UTF-8 locale). A `*` after the gap marks a gap longer than the cache TTL. Subagents are summarized after the table. `--json` prints the rows; thresholds: [docs/THRESHOLDS.md](THRESHOLDS.md).

`watch` view (M6): `tknxray watch [latest|<id|prefix>] [--project NAME] [--root DIR]... [--interval SECONDS] [--once] [--no-color]`. `latest` (the default) is the most recently modified main transcript (by layout) whose session has at least one assistant turn and matches `--project`; an id or prefix follows the `session` rules. It then polls that transcript and every `*.jsonl` under its `{sessionId}/` dir (subagents) with `fs.stat` size + mtime every `--interval` seconds (default 2, minimum 0.1; no `fs.watch`), re-parses only those files on a change (`loadSessionFiles`, so cross-session dedupe sees only them) and redraws a full-screen frame (alternate screen, hidden cursor, both restored on `q`, Ctrl-C, SIGINT and SIGTERM; redrawn on resize). With `--once`, or when stdout is not a terminal, it prints one frame and exits 0; COLUMNS is honored when stdout has no width. The frame (60–120 columns, `src/reporters/watch.ts`, pure): header (project, short id, model, Claude Code version, turns, start, poll time); a context gauge of the latest turn (cache read / cache write / uncached input, [M]) against an **assumed** window (1,000,000 if any main-chain turn's context exceeded 200,000, else 200,000) and the session peak; a per-turn context chart (block characters, one column per turn, max per bucket when there are more turns than columns) with A2 rebuild (↻) and compaction (◆) rows; the latest turn's usage and hit ratio [M], tool names with result sizes [E], and whether it was an A2 rebuild with its A3 cause [E]; main-chain totals, the sum rewritten by rebuilds [M], rebuild and compaction counts, subagents with their token totals [M]; and an idle line: time since the last turn and the session's cache TTL [E]. Past the TTL it says "cache has likely expired; the next turn will rebuild it [E]". Per §9 it never suggests sending anything to keep the cache alive and shows no countdown. Exit codes: 0 after a frame or on quit, 1 when no session matches, 2 for bad arguments.

## 4. Architecture

TypeScript (strict), Node ≥ 20, ESM, single package, bin `tknxray`. Runtime dependencies kept minimal (a small arg parser, a color library; no HTTP client).

```
src/
  cli.ts                 arg parsing, command routing
  discover.ts            find log dirs & files, CLAUDE_CONFIG_DIR handling
  parser/
    stream.ts            line-streaming JSONL reader (readline), malformed-line counter
    records.ts           zod-free hand-written type guards for known record types
    dedupe.ts            message.id / requestId / sidechain dedupe (see 4.3)
    session.ts           build Sessions; turns in timestamp order (parentUuid only for linking where needed)
  tokens/
    estimate.ts          heuristic tokenizer (chars/4 baseline; optional pluggable tokenizer later)
  analyzers/             pure functions: (Session[], ctx) => Finding[]
  reporters/
    terminal.ts  html.ts  json.ts
  model/                 Finding, Turn, Session, Report types; JSON schema version
```

Data flow: discover → stream parse → dedupe → build sessions/turns → analyzers (run independently) → aggregate → reporter.

### 4.1 Core types (sketch)
```ts
type Turn = {
  sessionId: string; uuid: string; ts: number /* epoch ms UTC */; gapMs: number | null;
  model: string; ccVersion?: string; isSidechain: boolean;
  usage: { input: number; cacheWrite: number; cacheWrite5m?: number; cacheWrite1h?: number; cacheRead: number; output: number }; // measured
  toolUses: { id: string; name: string; input: unknown }[];
  toolResults: { toolUseId: string; chars: number; estTokens: number; isError?: boolean }[]; // estimated
};
type Finding = {
  analyzer: string; severity: 'info'|'warn'|'high';
  title: string; tokens: { value: number; kind: 'measured'|'estimated' };
  evidence: { sessionId: string; turnUuid: string; detail: string }[];
  fix: { summary: string; diff?: string; docsUrl?: string };
};
```

Every timestamp in the model (`Turn.ts`, `ToolResult.ts`, `UserPrompt.ts`, `SessionEvent.ts`, `Session.firstTs`/`lastTs`) is epoch milliseconds (UTC) as a `number`, not a `Date`: a Date object costs ~112 B of retained heap each (§8). Reports keep emitting ISO-8601 strings (`new Date(ms).toISOString()`).

**Finding.data conventions (provisional, reporters ↔ analyzers).** `Finding.data` is analyzer-specific, but reporters read three keys when present and well-formed: `causes: { cause, count, tokens?, tokensKind?, fix? }[]` (per-cause breakdown, e.g. A2/A3; `tokens` has `tokensKind` when given, else the finding's kind; A3 sets `estimated` because assigning a cause is a guess), `tool: string` (tool name; groups "where it went" by tool) and `command: string` (raw Bash command; reporters only show its first two words, never env assignments). Without `--include-content`, the JSON report keeps only those keys plus number/boolean scalars and strings of at most 80 chars. This contract may change until M4; the source of truth is the comment at the top of `src/reporters/derive.ts`. A7's per-MCP-server data is a fixed contract consumed by M5 `tknxray fix mcp`: `{ server, unusedTools, usedTools, defChars? }` with full `mcp__server__tool` names (see `src/analyzers/tool-usage.ts`).

### 4.2 Transcript format: what is known
Sources: the local logs on the dev box (Claude Code **2.1.296**) **[M]**; ccusage's Claude adapter docs ([rust/adapters/claude/src/README.md](https://github.com/ccusage/ccusage/blob/main/rust/adapters/claude/src/README.md)) **[M: documented by a widely used parser]**; the Anthropic Messages API `usage` object ([docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)).

- **Location:** `projects/{project}/{sessionId}.jsonl` and nested `projects/{project}/{sessionId}/**.jsonl` (e.g. `subagents/`). The project dir name is the cwd with `/` replaced by `-` **[M: `-workspace-research-claude-code-mod`]**.
- **One JSON object per line.** Top-level `type` values seen locally **[M]**: `user`, `assistant`, `attachment`, `queue-operation`, `last-prompt`, `cost-state`, `atis-latch`. Treat any other value as unknown and count it in `doctor`.
- **Common envelope fields [M]:** `uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO-8601 UTC), `type`, `isSidechain`, `cwd`, `gitBranch`, `version` (Claude Code version), `userType`, `entrypoint`.
- **`assistant.message` [M]:** `id`, `model`, `role`, `type: "message"`, `content`, `stop_reason`, `usage`, plus `container`, `context_management`, `diagnostics`, `stop_details`. Synthetic/error turns have `model: "<synthetic>"` and `isApiErrorMessage` / `error` on the envelope. **Exclude these from token stats.**
- **`message.usage` [M, all fields observed]:** `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`, `server_tool_use: { web_search_requests, web_fetch_requests }`, `service_tier`, `inference_geo`, `iterations`, `speed`, `output_tokens_details`, `fallback_credit`. The `iterations` array can contain `advisor_message` records with their own model **[M: ccusage docs]**.
- **`user.message.content`**: either a string (a typed prompt) **[M]** or an array of blocks including `tool_result` blocks keyed by `tool_use_id` **[UNVERIFIED locally; standard Messages API shape]**.
- **`assistant.message.content`**: array of `text` / `thinking` / `tool_use` blocks (`tool_use` has `id`, `name`, `input`) **[UNVERIFIED locally; standard Messages API shape]**.
- **`cost-state` [M]:** `totalCostUSD`, `totalAPIDuration`, `totalDuration`, `totalLinesAdded/Removed`, `modelUsage`, `startTime` (epoch ms). Useful as a cross-check.
- `requestId` on the envelope **[UNVERIFIED locally; documented by ccusage]**.

### 4.3 Dedupe rules (adopted from ccusage's documented behavior)
- Claude Code writes **one line per content block** for one API response, so lines with the same `msg_…` `message.id` share one `usage`. **Count usage once per (message.id, requestId).**
- Sidechain files (`isSidechain: true`) can replay parent messages with the same message id, so drop the replayed copy.
- One response can be copied into several session files (`requestId` duplicates across sessions), so dedupe globally.
- Skip malformed lines and count them.

### 4.4 Open questions [UNVERIFIED]. Each must be resolved in M1 against real logs

> **Status (2026-10-18):** answered as far as current evidence allows in [docs/FORMAT.md](FORMAT.md#spec-44-answers). Q1–Q4 have [M] answers from one CC 2.1.302 session (notably, Q3: tool definitions *are* logged in `attachment.type = prompt_snapshot` on that version; Q1: large outputs are externalized as a `<persisted-output>` preview plus `{sessionId}/tool-results/<id>.txt`, threshold and KB unit UNVERIFIED; Q4: subagents are `{sessionId}/subagents/agent-<id>.jsonl`, linked by `agent-<id>.meta.json` `toolUseId` and the parent's `toolUseResult.agentId`). Q5 has an [M] answer since 2026-10-19 from a CC 2.1.302–2.1.303 snapshot with 3 compactions: each writes a `system`/`compact_boundary` record (with `compactMetadata`) and, 4–5 lines later, an `isCompactSummary: true` user line stamped up to ~0.3 s *before* the boundary, with no assistant turn between them; the first turn after shows a cache_read drop that the A2 rule does not count as a rebuild.
1. Is `tool_result` content always inline in the JSONL, or truncated or externalized for big outputs? This affects tool-output sizing.
2. Do `attachment` records carry CLAUDE.md / memory / hook output, and can they be used to detect CLAUDE.md edits? (Fallback: compare file mtime against the session timeline.)
3. Are tool definitions logged anywhere? (Assumption: **no**. Fixed overhead is inferred from first-turn `cache_creation + input`, and optionally measured exactly via the M5 capture mode with an API key only.)
4. How subagent (Task/Agent) transcripts link to the parent tool_use.
5. Is compaction marked by a distinct record (e.g. a summary type or `isCompactSummary`)?
6. How field names drift across CC versions (keep a version → quirks table in `parser/quirks.ts`).
7. Which cwd characters Claude Code replaces with `-` in project dir names. Reporters collapse the encoded home prefix to `~` and try both `/ \ :` only and every non-alphanumeric character.

**Parser assumptions added in M1 [UNVERIFIED]** (details in [FORMAT.md](FORMAT.md#parser-implementation-notes-m1)):
- Lines without `requestId` are deduped by `message.id` within one file only.
- Older versions may write partial `output_tokens` on earlier block lines; the largest is kept.
- String `assistant.message.content` is one text block.
- Compaction markers: `summary` records (Q5). *(`isCompactSummary` and `system`/`compact_boundary` are [M] since 2026-10-19, FORMAT.md Q5.)* `system`/`api_error` is an API error.
- `isMeta: true` user lines are client-injected, not typed prompts.
- One file = one session (its first `sessionId`). Besides the [M] `{sessionId}/subagents/agent-<id>.jsonl` layout, `{sessionId}/agent-<id>.jsonl` (UUID-shaped `{sessionId}` dir) and files whose every user/assistant record is `isSidechain` with an `agentId` (e.g. flat `agent-<id>.jsonl`) are treated as subagents (Q4); any other file, at any depth, is a main session whose project is its immediate parent dir. `Session.id = <parent>:agent-<id>` is a tknxray choice.
- `<persisted-output>` sizes: `KB` = 1024, and the externalization threshold is unknown (Q1).
- Cross-session copies keep the copy whose file sessionId matches the record's envelope `sessionId`, else the earliest file; the sidechain-replay and cross-session rules themselves are from ccusage docs and not yet seen locally.
- `prompt_snapshot` tool names come from `name` or `schema.name`; `systemPrompt[]` parts are strings or `{text}`.

**Analyzer assumptions added in M2 [UNVERIFIED]** (marked `// UNVERIFIED:` in `src/analyzers/` and `src/tokens/calibrate.ts`):
- A3 TTL: a session that wrote any `ephemeral_1h` tokens (decided over the whole session, before since/until filtering: `Session.wrote1hCache`) keeps its cached prefix for 1 h.
- A3 config-edit: a mid-session CLAUDE.md edit produces a new `instructions` attachment (Q2); a file counts as edited when its sha256 differs from the latest earlier attachment of the same path (files that only appear do not count).
- A3 tool-set-change: a new `prompt_snapshot` is logged when the tool set changes (Q3).
- Calibration: request *n* carries all of turn *n-1*'s output tokens and nothing unlogged besides the tool_result.
- `scripts/validate-real.ts`: the older `ccusage session --json` shape `{ sessions: [{ sessionId, … }] }`. *(Resolved 2026-10-19 against real ccusage output [M]: the current shape is `{ session: [{ period: <sessionId>, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, … }], totals }`, and ccusage folds subagent transcripts into their parent session; both shapes are accepted.)*

**Analyzer assumptions added in M4 [UNVERIFIED]** (marked `// UNVERIFIED:` in `src/analyzers/`):
- A7: a `prompt_snapshot`'s `tools[]` lists every tool sent on a cold turn (deferred tools may be missing), so a tool counts as defined only when some snapshot lists it (Q3).
- A7: in `mcp__<server>__<tool>`, the server name ends at the first `__` after `mcp__`.
- A8: compaction markers with no assistant turn between them belong to one compaction (Q5). *([M] for the observed `compact_boundary` + `isCompactSummary` pair, 3 of 3 in CC 2.1.302–2.1.303; still UNVERIFIED for `summary` records and for other versions.)*
- A4: a resumed or continued session's first envelope record has a non-null `parentUuid` (`Session.continued`); such sessions, and sessions whose first kept turn is not the chain's first, are not baselines.
- A7: `deferred_tools_record` attachments name tools whose definitions are not sent up front; names are read from `tools` / `toolNames` / `names` / `deferredTools` arrays (strings or `{name}`), and those tools cost 0 tokens per cold turn.
- A10: a `system`/`api_error` record followed by a synthetic turn, with no real turn between them, is one error.

**Fix-module assumptions added in M5 [UNVERIFIED]** (details in [cc-slim.md](cc-slim.md) and [capture.md](capture.md)):
- `tknxray fix mcp`: permission rule syntax `mcp__<server>__<tool>` and server-wide `mcp__<server>` / `mcp__<server>__*` is taken from Claude Code's permission docs, not re-checked against a running version. Whether a deny rule also removes the tool's definition from the request (saving tokens), rather than only blocking calls, is unknown and must be measured.
- *(Resolved at integration, no longer an assumption.)* `tknxray fix mcp` gets its `tool-usage` (A7) findings from the real pipeline, `loadSessions` then `buildReport` (`src/pipeline.ts`), the way the default command does (default thresholds, no content, `--since` default 7 days); the A7 data contract `{ server, unusedTools, usedTools, defChars? }` is in §4.1 and covered by `test/analyzers/tool-usage.test.ts` and an end-to-end `fix mcp` test on the built CLI.
- cc-slim hook: PostToolUse stdin fields (`hook_event_name`, `tool_name`, `tool_input`, `tool_response`), the Bash `tool_response` shape `{ stdout, stderr, interrupted, isImage }`, and whether `hookSpecificOutput.updatedMCPToolOutput` (documented for MCP tools) has any effect on Bash. If it has none, only the PreToolUse command-wrap design in cc-slim.md §3.3 can work.
- capture: Claude Code with `ANTHROPIC_API_KEY` sends `x-api-key`, and an OAuth login sends `Authorization: Bearer` (OAuth tokens start with `sk-ant-oat`, refused in either header). Requests go to `POST /v1/messages` (optionally with a query string). Claude Code may send requests without tools first, so capture skips bodies without a `tools` array and measures the first one that has it.

**Watch assumptions added in M6 [UNVERIFIED]** (marked `// UNVERIFIED:` in `src/reporters/watch.ts`):
- The context window is not logged. `watch` assumes 1,000,000 tokens once any main-chain turn's context (input + cache read + cache write) exceeded 200,000, else 200,000, and labels it "(assumed)".

**Cost assumptions added in M7 [UNVERIFIED]** (marked `// UNVERIFIED:` in `src/cost/` and `src/analyzers/`):
- A turn whose `usage` has no `cache_creation` 5m/1h split has its whole `cache_creation_input_tokens` priced at the 5-minute write rate (`writeSplit` in `src/cost/cost.ts`). When the split is present, the 1h part is priced at the 1h rate and the rest at the 5m rate.
- Carry cost (§5.2): content stays in the cached prefix of every later request of its chain until a compaction, and a turn meeting the A2 usage rule rewrote all of it; the content's position in the prefix is not logged. A turn that wrote no cache tokens is given its session's TTL write rate (`sessionTtl`).
- A4/A7 impact: tool definitions are part of the cached prefix of every main-chain request of the sessions whose `prompt_snapshot` lists them. Subagent requests are left out (whether they carry the same definitions is not logged), which makes the figure conservative.
- A9 subagent type: the `subagent_type` of the parent Agent/Task tool_use (linked by `parentToolUseId`); an explicit `model` in that input overrides settings.
- Action plan (§5.3): the subagent-model settings (`CLAUDE_CODE_SUBAGENT_MODEL`, `.claude/agents/Explore.md`, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`) are taken from the Claude Code docs, not a real run; whether `permissions.deny` removes MCP tool definitions (not only blocks calls) is unknown; the combined savings assume the non-context levers are independent.

### 4.5 Token estimator
- Baseline: `ceil(chars / 4)` for text and `ceil(JSON.stringify(x).length / 4)` for JSON. Always labeled *estimated*.
- Calibration (M2, `src/tokens/calibrate.ts`): for consecutive real turns *p → t* of one chain where *p* made exactly one tool call with one result, nothing else was logged in between (no prompt, no event), the model did not change and the result is ≥ 250 estimated tokens: `measured = ctx(t) − ctx(p) − output(p)` with `ctx = input + cache_write + cache_read`, and `ratio = estTokens / measured` (> 1 means chars/4 is high). The median ratio and sample count go into `Report.calibration` and one line of `doctor`. `cache_read` is included (the earlier draft said `input + cache_write` only) because a request's context is the sum of all three fields, and how it splits between them changes from turn to turn; only the growth of the sum is the added content.
- No network tokenizer calls. An optional offline tokenizer can be plugged in later.

## 5. Analyzers

Each analyzer is a pure function with fixtures and snapshot tests. Thresholds are configurable (`--threshold.key=value`).

| # | Analyzer | Detection rule | Tokens reported | Suggested fix |
|---|---|---|---|---|
| A1 | **totals** | Sum the deduped usage per session/project/model/day; hit ratio = read / (read + write + input) | measured | n/a (context for everything else) |
| A2 | **cache-rebuild** | Turn *n* (n>1 within a session, non-sidechain) has `cache_creation ≥ max(10k, 0.5 × prev context)` **and** `cache_read` dropped by ≥50% vs turn *n-1* | measured (cache_write of the turn) | depends on cause (A3) |
| A3 | **rebuild-cause** | For each A2 hit, assign the first matching cause: (a) `gapMs > 5 min` (or > 60 min if the session wrote `ephemeral_1h` tokens) → **TTL expiry**; (b) `version` changed vs prev turn → **CC upgrade**; (c) `model` changed → **model switch**; (d) compaction record nearby → **compaction**; (e) CLAUDE.md / settings mtime inside the gap **[UNVERIFIED method]** → **config edit**; (f) MCP/tool set changed (inferred from new tool names appearing) **[E]**; else **unknown** | measured total (A2); per-cause split estimated [E] (attribution guess) | TTL: "batch prompts; you had N gaps of 5–15 min". Upgrade: link known issues (#46917). Model switch: "/model mid-session invalidates the cache". Config edit: "edit CLAUDE.md between sessions". |
| A4 | **fixed-overhead** | First assistant turn of each session: `input + cache_write + cache_read` = baseline context. Report the median per CC version and a jump between versions ≥ 2k | measured (inferred meaning [E]) | "Your baseline grew 20k at 2.1.100" → link issue; suggest mcp-diet |
| A5 | **big-tool-output** | `tool_result` est. tokens ≥ 5k (configurable); group by tool name + normalized command (Bash: first 2 tokens, e.g. `pnpm test`) | estimated | Bash, by command family: test runners/builds `| tail -n 100`, `--silent`, `--reporter=dot`; file dumps (cat/sed/head…) Read with offset/limit or `grep -n`; grep/rg `-l`, `-m N`, narrower path; `git show/diff` `--stat` then one path; `git log` `-n N --oneline`; loops/other: limit the output. Grep tool: narrower glob / `head_limit`; later `cc-slim` |
| A6 | **repeated-read** | Same `Read` file_path (with the same offset/limit) ≥ 2× in a session with no intervening Edit/Write/MultiEdit/Bash on that path | estimated (size of later reads) | "Reference the earlier read"; later the cc-slim dedupe hook |
| A7 | **tool-usage** | Count tool_use by name across the window; list tools/MCP servers (`mcp__server__tool`) never called. Definition sizes come from `prompt_snapshot` attachments when logged (CC 2.1.302, FORMAT.md Q3); without one, report counts only | count; tokens [E] only with a snapshot or capture | `permissions.deny` / scope the MCP server to a subagent (mcp-diet, M5) |
| A8 | **context-growth** | Per-session curve of context size (input + cache_read + cache_write); flag sessions over 150k or with ≥ 2 compactions | measured | Main session: "Start a new session / use /clear for unrelated tasks". Subagents (cannot be /clear-ed): "give it a narrower task and return a summary, not whole files" |
| A9 | **subagent-cost** | Sum usage of sidechain/subagent transcripts vs parent | measured | "Route exploratory subagents to a smaller model via the subagent `model:` field" |
| A10 | **error-waste** | API error / synthetic turns, retries, tool_result `is_error` followed by an identical re-call | measured/estimated | context-specific |
| A11 | **cross-agent-read** (M7) | The same file (canonical path, as A6) Read by ≥ `crossAgentReadMinAgents` (3) agents of one session tree: the main session, its subagent transcripts and inline sidechain agents. One copy per agent: its first non-error Read; later re-reads are A6's, and A5 skips every copy | estimated (the copies beyond the largest) | "put the facts agents need from <file> in the subagent prompt or a CLAUDE.md summary instead of having every agent read the file" |

Every finding includes evidence pointers (session, turn uuid) so a user can verify it by hand.

**M2 implementation notes.**
- A1 totals count every deduped, non-synthetic turn of every session, **subagent sessions included** (they are real API spend). They go into `Report.totals`, not findings.
- A2 checks only main-chain (non-sidechain) turns, so subagent transcripts are never checked. *n-1* is the previous non-synthetic turn. The literal rule needs `cache_read(n-1) > 0`, so a rebuild right after a cold first turn is not detected; with `--since`, the first in-window turn has no in-window *n-1*. A2 and A3 emit **one** aggregated finding (`data.causes`, evidence capped at 50 rebuilds with the largest cache writes; counts stay exact). Severity: high at ≥ 10 rebuilds or ≥ 500k tokens, else warn.
- A3 per-cause tokens are labeled [E] in every reporter (`tokensKind: 'estimated'`); the finding total stays measured. The ttl-expiry fix is worded per TTL (5–15 min gaps for 5m sessions, breaks over 1 h for 1h sessions). A gap exactly equal to the TTL is not an expiry.
- A3 tool-set-change [E]: a `prompt_snapshot` whose tool names differ from the previous snapshot, else tool names used at turn *n* that no earlier turn used and no earlier snapshot listed.
- A5 tokens are the inline estimate. A `<persisted-output>` result whose inline preview is under the threshold is not a big output (Claude Code already externalized it, M6 dogfood review): it never makes a finding on its own and is only counted in `data.persistedByClaudeCode` of a group that has big outputs; the full size of persisted big outputs goes to `data.persistedBytes`. A `for`/`while`/`until … do …` loop is grouped by the first meaningful command of its body (`echo`, `printf`, `[`, `test`… skipped, `$` words dropped), e.g. `cat (in a loop)`, else by its first two words. Bash commands are grouped by `normalizeCommand`: leading `cd <dir> &&` / `cd <dir>;` (quoted dirs too) are dropped, then `shortCommand` keeps two words after env assignments and shows any word with `=` as `…`; path words are made relative to the cwd and home directories shown as `~`. Titles and `data.command` use only that form. Reads that A6 reports as repeats, and reads A11 reports as cross-agent copies (M7), are left out of A5, so WHERE IT WENT never counts one result twice.
- A6: one finding per (session, file path); different offset/limit ranges of a file are separate read keys but are reported together. Paths are compared canonically (`/` separators, resolved against the cwd, `.`/`..` collapsed, drive letter lowercased); offset/limit go through `Number()`, and offset 0/1 or limit 0 mean omitted (limit 1 stays a one-line read). Changes come from every chain of the session and from subagent sessions whose `parentSessionId` is the session, merged by timestamp. An Agent/Task tool_use and a compaction forget every read. A Bash command forgets a file when one of its words (split on whitespace, quotes and shell punctuation) has the file's name [E]. A read whose result `is_error` does not count. Paths are shown relative to the session cwd, else a leading home directory as `~`.

**M6 dogfood notes.**
- A8 reports per session tree: at most one finding for the main session (with `data.curve`) and one aggregated finding for all flagged subagents of that session (`data.subagents`, `data.max` = largest subagent peak, which is also the finding's tokens; one evidence entry per subagent, named by agent id). Titles name subagents by the first 8 characters of their agent id, never by the parent session id (also in A6 and A10 titles).

### 5.1 Cost model (M7)

Token counts stay measured. On top of them, every turn is priced at **API list prices** from a bundled, dated table (`src/cost/prices.ts`, `PRICES_AS_OF = 2026-10-19`, source <https://platform.claude.com/docs/en/about-claude/pricing.md>). There is **no network call**: prices change only when the table is edited. Every $ figure is labeled **[E] API list-price equivalent**. Max/Pro subscribers do not pay per token, so each reporter's legend says once: "$ = what these tokens would cost at API list prices; subscription limits are not published, use it to compare, not as a bill".

- **Price table** (USD per MTok: input, 5m cache write, 1h cache write, cache read, output). Fable 5.1 / Mythos 5.1 10, 12.5, 20, 0.25, 50 · Fable 5 / Mythos 5 10, 12.5, 20, 1, 50 · Opus 5.5 4, 5, 8, 0.20, 20 · Opus 5, 4.8, 4.7, 4.6, 4.5 5, 6.25, 10, 0.50, 25 · Opus 4.1, 4 15, 18.75, 30, 1.50, 75 · Sonnet 5.5 2, 2.5, 4, 0.10, 10 · Sonnet 5 2, 2.5, 4, 0.20, 10 · Sonnet 4.6, 4.5, 4 3, 3.75, 6, 0.30, 15 · Haiku 5.5 0.10, 0.125, 0.20, 0.01, 0.50 for prompts ≤ 100,000 tokens and 0.50, 0.625, 1, 0.05, 2.50 above (prompt length = input + cache read + cache write; each request priced on its own) · Haiku 4.5 1, 1.25, 2, 0.10, 5 · Haiku 3.5 0.80, 1, 1.60, 0.08, 4.
- **Model matching.** A model id matches a table id exactly or followed by a date (`-20251101`, `@20251101`) and/or a bracketed variant (`[1m]`); the longest id is tried first, so `claude-opus-5-5` never matches `claude-opus-5`. Anything else (including `<synthetic>` and ids such as `claude-3-5-haiku-20241022` that use the older naming) is **unpriced**: never guessed, counted in `cost.unpricedTurns` and `Report.pricing.unpricedModels`, and left out of every $ sum.
- **Turn cost** (`turnCost`, pure): input × input rate + 5m write × 5m rate + 1h write × 1h rate + cache read × read rate + output × output rate. Without a 5m/1h split the whole write uses the 5m rate (UNVERIFIED, §4.4).
- **Report fields** (additive in report v1, `REPORT_SCHEMA_VERSION` stays 1): `cost` on every `TokenTotals` (all, per session, project, model, day; `{ input, write5m, write1h, read, output, total, unpricedTurns }`, USD rounded to 1e-6), `totals.byRole.{main, subagent}` (subagent = subagent transcripts and inline sidechain turns), and `pricing { asOf, source, unpricedModels, note }`.
- **Not modeled** (limitations): `inference_geo` / data-residency multipliers, fast mode, the Batch API discount, long-context premiums other than Haiku 5.5's tier, and web search / fetch request fees.
- **Validation [M]:** on the 17-session dogfood snapshot (1,066 turns, Opus 5.5 + Sonnet 5.5), the total is $93.1174, equal to `ccusage session --json` `totalCost` ($93.11739; ccusage also prices 1h writes at 2× input). Reproduce with `pnpm validate:real --root <projects> --ccusage ccusage.json` (§7), which gates the total at ±$0.01.

### 5.2 Impact per finding (M7)

Raw token counts mix kinds that differ ~100× in price (on Opus 5.5 a cache read is $0.20/MTok, a 1h cache write $8, output $20), so findings also carry an optional **`impact { costUsd, savingsUsd, basis, confidence, savingsMainUsd, savingsSubagentUsd }`**: what the tokens behind the finding cost at list prices, what the suggested fix would plausibly have saved in this window (never more than the cost), one plain sentence saying how, and whether the tokens are measured (`measured-tokens`) or estimated. **TOP FINDINGS are ranked by `savingsUsd`**; findings without savings (unpriced models, cost-only findings) follow in the old order (severity, then tokens).

**Carry cost** (`src/cost/carry.ts`). Content that enters the context is written to the cache once and then re-read on every later request of the same chain until a compaction drops it or the chain ends. For content of *T* tokens added by a tool result of turn *i*: `carry = T × (write(i+1) + Σ_{t=i+2..end−1} unit(t))`, where `unit(t)` is the read price, or the write price on a turn that rewrote its prefix (the chain's first turn, or a turn meeting the A2 usage rule, sidechains included), each at that turn's own model price; `end` is the first turn after the next compaction, else the chain's end; `turnsCarried = end − (i+1)`. A chain is a subagent transcript, a session's main conversation, or one agentId's inline sidechain turns. A turn that wrote nothing is given its session's TTL write rate.

| Analyzer | costUsd | savingsUsd | confidence |
|---|---|---|---|
| A2 cache rebuild | Σ rebuild-turn cache writes at write price (5m/1h split) | Σ cacheWrite × (write − read price) per rebuild turn; per cause in `data.causes[].costUsd/savingsUsd` | measured-tokens |
| A4 tool definitions | all definition tokens × Σ over main-chain requests of sessions with a snapshot (read price, write price on cold/rebuild turns) | 0 (A7 counts what can be removed) | estimated |
| A5 big tool output | Σ carry of each output | carry of the part above `TRIMMED_OUTPUT_TOKENS` = 1,000 (≈ 100 lines kept); `data.turnsCarriedMax`, evidence says "stayed in context for N turns" | estimated |
| A6 repeated read | Σ carry of each duplicate copy | = cost (reference the earlier read) | estimated |
| A7 unused tools | unused (non-deferred) definition tokens × Σ over main-chain requests of the sessions whose snapshot lists them | = cost for MCP servers; 0 for built-ins | estimated |
| A8 context growth | Σ over the chain's turns of max(0, context − `contextLargeTokens`) × read price | = cost (an upper bound: "starting fresh / /clear between tasks avoids most of this") | estimated |
| A9 subagents | Σ subagent turn costs | cost − the same tokens re-priced one tier down (Opus / Fable / Mythos → `claude-sonnet-5-5`, Sonnet → `claude-haiku-5-5`, none for Haiku); `data.subagentTypes[]` groups by `subagent_type` of the parent Agent/Task tool_use (`(unknown)` when unlinked) with `explicitModel` = invocations that passed `model` | estimated, with the caveat that a cheaper model may need more or fewer tokens and may do worse |
| A10 | none (falls back to tokens) | | |
| A11 cross-agent read | Σ carry of every copy | (copies − 1) × the median copy's carry | estimated |

`savingsMainUsd` / `savingsSubagentUsd` split the savings by where the tokens were spent (subagent transcripts and inline sidechain turns count as subagent).

### 5.3 Action plan (M7)

The report's headline: `buildActionPlan(report)` (`src/cost/plan.ts`, pure) turns the priced findings into **at most 5 concrete changes**, ranked by `savingsUsd`, and stores them as `Report.actionPlan { windowCostUsd, actions[], combinedSavingsUsd, combinedSharePct, method, note }` (additive in report v1). Each action has `id`, `title`, `savingsUsd`, `sharePct` (of the window's cost), `confidence` (`measured-tokens` only when every source finding is), `why` (one or two sentences with the numbers), `change` (copy-pasteable; may span lines), `findings` (1-based numbers as the reporters list them, i.e. `sortFindings` order), `category`, and the main / subagent split. Actions under $0.005 are dropped.

| Action (`id`) | From | Category | Change |
|---|---|---|---|
| `subagent-model` | A9 per-parent findings (the all-parents summary is skipped), grouped by `subagent_type`, top 3 types | model | per type: `general-purpose` / `(unknown)` → `settings.json` `"env": { "CLAUDE_CODE_SUBAGENT_MODEL": "<model>" }` (a default: a per-call `model` still wins; `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` applies it to every subagent); `Explore` → `.claude/agents/Explore.md` with `model: <model>` (overrides the built-in); `Plan` → needs `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (moves every subagent); a custom type → `model:` in `.claude/agents/<type>.md`. Says how many launches passed `model` explicitly (that wins over settings) |
| `trim-output` | A5 | context | CLAUDE.md lines for the top 3 groups by command shape (`cat`/`sed`/`head`… → Read with offset/limit; `grep`/`rg` → `-l`/`-m 20`; `git show/diff` → `--stat`; `git log` → `-n 20 --oneline`; other commands → `… 2>&1 \| tail -n 100`; loops → `\| head -n 100`; Read, Grep, other tools). Commands are cut to two words like everywhere else |
| `shared-reads` | A11 | context | CLAUDE.md: put the facts subagents need from the file in their prompt |
| `repeated-reads` | A6 | context | CLAUDE.md: do not Read a file again unless it changed |
| `clear-context` | A8 main-session findings | context-reset | `/clear` (or a new session) between unrelated tasks |
| `narrow-subagents` | A8 subagent findings | context-reset | CLAUDE.md: one narrow task per subagent, short answers |
| `cache-breaks`, `model-switch`, `cc-upgrade`, `config-edit`, `tool-set-change` | A2 causes (`data.causes[].savingsUsd`); other causes get no action | rebuild | one sentence per cause (the TTL in the title follows the cause's fix text) |
| `unused-tools` | A7 MCP servers | tool-definitions | `permissions.deny` snippet (a whole server as `mcp__<server>` when none of its tools was used, else each unused tool; at most 8 entries, then "run `tknxray fix mcp`") |

**Combined savings: a conservative union, never a plain sum.** Per scope (main conversations, subagents, using `totals.byRole` costs): the `context` actions remove different tool results and are summed, but `context-reset` removes some of the same tokens, so the group counts `max(Σ context, Σ context-reset)`; that group, `rebuild`, `tool-definitions` and `model` combine as independent fractions of the scope's cost, `S = C × (1 − Π(1 − min(1, S_k / C)))`. The result is capped at the plain sum of the shown actions and at the window's cost. Reporters print it as "These N changes would have cut about X% of this window's cost [E]" ("This change" for one). **Upper bounds.** A8 savings are ceilings (some of that context was needed), so A8 impacts carry `upperBound: true`; an action built from one carries it too, and so does the plan (`combinedUpperBound`) when any shown action does. Reporters then print "up to $X" and "would have cut up to X%" instead of "~$X" / "about".

**Reporters.** Terminal: a `COST [E]` table right under TOKENS (total, output, cache read, cache write, input with % of cost and the main / subagent split; unpriced turns are named), then `WHAT TO CHANGE FIRST` (title, savings and share, why, the change word-wrapped and never truncated, source findings) and the combined line; TOP FINDINGS add "saves ~$X of $Y [E]". HTML: action-plan cards before the summary, each with a savings bar on one shared scale (the window's cost) and links to the finding cards; the cost composition bar next to the token composition bar; finding cards show savings and basis. No new script; CSP stays `default-src 'none'`. JSON: `actionPlan`. Each reporter's legend carries the $ note of §5.1. Reports without `cost` (older or unpriced windows) render without these sections.

**Subagent-model settings [UNVERIFIED].** The changes above follow the Claude Code docs page on subagents (code.claude.com/docs/en/sub-agents and /env-vars, read 2026-10-19): frontmatter `model` takes an alias or a full id; the model is resolved from the invocation's `model` parameter, then frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model; a project `.claude/agents/Explore.md` overrides the built-in Explore; Plan follows the main model unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Not checked against a real run. Likewise unverified: whether a `permissions.deny` rule removes MCP tool definitions from the prompt or only blocks calls. The permissions docs say a deny rule on a built-in tool name removes it from Claude's context, but say nothing about `mcp__` rules; the documented ways to keep a server's definitions out are toggling it off in `/mcp`, `disabledMcpjsonServers`, or `"alwaysLoad": false` (tool search).

## 6. Milestones and acceptance tests

| M | Scope | Acceptance (all automated unless noted) |
|---|---|---|
| **M0 Scaffold** | pnpm, tsup, vitest, eslint/prettier, CI on GitHub Actions (Node 20 & 22, ubuntu + macOS + windows), `bin/tknxray`, no-network test | `pnpm i && pnpm build && node dist/cli.js --version` works in CI on all 3 OSes; `no-network.test.ts` fails if any `http`/`https`/`net`/`fetch`/`undici` use appears in `dist/`; CI green on the draft PR |
| **M1 Parser** | discover, stream, records, dedupe, session graph, `doctor` | ≥ 12 fixtures pass (see §7); dedupe matches the hand-computed totals exactly; 0 crashes on a fuzzed corpus (1k random mutated lines); `doctor` on real logs lists unknown types; §4.4 questions answered in the SPEC (manual, by Alex's local run) |
| **M2 Core analyzers** | A1, A2, A3, A5, A6 + estimator calibration | each analyzer has ≥ 3 positive and ≥ 2 negative fixtures; A1 totals within ±0.5% of `npx ccusage session --json` on the same real logs (manual, documented in the PR); estimator median ratio reported |
| **M3 Reporters** | terminal, JSON (schema v1 + JSON Schema file), HTML (single file, inline CSS/JS, no CDN) | snapshot tests for all 3; HTML passes a test that it contains no `http(s)://` resource loads; `--json` validates against the schema; output fits 100 columns |
| **M4 Remaining analyzers + session view** | A4, A7, A8, A9, A10, `session` command, thresholds config | fixtures as in M2; on Alex's real logs ≥ 1 true positive per analyzer type, or documented as "none present" (manual); a false-positive review of 20 random findings shows ≤ 2 wrong (manual, recorded in `bench/REVIEW.md`) |
| **M5 Fix modules (preview)** | `tknxray fix mcp` (mcp-diet: emit a settings `permissions.deny` diff for never-used MCP tools; never writes without `--apply`); `cc-slim` design doc + prototype PostToolUse hook for Bash output; optional `tknxray capture` (API-key only, local echo server, measures tool-definition bytes, never forwards subscription OAuth) | the diff is valid JSON and merges into the existing settings in tests; the cc-slim prototype has a unit test for "keep failure lines, head/tail, dedupe stack frames"; a benchmark script exists. **No savings claim in the README until the benchmark (§8) shows it.** |
| **M7 Impact** | §5.1 bundled list-price table and cost totals; §5.2 `Finding.impact` with carry cost, ranking by savings, A11 cross-agent reads; §5.3 action plan in terminal, JSON and HTML | every turn priced or counted as unpriced; total within ±$0.01 of `ccusage session --json` `totalCost` on real logs (`pnpm validate:real --ccusage`); hand-computed $ tests per lever; combined savings ≤ plain sum and ≤ window cost; ≤ 5 actions; HTML CSP unchanged; 1 GB corpus < 10% slower than M6 (manual, `pnpm bench:full`). Savings are per-window estimates from the user's own logs, not a product claim |

## 7. Test plan
- **Fixtures** (`test/fixtures/projects/<name>/`, each a fake `projects/` tree; all synthetic or scrubbed): `minimal-single-turn`, `multi-block-same-msgid` (dedupe), `sidechain-replay`, `cross-session-copy`, `synthetic-error-turn` (like the real 2.1.296 not-logged-in case), `ttl-gap-rebuild`, `version-change-rebuild`, `model-switch`, `big-bash-output`, `repeated-read-unchanged`, `repeated-read-after-edit` (negative), `malformed-lines`, `nested-subagents-dir`, `unknown-record-types`, `string-vs-array-content`.
- **Generator:** `scripts/make-fixture.ts` builds sessions from a compact DSL, so tests can declare the expected findings.
- **Scrubber:** `scripts/scrub-fixture.ts` replaces text, paths and ids with deterministic hashes while keeping lengths and usage, so a real log can be turned into a shareable fixture.
- **Unit tests** per analyzer; **snapshot tests** per reporter; **property tests** (fast-check) that the parser never throws.
- **Real-log validation** (local only, never in CI): `pnpm validate:real [--root DIR] [--ccusage FILE]` runs on the default roots and prints parse stats, per-analyzer finding counts, A1 totals and, with a saved `npx ccusage@latest session --json` output, a per-session and total ±0.5% comparison, plus a list-price cost comparison against ccusage's `totalCost` (total within ±$0.01, §5.1). Counts only; session ids are hashed. The script never runs npx itself.
- **No-network test** in CI (see M0).

## 8. Benchmarks and performance targets
- Parse throughput ≥ **100 MB/s** of JSONL on an M-series laptop; 1 GB of logs analyzed in < 15 s; peak RSS < 300 MB (streaming, no full-file loads).
- `npx tknxray` cold start (cached npx) < 1.5 s for 50 MB of logs.
- Package size < 1 MB unpacked.
- Memory regression guard: `test/memory.test.ts` checks heap retained by `loadSessions` per MB of a synthetic corpus (deterministic, unlike peak RSS). Notes on what the parser keeps: FORMAT.md "Parser implementation notes".
- `bench/perf.ts` generates synthetic corpora (10 MB / 100 MB / 1 GB). CI (`.github/workflows/bench.yml`) runs the 10 MB and 100 MB sizes and records the results as an artifact (informational, never gating); the 1 GB run is manual via `pnpm bench:full`, because generating and parsing it three times per PR costs minutes of runner time and ~1 GB of disk.
- **Savings benchmark** (for README claims, later): Alex's own sessions, before/after applying the fixes over comparable weeks, reporting tokens per assistant turn and the cache hit ratio. Any claim of "equal quality" needs a task-pass-rate benchmark (e.g. a small SWE-bench-lite subset with an API key) and is out of scope until then.

## 9. Privacy and ToS
- Reads files only. No network calls, no telemetry, no account. Enforced in CI. The single exception is the opt-in `tknxray capture` bundle (`dist/capture.js`), which only *listens* on 127.0.0.1 and never connects out; CI checks that too ([capture.md](capture.md)).
- Reports contain token counts, tool names, file paths (relative) and commands (first tokens only) by default. Prompt and output text appears only with `--include-content`.
- HTML reports are self-contained and load nothing remote.
- No features for multi-account rotation, limit evasion, subscription-OAuth reuse in other harnesses, or cache keep-alive pings. `capture` mode is API-key only and opt-in.
- Not affiliated with Anthropic. Mention this in the README.

## 10. Distribution
- npm package **`tknxray`** with the `tknxray` bin and `npx tknxray` usage. Not published yet: `package.json` stays `"private": true` until Alex approves a release.
- **Name decision (2026-10-19): Alex picked `tknxray`.** `cctknxray` was the alternative; both were free on npm when checked on 2026-10-19. The project was called ccxray, but **`ccxray` is taken on npm** (checked 2026-10-18: v2.3.1, "X-ray vision for AI agent sessions — a transparent HTTP proxy and dashboard for Claude Code", an unrelated project with a different approach and a similar pitch). Earlier candidates were `tokenxray`, `cclens`, `cc-xray` (confusingly close to the taken name) and a scoped `@alexnieves-cs/ccxray`.
- The rename covers the package, the bin and every user-visible string (CLI output, report titles, the JSON report's `tool.name` value, docs). The GitHub repo stays `alexnieves-cs/ccxray` for now, and internal identifiers (temp-dir prefixes, the schema `$id` `urn:ccxray:schema:report:v1`) keep the old name. JSON report field names are unchanged.
- Provenance-signed releases via GitHub Actions (`npm publish --provenance`) — **manual approval by Alex**.
- Later: Homebrew tap, Claude Code plugin wrapper for the slim/diet modules.

## 11. Launch plan (all posts need Alex's approval)
1. Run on Alex's sessions (and volunteers' scrubbed JSON reports), then write "I analyzed N Claude Code sessions: X% of tokens were cache rebuilds", using only measured numbers.
2. README with a demo GIF (vhs/asciinema), a screenshot of the HTML report, and a privacy section up top.
3. Show HN, r/ClaudeAI, r/ClaudeCode, X replies in usage-limit threads, a helpful comment on #16157/#46917 with a JSON report, and a PR to [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code).
4. Respond to issues fast in week 1; add support for format changes as they appear.
5. Launch drafts live in `docs/launch/` and name the tool **tknxray** (`npx tknxray` once published). They link the repo, which is still `alexnieves-cs/ccxray`, so each post should say once that the tool was renamed because `ccxray` is taken on npm (the HN draft does).

## 12. Risks
- Anthropic ships a native breakdown. Mitigation: ship fast, keep the forensic depth (rebuild causes, version regressions), and support other agents later.
- Format drift. Mitigation: defensive parser, the `doctor` command, a version quirks table.
- Attribution errors. Mitigation: measured vs estimated labels, and evidence pointers on every finding.
