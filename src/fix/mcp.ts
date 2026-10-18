// mcp-diet (SPEC §6 M5): turn `tool-usage` findings (A7) into Claude Code `permissions.deny`
// rules for MCP tools that were never called. Pure: no I/O. The caller reads and writes files.
//
// Rule syntax, from Claude Code's permission docs as known to the author (not re-checked against
// a running version here): `mcp__<server>__<tool>` denies one tool, and `mcp__<server>` (or
// `mcp__<server>__*`) denies every tool of a server.
// UNVERIFIED: that a deny rule also removes the tool's definition from the request (i.e. saves
// tokens) rather than only blocking calls. SPEC §4.4 lists this; the effect must be measured.
import type { Finding } from '../model/index.js';
import { unifiedDiff } from './diff.js';

/** `data` of a `tool-usage` finding (M4 / A7), as agreed with that stream. */
// UNVERIFIED: this data shape is an inter-stream agreement, not yet checked against M4's A7.
export interface ToolUsageData {
  server: string;
  unusedTools: string[];
  usedTools: string[];
  defChars?: number;
}

export interface McpDenyOptions {
  /** Deny a whole server with `mcp__<server>` when none of its tools was used. Default true. */
  serverRules?: boolean;
  /** Labels for the diff header. */
  label?: string;
}

export interface McpServerPlan {
  server: string;
  /** Rules this server contributes (already present ones excluded). */
  rules: string[];
  unusedTools: number;
  /** Definition chars of the unused tools, when the analyzer knew them (measured chars). */
  defChars?: number;
}

export interface McpDenyPlan {
  /** Settings with the rules merged in. Other keys and their order are kept. */
  settings: Record<string, unknown>;
  /** The file text to write (re-serialized with the detected indent). */
  text: string;
  /** Deny rules added, in order. Empty when nothing changes. */
  added: string[];
  servers: McpServerPlan[];
  /** Findings or tool names that were ignored, with a reason. Never content. */
  skipped: string[];
  /** Unified diff from the existing text to `text`; '' when nothing changes. */
  diff: string;
}

// UNVERIFIED: Claude Code builds MCP tool names as mcp__<server>__<tool> from [A-Za-z0-9_-]
// characters (server names are normalized to that set). Not confirmed against a real log.
// Anything else is rejected so a finding can never inject another rule form such as `Bash(...)`.
const NAME = /^[A-Za-z0-9_-]+$/;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function readData(f: Finding): ToolUsageData | null {
  const d = f.data;
  if (f.analyzer !== 'tool-usage' || typeof d !== 'object' || d === null) return null;
  const { server, unusedTools, usedTools, defChars } = d as Record<string, unknown>;
  if (typeof server !== 'string' || !isStringArray(unusedTools) || !isStringArray(usedTools))
    return null;
  return {
    server,
    unusedTools,
    usedTools,
    ...(typeof defChars === 'number' && Number.isFinite(defChars) ? { defChars } : {}),
  };
}

