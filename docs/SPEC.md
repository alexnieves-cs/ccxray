# ccxray: specification

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

The cache issues above were diagnosed by hand, by users reading `cache_creation_input_tokens` in JSONL. ccxray automates that forensic work.

## 2. Users
1. **Max/Pro subscriber hitting limits.** Wants "why did I burn 40% in a day?" answered in one command, plus fixes.
2. **API-key user / team lead.** Wants cost attribution and regression detection across Claude Code versions.
3. **Power user with many MCP servers.** Wants to know which tools they never use and how much those tools cost on every cold turn.
4. **Issue reporters.** Want a shareable, privacy-safe JSON/HTML report to attach to bug reports like #46917.

Non-goals: live proxying of subscription traffic, multi-account management, prompt rewriting, and anything that changes Claude Code's requests.

## 3. CLI UX

```
npx ccxray                       # analyze all sessions in the last 7 days (default)
npx ccxray --since 2026-10-01    # date range
npx ccxray --project myrepo      # filter by project dir (substring)
npx ccxray session <id|latest>   # per-turn drill-down for one session
npx ccxray --html report.html    # self-contained HTML report (no external assets)
npx ccxray --json > report.json  # machine-readable output (schema-versioned)
npx ccxray --include-content     # allow snippets of prompts/outputs in reports (off by default)
npx ccxray doctor                # show discovered log dirs, CC versions, parse stats, unknown record types
```

Config dir discovery: `CLAUDE_CONFIG_DIR` (comma-separated allowed), `~/.config/claude/projects`, `~/.claude/projects` (same rules as ccusage **[M: ccusage docs]**).

### Example output (illustrative only; these numbers are made up)
```
ccxray · 42 sessions · 1,318 assistant turns · Oct 11–18 2026 · Claude Code 2.1.290–2.1.296

TOKENS (measured from usage fields)
  input (uncached)        1.2M    3%
  cache write (creation)  9.8M   24%
  cache read             28.4M   70%
  output                  1.1M    3%
  cache hit ratio  72%  (read / (read + write + input))

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
      → `ccxray fix mcp` (planned, M5) generates a permissions.deny diff

Run `ccxray session 3fa2` for per-turn detail · `--html` for a shareable report
```

`session` view: one row per assistant turn with timestamp, gap since the previous turn, model, input, cache write, cache read, output, the tool calls made in that turn, and a flag column (🔁 rebuild, 📄 dup read, 📦 big output).

## 4. Architecture

TypeScript (strict), Node ≥ 20, ESM, single package, bin `ccxray`. Runtime dependencies kept minimal (a small arg parser, a color library; no HTTP client).

