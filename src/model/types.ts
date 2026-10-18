// Shared model types. Every stream (parser, analyzers, reporters) codes against these.
// Changing a type here is a cross-stream change: update docs/SPEC.md §4.1 in the same PR.
//
// Labels: fields documented as "measured" come straight from `message.usage` (or counts of
// records). Fields documented as "estimated" come from src/tokens/estimate.ts. See CLAUDE.md
// hard rule 2.

/** Measured token usage for one deduped API response (assistant turn). */
export interface Usage {
  /** `usage.input_tokens` (uncached input). Measured. */
  input: number;
  /** `usage.cache_creation_input_tokens`. Measured. */
  cacheWrite: number;
  /** `usage.cache_creation.ephemeral_5m_input_tokens`, when present. Measured. */
  cacheWrite5m?: number;
  /** `usage.cache_creation.ephemeral_1h_input_tokens`, when present. Measured. */
  cacheWrite1h?: number;
  /** `usage.cache_read_input_tokens`. Measured. */
  cacheRead: number;
  /** `usage.output_tokens`. Measured. */
  output: number;
  /** `usage.server_tool_use.web_search_requests`, when present. Measured count. */
  webSearchRequests?: number;
  /** `usage.server_tool_use.web_fetch_requests`, when present. Measured count. */
  webFetchRequests?: number;
}

/** Where a record came from, so every finding can be verified by hand. */
export interface SourcePointer {
  /** Absolute path of the JSONL file. Reporters must relativize or hash it (CLAUDE.md rule 4). */
  file: string;
  /** 1-based line number in `file`. */
  line: number;
}

export interface ToolUse {
  /** `tool_use.id` (e.g. `toolu_…`). */
  id: string;
  /** Tool name, e.g. `Bash`, `Read`, `mcp__github__create_issue`. */
  name: string;
  /** Raw `tool_use.input`. Analyzers may read it; reporters must not print it without --include-content. */
  input: unknown;
  /** `JSON.stringify(input).length`. */
  inputChars: number;
}

export interface ToolResult {
  /** `tool_result.tool_use_id`. */
  toolUseId: string;
  /** Name of the matching tool_use, when it was found. */
  toolName?: string;
  /** Characters of the tool_result content as logged (string length, or summed text block lengths). */
  chars: number;
  /** Estimated tokens for `chars` (src/tokens/estimate.ts). Estimated. */
  estTokens: number;
  /** `tool_result.is_error`, when present. */
  isError?: boolean;
  /** uuid of the user record that carried this tool_result. */
  recordUuid?: string;
  /** Timestamp of the user record that carried this tool_result. */
  ts?: Date;
  /** Raw content text, kept only when the parser was run with includeContent. */
  text?: string;
}

/**
 * One assistant turn = one deduped API response (unique message.id + requestId).
 * Claude Code writes one JSONL line per content block; the parser merges them here.
 */
export interface Turn {
  sessionId: string;
  /** uuid of the first JSONL line of this response. */
  uuid: string;
  /** `message.id` (`msg_…`). */
  messageId: string;
  /** Envelope `requestId` (`req_…`), when present. */
  requestId?: string;
  /** Timestamp of the first line of this response. */
  ts: Date;
  /** ms since the previous turn's ts in the same session (null for the first turn). */
  gapMs: number | null;
  /** 0-based index among this session's turns, in timestamp order. */
  index: number;
  /** `message.model`. `<synthetic>` for client-side error turns. */
  model: string;
  /** Envelope `version` (Claude Code version), when present. */
  ccVersion?: string;
  /** Envelope `isSidechain`. */
  isSidechain: boolean;
  /** Envelope `agentId`, when present (subagent transcripts). UNVERIFIED field name. */
  agentId?: string;
  /**
   * true for `model: "<synthetic>"` or envelopes carrying `isApiErrorMessage` / `error`.
   * Synthetic turns are excluded from token stats (SPEC §4.2) but kept for A10.
   */
  isSynthetic: boolean;
  /** Measured usage of this response, counted once after dedupe. */
  usage: Usage;
  /** `message.stop_reason` of the last block line, when present. */
  stopReason?: string;
  /** tool_use blocks emitted by this response. */
  toolUses: ToolUse[];
  /** tool_results answering this turn's toolUses (joined by id), in log order. */
  toolResults: ToolResult[];
  /** Number of content blocks by type, e.g. { text: 1, tool_use: 2, thinking: 1 }. */
  blockCounts: Record<string, number>;
  /** Pointer to the first JSONL line of this response. */
  source: SourcePointer;
}

/** A prompt the user typed (string content, or array content without tool_result blocks). */
export interface UserPrompt {
  uuid: string;
  ts: Date;
  chars: number;
  /** Raw prompt text, kept only when the parser was run with includeContent. */
  text?: string;
  source: SourcePointer;
}