function detectIndent(text: string): string | number {
  const m = /^\{\r?\n([ \t]+)\S/.exec(text);
  return m ? m[1]! : 2;
}

function parseSettings(existing: string | Record<string, unknown> | null): {
  before: string;
  settings: Record<string, unknown>;
} {
  if (existing === null) return { before: '', settings: {} };
  // A leading BOM is not JSON; parse without it (it is put back on output, see planMcpDeny).
  if (typeof existing === 'string' && existing.startsWith('\uFEFF')) existing = existing.slice(1);
  if (typeof existing !== 'string')
    return {
      before: `${JSON.stringify(existing, null, 2)}\n`,
      settings: structuredClone(existing),
    };
  if (existing.trim() === '') return { before: existing, settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new Error('settings file is not valid JSON (comments are not supported); not modified');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('settings file is not a JSON object; not modified');
  return { before: existing, settings: parsed as Record<string, unknown> };
}

export function planMcpDeny(
  findings: readonly Finding[],
  existingSettings: string | Record<string, unknown> | null,
  opts: McpDenyOptions = {},
): McpDenyPlan {
  const raw = typeof existingSettings === 'string' ? existingSettings : null;
  const bom = raw?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const crlf = raw?.includes('\r\n') === true;
  const { settings } = parseSettings(existingSettings);
  const before =
    raw ?? (existingSettings === null ? '' : `${JSON.stringify(existingSettings, null, 2)}\n`);
  let perms = settings.permissions;
  if (perms !== undefined && (typeof perms !== 'object' || perms === null || Array.isArray(perms)))
    throw new Error('`permissions` in the settings file is not an object; not modified');
  const deny = (perms as Record<string, unknown> | undefined)?.deny;
  if (deny !== undefined && !isStringArray(deny))
    throw new Error('`permissions.deny` is not an array of strings; not modified');
  const existing = new Set(deny ?? []);

  // Merge findings per server: a tool used anywhere is never denied.
  const skipped: string[] = [];
  const byServer = new Map<string, { unused: Set<string>; used: Set<string>; defChars?: number }>();
  for (const f of findings) {
    if (f.analyzer !== 'tool-usage') continue;
    const d = readData(f);
    if (!d) {
      skipped.push(`a tool-usage finding without the expected data shape`);
      continue;
    }
    if (!NAME.test(d.server)) {
      skipped.push(`server with an unsupported name (${d.server.length} chars)`);
      continue;
    }
    const s = byServer.get(d.server) ?? { unused: new Set(), used: new Set() };
    for (const t of d.unusedTools) s.unused.add(t);
    for (const t of d.usedTools) s.used.add(t);
    if (d.defChars !== undefined) s.defChars = (s.defChars ?? 0) + d.defChars;
    byServer.set(d.server, s);
  }

  const added: string[] = [];
  const servers: McpServerPlan[] = [];
  for (const server of [...byServer.keys()].sort()) {
    const s = byServer.get(server)!;
    const prefix = `mcp__${server}__`;
    const serverRule = `mcp__${server}`;
    const unused: string[] = [];
    for (const t of [...s.unused].sort()) {
      if (s.used.has(t)) continue;
      if (!t.startsWith(prefix) || !NAME.test(t.slice(prefix.length))) {
        skipped.push(`tool name not of the form ${prefix}<tool> in server ${server}`);
        continue;
      }
      unused.push(t);
    }
    if (unused.length === 0) continue;
    const serverCovered = existing.has(serverRule) || existing.has(`${prefix}*`);
    let rules: string[];
    if (serverCovered) rules = [];
    else if (s.used.size === 0 && opts.serverRules !== false) rules = [serverRule];
    else rules = unused.filter((t) => !existing.has(t));
    for (const r of rules) existing.add(r);
    added.push(...rules);
    servers.push({
      server,
      rules,
      unusedTools: unused.length,
      ...(s.defChars !== undefined ? { defChars: s.defChars } : {}),
    });
  }

  if (added.length === 0) return { settings, text: before, added, servers, skipped, diff: '' };
  const isNew = existingSettings === null;
  // Mutate in place so existing keys keep their position; new keys go last.
  if (perms === undefined) perms = settings.permissions = {};
  const p = perms as Record<string, unknown>;
  p.deny = [...(deny ?? []), ...added];
  // Keep the file's BOM and line endings so the diff only shows the changed lines. Compact
  // arrays/objects are still reflowed by JSON.stringify (documented in docs/fix-mcp.md).
  let text = `${JSON.stringify(settings, null, detectIndent(before.replace(/^\uFEFF/, '')))}\n`;
  if (crlf) text = text.replace(/\n/g, '\r\n');
  text = bom + text;
  const label = opts.label ?? 'settings.json';
  // An absolute label (POSIX `/x` or Windows `C:/x`) is shown as is, never as `a//x`.
  const abs = /^(\/|[A-Za-z]:\/)/.test(label);
  const diff = unifiedDiff(before, text, {
    from: isNew ? '/dev/null' : abs ? label : `a/${label}`,
    to: abs ? label : `b/${label}`,
  });
  return { settings, text, added, servers, skipped, diff };
}