```
src/
  cli.ts                 arg parsing, command routing
  discover.ts            find log dirs & files, CLAUDE_CONFIG_DIR handling
  parser/
    stream.ts            line-streaming JSONL reader (readline), malformed-line counter
    records.ts           zod-free hand-written type guards for known record types
    dedupe.ts            message.id / requestId / sidechain dedupe (see 4.3)
    session.ts           build Session → Turn[] graph via uuid/parentUuid
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
  sessionId: string; uuid: string; ts: Date; gapMs: number | null;
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

> **Status (2026-10-18):** answered as far as current evidence allows in [docs/FORMAT.md](FORMAT.md#spec-44-answers). Q1–Q3 have partial [M] answers from one CC 2.1.302 transcript (notably, Q3: tool definitions *are* logged in `attachment.type = prompt_snapshot` on that version). Q4 and Q5 remain UNVERIFIED until a corpus with subagents and compaction is probed.
1. Is `tool_result` content always inline in the JSONL, or truncated or externalized for big outputs? This affects tool-output sizing.
2. Do `attachment` records carry CLAUDE.md / memory / hook output, and can they be used to detect CLAUDE.md edits? (Fallback: compare file mtime against the session timeline.)
3. Are tool definitions logged anywhere? (Assumption: **no**. Fixed overhead is inferred from first-turn `cache_creation + input`, and optionally measured exactly via the M5 capture mode with an API key only.)
4. How subagent (Task/Agent) transcripts link to the parent tool_use.
5. Is compaction marked by a distinct record (e.g. a summary type or `isCompactSummary`)?
6. How field names drift across CC versions (keep a version → quirks table in `parser/quirks.ts`).

**Parser assumptions added in M1 [UNVERIFIED]** (details in [FORMAT.md](FORMAT.md#parser-implementation-notes-m1)):
- Lines without `requestId` are deduped by `message.id` within one file only.
- Older versions may write partial `output_tokens` on earlier block lines; the largest is kept.
- String `assistant.message.content` is one text block.
- Compaction markers: `isCompactSummary`, `system`/`compact_boundary`, `summary` (Q5). `system`/`api_error` is an API error.
- `isMeta: true` user lines are client-injected, not typed prompts.
- One file = one session (its first `sessionId`). Subagent files are below `{sessionId}/` or named `agent-<id>.jsonl`, reuse the parent's sessionId, and get `Session.id = <parent>:agent-<id>` (Q4).
- `prompt_snapshot` tool names come from `name` or `schema.name`; `systemPrompt[]` parts are strings or `{text}`.

### 4.5 Token estimator
- Baseline: `ceil(chars / 4)` for text and `ceil(JSON.stringify(x).length / 4)` for JSON. Always labeled *estimated*.
- Calibration (M2): on turns where only one new tool_result was added, compare the estimate against the measured delta in `input + cache_write`, and report the median ratio in `doctor`.
- No network tokenizer calls. An optional offline tokenizer can be plugged in later.

## 5. Analyzers

Each analyzer is a pure function with fixtures and snapshot tests. Thresholds are configurable (`--threshold.key=value`).

| # | Analyzer | Detection rule | Tokens reported | Suggested fix |
|---|---|---|---|---|
| A1 | **totals** | Sum the deduped usage per session/project/model/day; hit ratio = read / (read + write + input) | measured | n/a (context for everything else) |
| A2 | **cache-rebuild** | Turn *n* (n>1 within a session, non-sidechain) has `cache_creation ≥ max(10k, 0.5 × prev context)` **and** `cache_read` dropped by ≥50% vs turn *n-1* | measured (cache_write of the turn) | depends on cause (A3) |
| A3 | **rebuild-cause** | For each A2 hit, assign the first matching cause: (a) `gapMs > 5 min` (or > 60 min if the session wrote `ephemeral_1h` tokens) → **TTL expiry**; (b) `version` changed vs prev turn → **CC upgrade**; (c) `model` changed → **model switch**; (d) compaction record nearby → **compaction**; (e) CLAUDE.md / settings mtime inside the gap **[UNVERIFIED method]** → **config edit**; (f) MCP/tool set changed (inferred from new tool names appearing) **[E]**; else **unknown** | measured | TTL: "batch prompts; you had N gaps of 5–15 min". Upgrade: link known issues (#46917). Model switch: "/model mid-session invalidates the cache". Config edit: "edit CLAUDE.md between sessions". |
| A4 | **fixed-overhead** | First assistant turn of each session: `input + cache_write + cache_read` = baseline context. Report the median per CC version and a jump between versions ≥ 2k | measured (inferred meaning [E]) | "Your baseline grew 20k at 2.1.100" → link issue; suggest mcp-diet |
| A5 | **big-tool-output** | `tool_result` est. tokens ≥ 5k (configurable); group by tool name + normalized command (Bash: first 2 tokens, e.g. `pnpm test`) | estimated | Bash: `| tail -n 100`, `--silent`, `--reporter=dot`; Grep: narrower glob / `head_limit`; later `cc-slim` |
| A6 | **repeated-read** | Same `Read` file_path (with the same offset/limit) ≥ 2× in a session with no intervening Edit/Write/MultiEdit/Bash on that path | estimated (size of later reads) | "Reference the earlier read"; later the cc-slim dedupe hook |
| A7 | **tool-usage** | Count tool_use by name across the window; list tools/MCP servers (`mcp__server__tool`) never called. The definition size of unused tools is unknown from logs **[UNVERIFIED]**, so report counts only unless capture data exists | count; tokens only with capture | `permissions.deny` / scope the MCP server to a subagent (mcp-diet, M5) |
| A8 | **context-growth** | Per-session curve of context size (input + cache_read + cache_write); flag sessions over 150k or with ≥ 2 compactions | measured | "Start a new session / use /clear for unrelated tasks" |
| A9 | **subagent-cost** | Sum usage of sidechain/subagent transcripts vs parent | measured | "Route exploratory subagents to a smaller model via the subagent `model:` field" |
| A10 | **error-waste** | API error / synthetic turns, retries, tool_result `is_error` followed by an identical re-call | measured/estimated | context-specific |

Every finding includes evidence pointers (session, turn uuid) so a user can verify it by hand.

## 6. Milestones and acceptance tests

| M | Scope | Acceptance (all automated unless noted) |
|---|---|---|
| **M0 Scaffold** | pnpm, tsup, vitest, eslint/prettier, CI on GitHub Actions (Node 20 & 22, ubuntu + macOS + windows), `bin/ccxray`, no-network test | `pnpm i && pnpm build && node dist/cli.js --version` works in CI on all 3 OSes; `no-network.test.ts` fails if any `http`/`https`/`net`/`fetch`/`undici` use appears in `dist/`; CI green on the draft PR |
| **M1 Parser** | discover, stream, records, dedupe, session graph, `doctor` | ≥ 12 fixtures pass (see §7); dedupe matches the hand-computed totals exactly; 0 crashes on a fuzzed corpus (1k random mutated lines); `doctor` on real logs lists unknown types; §4.4 questions answered in the SPEC (manual, by Alex's local run) |
| **M2 Core analyzers** | A1, A2, A3, A5, A6 + estimator calibration | each analyzer has ≥ 3 positive and ≥ 2 negative fixtures; A1 totals within ±0.5% of `npx ccusage session --json` on the same real logs (manual, documented in the PR); estimator median ratio reported |
| **M3 Reporters** | terminal, JSON (schema v1 + JSON Schema file), HTML (single file, inline CSS/JS, no CDN) | snapshot tests for all 3; HTML passes a test that it contains no `http(s)://` resource loads; `--json` validates against the schema; output fits 100 columns |
| **M4 Remaining analyzers + session view** | A4, A7, A8, A9, A10, `session` command, thresholds config | fixtures as in M2; on Alex's real logs ≥ 1 true positive per analyzer type, or documented as "none present" (manual); a false-positive review of 20 random findings shows ≤ 2 wrong (manual, recorded in `bench/REVIEW.md`) |
| **M5 Fix modules (preview)** | `ccxray fix mcp` (mcp-diet: emit a settings `permissions.deny` diff for never-used MCP tools; never writes without `--apply`); `cc-slim` design doc + prototype PostToolUse hook for Bash output; optional `ccxray capture` (API-key only, local echo server, measures tool-definition bytes, never forwards subscription OAuth) | the diff is valid JSON and merges into the existing settings in tests; the cc-slim prototype has a unit test for "keep failure lines, head/tail, dedupe stack frames"; a benchmark script exists. **No savings claim in the README until the benchmark (§8) shows it.** |

