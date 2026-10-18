// Hand-written type guards for transcript records (SPEC §4.2, docs/FORMAT.md). No zod.
// Guards check only the structure the parser reads. Unknown fields are ignored, and every
// accessor tolerates missing or wrongly typed values (CLAUDE.md hard rule 3).

import type { Usage } from '../model/index.js';

export type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Count map without a prototype: keys come from the logs, and a key like `valueOf` or
 * `__proto__` must not collide with Object.prototype (found by the fuzz test).
 */
export const counter = (): Record<string, number> => Object.create(null) as Record<string, number>;
export const inc = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};
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