/** Non-turn things that happened in a session and matter to analyzers (A3 rebuild causes, A8). */
export type SessionEvent =
  | {
      kind: 'compaction';
      ts: Date;
      uuid?: string;
      /** Which marker was seen, e.g. `isCompactSummary`, `system:compact_boundary`, `summary`. */
      marker: string;
      source: SourcePointer;
    }
  | {
      /** CLAUDE.md / memory files injected as an `attachment` of type `instructions`. */
      kind: 'instructions';
      ts: Date;
      files: { path: string; chars: number; hash: string }[];
      source: SourcePointer;
    }
  | {
      /** Tool definitions logged by `attachment.type = prompt_snapshot` (seen in CC 2.1.302). */
      kind: 'tools-snapshot';
      ts: Date;
      tools: { name: string; chars: number }[];
      /** Characters of the system prompt parts in the same snapshot, when present. */
      systemPromptChars?: number;
      source: SourcePointer;
    }
  | {
      kind: 'api-error';
      ts: Date;
      uuid?: string;
      detail: string;
      source: SourcePointer;
    };

export interface Session {
  /** Envelope `sessionId`. For subagent files that reuse the parent sessionId, see `agentId`. */
  id: string;
  /** Project directory name under `projects/` (cwd with `/` replaced by `-`). */
  project: string;
  /** Envelope `cwd` of the first record that had one, when present. */
  cwd?: string;
  /** JSONL files that contributed records to this session. */
  files: string[];
  /** true when the records come from a sidechain / subagent transcript. */
  isSubagent: boolean;
  /** For subagent sessions: the agent id (from the file name or envelope). UNVERIFIED. */
  agentId?: string;
  /** For subagent sessions: the parent session id, when known. */
  parentSessionId?: string;
  /** For subagent sessions: the parent's Task/Agent tool_use id, when it can be linked. UNVERIFIED. */
  parentToolUseId?: string;
  /** Deduped assistant turns, sorted by ts. */
  turns: Turn[];
  prompts: UserPrompt[];
  events: SessionEvent[];
  firstTs: Date;
  lastTs: Date;
  /** Distinct Claude Code versions seen in this session, in first-seen order. */
  ccVersions: string[];
}

/** Parse statistics, shown by `ccxray doctor` and embedded in reports. All counts are measured. */
export interface ParseStats {
  roots: string[];
  files: number;
  bytes: number;
  lines: number;
  blankLines: number;
  /** Lines that were not valid JSON or not a JSON object. Skipped. */
  malformedLines: number;
  /** Count of records per top-level `type`. */
  recordTypes: Record<string, number>;
  /** Subset of recordTypes that the parser does not know. */
  unknownRecordTypes: Record<string, number>;
  /** Count of `attachment.type` values. */
  attachmentTypes: Record<string, number>;
  /** Dropped by dedupe, by rule (SPEC §4.3): lines for the first rule, responses for the others. */
  dedupe: {
    /** Extra content-block lines of an already-seen (message.id, requestId). */
    sameResponseLines: number;
    /** Sidechain responses replaying a message.id seen in a non-sidechain record. */
    sidechainReplays: number;
    /** Responses copied into more than one session file. */
    crossSessionCopies: number;
  };
  /** Assistant turns flagged isSynthetic (excluded from token stats). */
  syntheticTurns: number;
  /** Count of records per Claude Code version. */
  ccVersions: Record<string, number>;
  /** Field-level oddities worth surfacing, e.g. "assistant without message.usage". */
  warnings: Record<string, number>;
}

export type Severity = 'info' | 'warn' | 'high';
export type TokenKind = 'measured' | 'estimated';

export interface Finding {
  /** Analyzer id, e.g. `cache-rebuild`. */
  analyzer: string;
  severity: Severity;
  title: string;
  tokens: { value: number; kind: TokenKind };
  /** Analyzer-specific structured data, e.g. { cause: 'ttl-expiry' }. Must not hold prompt/file content. */
  data?: Record<string, unknown>;
  evidence: { sessionId: string; turnUuid: string; detail: string; source?: SourcePointer }[];
  fix: { summary: string; diff?: string; docsUrl?: string };
}

export interface TokenTotals {
  input: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  /** read / (read + write + input). null when the denominator is 0. Measured. */
  cacheHitRatio: number | null;
  turns: number;
}

export interface Totals {
  all: TokenTotals;
  bySession: Record<string, TokenTotals>;
  byProject: Record<string, TokenTotals>;
  byModel: Record<string, TokenTotals>;
  /** Keyed by UTC day `YYYY-MM-DD`. */
  byDay: Record<string, TokenTotals>;
}

export interface SessionSummary {
  id: string;
  project: string;
  isSubagent: boolean;
  firstTs: string;
  lastTs: string;
  turns: number;
  ccVersions: string[];
  models: string[];
  totals: TokenTotals;
}

/** The machine-readable report. `--json` prints this; schema/report.v1.json describes it. */
export interface Report {
  schemaVersion: 1;
  tool: { name: 'ccxray'; version: string };
  generatedAt: string;
  window: { since: string | null; until: string | null; project: string | null };
  includeContent: boolean;
  stats: ParseStats;
  totals: Totals;
  sessions: SessionSummary[];
  findings: Finding[];
  /** Estimator calibration (SPEC §4.5), when enough samples exist. */
  calibration?: { samples: number; medianRatio: number | null; note: string };
}
