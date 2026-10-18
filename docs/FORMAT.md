# Claude Code transcript format: what ccxray relies on

Status: **partial ground truth.** This file answers SPEC §4.4 with evidence where it exists and marks the rest **UNVERIFIED**. It contains counts and field paths only, never content.

Labels: **[M]** measured in a real transcript listed under "Evidence" · **[D]** documented by ccusage's Claude adapter, not seen locally · **[UNVERIFIED]** not confirmed by any real log yet.

## Evidence

| Corpus | CC version | Files | Lines | Bytes | Collected |
|---|---|---|---|---|---|
| C1: one Claude Code on the web session (`entrypoint: remote_projects`), the cloud session that built M1 | 2.1.302 | 1 | 202 | 1,142,960 | 2026-10-18, `pnpm probe` |
| SPEC §4.2 notes from the dev box | 2.1.296 | n/a | n/a | n/a | before this doc |

C1 is a single session in one environment. It has no subagents, no compaction and no API errors, so anything about those is still UNVERIFIED. **Alex's own `~/.claude` corpus has not been probed yet** (it is not reachable from the cloud build environment). Running `pnpm probe > probe.json` locally and pasting the output here is the next step; the probe prints counts only.

## Layout

- `projects/{project}/{sessionId}.jsonl` **[M: C1, 1 of 1 files flat]**. The project dir is the cwd with `/` → `-` **[M: C1 `-home-user-ccxray`]**.
- Nested `projects/{project}/{sessionId}/subagents/*.jsonl` **[D; UNVERIFIED locally: no nested files in C1]**. The parser walks any depth.
- Roots: `CLAUDE_CONFIG_DIR` (comma-separated), `~/.config/claude/projects`, `~/.claude/projects` **[D]**. C1 had only `~/.claude/projects`.

## Records

One JSON object per line. Top-level `type` counts in C1 **[M]**:

| type | C1 count | Notes |
|---|---|---|
| `attachment` | 58 | context injected by the client; see below |
| `assistant` | 58 | one line per content block of a response |
| `user` | 35 | typed prompts and tool results |
| `ai-title` | 13 | `aiTitle` string; no envelope `uuid`/`timestamp` |
| `queue-operation` | 13 | `operation`, `timestamp`, optional `content` |
| `atis-latch` | 13 | `atis` |
| `last-prompt` | 12 | `leafUuid` |

Also seen on 2.1.296 per SPEC §4.2: `cost-state`. Not seen in C1. `ai-title` is new relative to the SPEC list (**version drift**, Q6). `summary` and `system` records: 0 in C1.

### Envelope