## 7. Test plan
- **Fixtures** (`test/fixtures/projects/<name>/`, each a fake `projects/` tree; all synthetic or scrubbed): `minimal-single-turn`, `multi-block-same-msgid` (dedupe), `sidechain-replay`, `cross-session-copy`, `synthetic-error-turn` (like the real 2.1.296 not-logged-in case), `ttl-gap-rebuild`, `version-change-rebuild`, `model-switch`, `big-bash-output`, `repeated-read-unchanged`, `repeated-read-after-edit` (negative), `malformed-lines`, `nested-subagents-dir`, `unknown-record-types`, `string-vs-array-content`.
- **Generator:** `scripts/make-fixture.ts` builds sessions from a compact DSL, so tests can declare the expected findings.
- **Scrubber:** `scripts/scrub-fixture.ts` replaces text, paths and ids with deterministic hashes while keeping lengths and usage, so a real log can be turned into a shareable fixture.
- **Unit tests** per analyzer; **snapshot tests** per reporter; **property tests** (fast-check) that the parser never throws.
- **Real-log validation** (local only, never in CI): `pnpm validate:real` runs on `~/.claude` and prints parse stats, a ccusage cross-check and a finding sample.
- **No-network test** in CI (see M0).

## 8. Benchmarks and performance targets
- Parse throughput ≥ **100 MB/s** of JSONL on an M-series laptop; 1 GB of logs analyzed in < 15 s; peak RSS < 300 MB (streaming, no full-file loads).
- `npx ccxray` cold start (cached npx) < 1.5 s for 50 MB of logs.
- Package size < 1 MB unpacked.
- `bench/perf.ts` generates synthetic corpora (10 MB / 100 MB / 1 GB) and records the results in CI as an artifact (not gating at first).
- **Savings benchmark** (for README claims, later): Alex's own sessions, before/after applying the fixes over comparable weeks, reporting tokens per assistant turn and the cache hit ratio. Any claim of "equal quality" needs a task-pass-rate benchmark (e.g. a small SWE-bench-lite subset with an API key) and is out of scope until then.

