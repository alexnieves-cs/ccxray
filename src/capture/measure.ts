// Sizes of one Messages API request body, for `tknxray capture`. Pure. Returns sizes and tool
// names only: no prompt, system or message content leaves this function.
import { estimateTokensFromChars } from '../tokens/estimate.js';

export interface CaptureMeasurement {
  bodyBytes: number;
  /** Per tool definition: name and JSON.stringify(definition).length. */
  tools: { name: string; chars: number }[];
  toolsChars: number;
  /** System prompt text chars (string, or the sum of `text` of its blocks). */
  systemChars: number;
  /** JSON.stringify(messages).length. */
  messagesChars: number;
  messages: number;
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f]/g;
const safeName = (v: unknown): string =>
  typeof v === 'string' ? v.replace(UNSAFE, '?').slice(0, 80) : '(unnamed)';

export function measureRequest(body: unknown, bodyBytes: number): CaptureMeasurement {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const tools = Array.isArray(b.tools)
    ? b.tools.map((t: unknown) => ({
        name: safeName((t as { name?: unknown } | null)?.name),
        chars: JSON.stringify(t ?? null).length,
      }))
    : [];
  let systemChars = 0;
  if (typeof b.system === 'string') systemChars = b.system.length;
  else if (Array.isArray(b.system))
    for (const part of b.system as unknown[]) {
      const text = (part as { text?: unknown } | null)?.text;
      if (typeof text === 'string') systemChars += text.length;
    }
  const messages = Array.isArray(b.messages) ? b.messages : [];
  return {
    bodyBytes,
    tools,
    toolsChars: tools.reduce((a, t) => a + t.chars, 0),
    systemChars,
    messagesChars: messages.length ? JSON.stringify(messages).length : 0,
    messages: messages.length,
  };
}

const n = (x: number): string => x.toLocaleString('en-US');
const tok = (chars: number): string => `~${n(estimateTokensFromChars(chars))} tokens [E]`;

export function formatMeasurement(m: CaptureMeasurement): string {
  const row = (label: string, chars: number): string =>
    `  ${label.padEnd(18)} ${n(chars).padStart(9)} chars [M]  ${tok(chars)}`;
  const lines = [
    'tknxray capture: first /v1/messages request (sizes only; no content was stored or printed)',
    `  ${'request body'.padEnd(18)} ${n(m.bodyBytes).padStart(9)} bytes [M]`,
    row(`tools (${m.tools.length})`, m.toolsChars),
    row('system prompt', m.systemChars),
    row(`messages (${m.messages})`, m.messagesChars),
    '  per tool:',
    ...[...m.tools]
      .sort((a, b) => b.chars - a.chars || (a.name < b.name ? -1 : 1))
      .map((t) => `    ${t.name.padEnd(40)} ${n(t.chars).padStart(9)} chars  ${tok(t.chars)}`),
    'Tokens are estimated as chars/4, not tokenized.',
  ];
  return `${lines.join('\n')}\n`;
}