Present on every `user` / `assistant` / `attachment` line in C1 **[M]**: `uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO-8601 UTC), `type`, `isSidechain`, `cwd`, `gitBranch`, `version`, `userType`, `entrypoint`. `parentUuid` links resolved for 50 of 50 non-null links in an early C1 snapshot **[M]**.

Additional `assistant` envelope fields in 2.1.302 **[M]**: `requestId` (58/58), `apiBlockIndex`, `requestedModel`, `advisorModel`, `effort`, `perTurnEffort`, sometimes `thinkingDurationMs`, `wireToolInputs`, `attributionMcpServer`, `attributionMcpTool`.

Additional `user` envelope fields **[M]**: `promptId`, `toolUseResult` (on tool-result lines), `sourceToolAssistantUUID`, `permissionDecision`, `permissionMode`, `isMeta`.

### assistant.message

Keys **[M: 58/58]**: `id`, `model`, `role`, `type`, `content`, `stop_reason`, `stop_sequence`, `stop_details`, `usage`, `container`, `context_management`, `diagnostics`, `input_transformations`.

`content` is always an array in C1 and **each line carries exactly one block** (`apiBlockIndex` 0, 1, 2 …). Lines per (`message.id`, `requestId`): 1 line × 4 responses, 2 lines × 24, 3 lines × 2 **[M]**. Block types: `tool_use` 34, `thinking` 22, `text` 2 **[M]**. `tool_use` blocks have `id`, `name`, `input` **[M]** (resolves the SPEC §4.2 UNVERIFIED note).

**`usage` is identical on every line of one response** in C1 (input, cache write, cache read and output all equal across the 2–3 lines) **[M]**. Older versions may have written partial `output_tokens` on earlier lines **[UNVERIFIED]**, so the parser keeps the line with the largest `output_tokens` per response; on C1 that is the same as "count once".

### message.usage

Keys **[M: 58/58]**: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, `server_tool_use.{web_search_requests, web_fetch_requests}`, `output_tokens_details.thinking_tokens`, `service_tier`, `inference_geo`, `iterations`, `speed`, `fallback_credit`.

`iterations` is an array of `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation, type}` **[M]**. ccxray uses the top-level fields only, matching ccusage **[D]**. `output_tokens_details.thinking_tokens` is new relative to SPEC §4.2.

### user.message

`content` is a string for typed prompts (2) or an array (33) **[M]**. Array content held `tool_result` blocks keyed by `tool_use_id` (33) **[M]** (resolves the SPEC §4.2 UNVERIFIED note). `tool_result.content` is a string (26) or an array of `{type: "text", text}` blocks (7) **[M]**. `is_error` is present on some blocks **[M]**.

### attachment

`attachment.type` values in C1 **[M]**: `total_tokens_reminder` 30, `deferred_tools_record` 6, `task_reminder` 3, `hook_additional_context` 2, `prompt_snapshot` 2, and 1 each of `environment`, `model`, `deferred_tools_delta`, `agent_listing_delta`, `mcp_instructions_delta`, `skill_listing`, `auto_mode`, `instructions`, `session_context`, `context_sections`, `date`, `credential_org`, `remote_session_change`, `queued_command`, `hook_success`. Some of these are probably specific to the web entrypoint **[UNVERIFIED]**.

## SPEC §4.4 answers

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Is `tool_result` content inline, or truncated/externalized for big outputs? | **Inline up to at least 22,777 chars.** For all 24 Bash results in C1, `tool_result` length equals `toolUseResult.stdout + stderr` length exactly. Sizes: p50 339, p90 1,421, max 22,777 chars. Behavior above ~30k chars (Claude Code's Bash output cap) is **UNVERIFIED**: the log may hold the truncated text, a pointer to a saved file, or both. | [M: C1] |
| 2 | Do `attachment` records carry CLAUDE.md / memory / hook output; can they detect CLAUDE.md edits? | **Yes in 2.1.302.** `attachment.type = "instructions"` has `files[]` with `path`, `type`, `content`; hook output arrives as `hook_additional_context` (`hookName`, `hookEvent`, `content`) and `hook_success`. A CLAUDE.md edit can be detected by a change in a file's content hash/length between two `instructions` attachments. Whether a mid-session edit produces a *new* `instructions` attachment is **UNVERIFIED** (C1 has only one, at session start); mtime remains the fallback. | [M: C1, 1 instructions attachment with 1 file] |
| 3 | Are tool definitions logged anywhere? | **Yes in 2.1.302, contrary to the SPEC assumption.** `attachment.type = "prompt_snapshot"` carries `systemPrompt[]` (15 parts) and, on one of two snapshots, `tools[]` (64 entries, each `{name, description, schema: {name, description, input_schema, …}}`). This makes A4/A7 tool-definition sizes measurable in chars (tokens still [E]). Whether CLI sessions (non-web entrypoints) write `prompt_snapshot` is **UNVERIFIED**; it may be a web-entrypoint feature. | [M: C1] |
| 4 | How do subagent transcripts link to the parent tool_use? | **UNVERIFIED.** C1 has no subagents. ccusage documents nested `subagents/` dirs **[D]**. The parser links by (a) file location under `{sessionId}/subagents/`, (b) `isSidechain: true`, and (c) an `agentId` envelope field when present, and leaves `parentToolUseId` unset unless a `toolUseResult` on the parent references the agent. | none |
| 5 | Is compaction marked by a distinct record? | **UNVERIFIED.** 0 markers in C1 (no compaction happened). The parser recognizes `isCompactSummary: true` on a user line, `type: "system"` with `subtype: "compact_boundary"`, and `type: "summary"`, all from community reports, and counts each in `doctor`. | none |
| 6 | How do field names drift across CC versions? | Two data points only. 2.1.296 → 2.1.302: new record type `ai-title`; new envelope fields (`apiBlockIndex`, `requestedModel`, `advisorModel`, `effort`, `promptId`…); new `usage.output_tokens_details`; `cost-state` not seen in 2.1.302 (may be entrypoint-specific). Everything the analyzers depend on (`message.id`, `requestId`, `usage.*`, `tool_use`, `tool_result`) is stable across both. `src/parser/quirks.ts` holds the table. | [M: C1] vs SPEC §4.2 |

## Dedupe (SPEC §4.3) against C1

- Same response, several lines: confirmed **[M]**, see above. Key = (`message.id`, `requestId`).
- Sidechain replay and cross-session copies: **UNVERIFIED** (single session, no sidechains). Implemented per ccusage's documented behavior **[D]**.

## How to extend this document

1. `pnpm probe > /tmp/probe.json` on a machine with real logs (read-only; prints counts and key paths only).
2. Add a row to the Evidence table and update counts. Never paste content.
3. To add a fixture from a real session: `pnpm scrub path/to/session.jsonl -o test/fixtures/<name>.jsonl`, then read the output before committing. The scrubber refuses to write if any original string of 6+ chars survives.