## 9. Privacy and ToS
- Reads files only. No network calls, no telemetry, no account. Enforced in CI.
- Reports contain token counts, tool names, file paths (relative) and commands (first tokens only) by default. Prompt and output text appears only with `--include-content`.
- HTML reports are self-contained and load nothing remote.
- No features for multi-account rotation, limit evasion, subscription-OAuth reuse in other harnesses, or cache keep-alive pings. `capture` mode is API-key only and opt-in.
- Not affiliated with Anthropic. Mention this in the README.

## 10. Distribution
- npm package with the `ccxray` bin and `npx` usage. **Name status (checked 2026-10-18): `ccxray` is TAKEN on npm** (v2.3.1, "X-ray vision for AI agent sessions — a transparent HTTP proxy and dashboard for Claude Code"). That is a different approach (a proxy), but the same name and a similar pitch. Options:
  - publish as **`tokenxray`** (free on 2026-10-18) or **`cclens`** (free), or a scoped name `@alexnieves-cs/ccxray`;
  - consider renaming the project to avoid confusion with the existing package. **Decision needed from Alex before M3/publish.** (`cc-xray` is also free but confusingly close to the taken name.)
- Provenance-signed releases via GitHub Actions (`npm publish --provenance`) — **manual approval by Alex**.
- Later: Homebrew tap, Claude Code plugin wrapper for the slim/diet modules.

## 11. Launch plan (all posts need Alex's approval)
1. Run on Alex's sessions (and volunteers' scrubbed JSON reports), then write "I analyzed N Claude Code sessions: X% of tokens were cache rebuilds", using only measured numbers.
2. README with a demo GIF (vhs/asciinema), a screenshot of the HTML report, and a privacy section up top.
3. Show HN, r/ClaudeAI, r/ClaudeCode, X replies in usage-limit threads, a helpful comment on #16157/#46917 with a JSON report, and a PR to [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code).
4. Respond to issues fast in week 1; add support for format changes as they appear.

## 12. Risks
- Anthropic ships a native breakdown. Mitigation: ship fast, keep the forensic depth (rebuild causes, version regressions), and support other agents later.
- Format drift. Mitigation: defensive parser, the `doctor` command, a version quirks table.
- Attribution errors. Mitigation: measured vs estimated labels, and evidence pointers on every finding.
