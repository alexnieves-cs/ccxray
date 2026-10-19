// Hand-written type guards for transcript records (SPEC §4.2, docs/FORMAT.md). No zod.
// Guards check only the structure the parser reads. Unknown fields are ignored, and every
// accessor tolerates missing or wrongly typed values (CLAUDE.md hard rule 3).

import type { Usage } from '../model/index.js';

export type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Count maps. Keys come from the logs, so a key like `valueOf` or `__proto__` must not collide with
 * Object.prototype (found by the fuzz test). A plain object with own-property checks keeps V8's
 * fast properties; `Object.create(null)` maps are dictionary-mode (~160 B each, one per turn).
 */
export const counter = (): Record<string, number> => ({});
export const inc = (m: Record<string, number>, k: string): void => {
  const v = Object.hasOwn(m, k) ? m[k]! + 1 : 1;
  if (k === '__proto__')
    Object.defineProperty(m, k, { value: v, writable: true, enumerable: true, configurable: true });
  else m[k] = v;
};

const interned = new Map<string, string>();
/**
 * One shared copy of short, highly repeated values (model, version, tool name, stop reason…):
 * JSON.parse makes a new string per line. Bounded so odd logs cannot grow it without limit.
 */
export function intern(s: string): string;
export function intern(s: string | undefined): string | undefined;
export function intern(s: string | undefined): string | undefined {
  if (s === undefined || s.length > 64) return s;
  const hit = interned.get(s);
  if (hit !== undefined) return hit;
  if (interned.size < 10_000) interned.set(s, s);
  return s;
}
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
const optCount = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

export function parseTs(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/** Types the parser reads for turns, prompts and events. */
export const CONVERSATION_TYPES = ['user', 'assistant', 'attachment', 'system', 'summary'];
/** Metadata types seen in real logs (FORMAT.md) and counted, but not otherwise used. */
export const METADATA_TYPES = [
  'queue-operation',
  'last-prompt',
  'cost-state',
  'atis-latch',
  'ai-title',
];
const KNOWN = new Set([...CONVERSATION_TYPES, ...METADATA_TYPES]);
export const isKnownType = (t: string): boolean => KNOWN.has(t);

export interface AssistantRecord extends Rec {
  type: 'assistant';
  message: Rec;
}
export interface UserRecord extends Rec {
  type: 'user';
  message: Rec;
}
export interface AttachmentRecord extends Rec {
  type: 'attachment';
  attachment: Rec & { type: string };
}
export interface SystemRecord extends Rec {
  type: 'system';
}
export interface SummaryRecord extends Rec {
  type: 'summary';
}

export const isAssistantRecord = (r: Rec): r is AssistantRecord =>
  r.type === 'assistant' && isRec(r.message);
export const isUserRecord = (r: Rec): r is UserRecord => r.type === 'user' && isRec(r.message);
export const isAttachmentRecord = (r: Rec): r is AttachmentRecord =>
  r.type === 'attachment' && isRec(r.attachment) && typeof r.attachment.type === 'string';
export const isSystemRecord = (r: Rec): r is SystemRecord => r.type === 'system';
export const isSummaryRecord = (r: Rec): r is SummaryRecord => r.type === 'summary';
export const isMetadataRecord = (r: Rec): boolean =>
  typeof r.type === 'string' && METADATA_TYPES.includes(r.type);

export interface ToolUseBlock extends Rec {
  type: 'tool_use';
  id: string;
  name: string;
}
export interface ToolResultBlock extends Rec {
  type: 'tool_result';
  tool_use_id: string;
}
export const isToolUseBlock = (b: unknown): b is ToolUseBlock =>
  isRec(b) && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string';
export const isToolResultBlock = (b: unknown): b is ToolResultBlock =>
  isRec(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string';

/** Text of string content, or of the `text` blocks of array content (other blocks ignored). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) if (isRec(b) && typeof b.text === 'string') out += b.text;
  return out;
}

/** Character count of `contentText` without building the string. */
export function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) if (isRec(b) && typeof b.text === 'string') n += b.text.length;
  return n;
}

/** `message.usage` → Usage. Missing or invalid numbers count as 0. undefined if not an object. */
export function readUsage(u: unknown): Usage | undefined {
  if (!isRec(u)) return undefined;
  const usage: Usage = {
    input: count(u.input_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    output: count(u.output_tokens),
  };
  const cc = isRec(u.cache_creation) ? u.cache_creation : undefined;
  const w5 = optCount(cc?.ephemeral_5m_input_tokens);
  const w1 = optCount(cc?.ephemeral_1h_input_tokens);
  if (w5 !== undefined) usage.cacheWrite5m = w5;
  if (w1 !== undefined) usage.cacheWrite1h = w1;
  const st = isRec(u.server_tool_use) ? u.server_tool_use : undefined;
  const ws = optCount(st?.web_search_requests);
  const wf = optCount(st?.web_fetch_requests);
  if (ws !== undefined) usage.webSearchRequests = ws;
  if (wf !== undefined) usage.webFetchRequests = wf;
  return usage;
}

const FILE_KEYS = ['file_path', 'notebook_path', 'offset', 'limit'];
const SEARCH_KEYS = ['pattern', 'path', 'glob', 'head_limit'];
const AGENT_KEYS = ['subagent_type', 'model'];
const SLIM_KEYS: Record<string, readonly string[] | undefined> = Object.assign(
  Object.create(null),
  {
    Read: FILE_KEYS,
    Edit: FILE_KEYS,
    Write: FILE_KEYS,
    MultiEdit: FILE_KEYS,
    NotebookEdit: FILE_KEYS,
    Bash: ['command'],
    Grep: SEARCH_KEYS,
    Glob: SEARCH_KEYS,
    Agent: AGENT_KEYS,
    Task: AGENT_KEYS,
  },
);

/**
 * Without includeContent, tool_use input is reduced to the few primitive fields analyzers need
 * (paths, offsets, the Bash command, search patterns, subagent type/model); everything else is
 * dropped to bound memory. Non-object input becomes undefined.
 */
const EMPTY: Rec = Object.freeze({});
export function slimToolInput(name: string, input: unknown): Rec | undefined {
  if (!isRec(input)) return undefined;
  const keys = SLIM_KEYS[name];
  if (keys === undefined) return EMPTY;
  const out: Rec = {};
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      out[k] = typeof v === 'string' ? intern(v) : v;
  }
  return out;
}
