// Action plan (SPEC §5.3): the report's headline. Pure: Report in, ranked actions out.
//
// Each action is one concrete change, built from the findings that support it, with its $
// savings at list prices [E] and its share of the window's cost. At most MAX_ACTIONS, largest
// savings first. The combined line is a conservative union, never a plain sum (see combine()).
import type { Action, ActionCategory, ActionPlan, Finding, Report } from '../model/index.js';
import { sortFindings } from '../reporters/derive.js';
import { formatCompact, formatInt, formatUsd, shortCommand } from '../reporters/format.js';
import { COST_NOTE, usd } from './cost.js';

export const MAX_ACTIONS = 5;

export type { Action, ActionCategory, ActionPlan };

interface Picked {
  f: Finding;
  n: number;
}

const savings = (f: Finding): number => f.impact?.savingsUsd ?? 0;
const sum = (xs: readonly Picked[], k: (f: Finding) => number): number =>
  xs.reduce((a, x) => a + k(x.f), 0);

function action(
  id: string,
  category: ActionCategory,
  from: readonly Picked[],
  o: { title: string; why: string; change: string; savingsUsd?: number; mainUsd?: number },
  windowCost: number,
): Action | undefined {
  const total = o.savingsUsd ?? sum(from, savings);
  if (!(total > 0) || from.length === 0) return undefined;
  const sub =
    o.savingsUsd !== undefined
      ? Math.max(0, total - (o.mainUsd ?? total))
      : sum(from, (f) => f.impact?.savingsSubagentUsd ?? 0);
  return {
    id,
    title: o.title,
    savingsUsd: usd(total),
    sharePct: windowCost > 0 ? Math.round((total / windowCost) * 1000) / 10 : 0,
    confidence: from.every((x) => x.f.impact?.confidence === 'measured-tokens')
      ? 'measured-tokens'
      : 'estimated',
    why: o.why.charAt(0).toUpperCase() + o.why.slice(1),
    change: o.change,
    findings: from.map((x) => x.n),
    category,
    savingsMainUsd: usd(total - sub),
    savingsSubagentUsd: usd(sub),
    ...(from.some((x) => x.f.impact?.upperBound === true) ? { upperBound: true as const } : {}),
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

// ---- A9: subagents on a cheaper model ----------------------------------------------------

interface TypeAgg {
  type: string;
  agents: number;
  costUsd: number;
  savingsUsd: number;
  target: string;
  explicitModel: number;
}

/** How to point one subagent type at `target` (Claude Code docs: sub-agents and env-vars pages,
 * read 2026-10-19; model order: per-call `model`, then frontmatter, then
 * CLAUDE_CODE_SUBAGENT_MODEL, then the main model; _FORCE overrides all of them).
 * UNVERIFIED: taken from the docs, not checked against a real run (SPEC §4.4, §5.3). */
function typeChange(t: TypeAgg): string {
  const m = t.target;
  switch (t.type) {
    case 'general-purpose':
    case '(unknown)':
      return (
        `${t.type} subagents: in ~/.claude/settings.json (or the project's .claude/settings.json) set\n` +
        `  "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "${m}" }\n` +
        'It is a default: a model Claude picks for one call still wins. Also set ' +
        '"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1" to apply it to every subagent.'
      );
    case 'Explore':
      return `Explore: create .claude/agents/Explore.md with frontmatter \`model: ${m}\` (overrides the built-in)`;
    case 'Plan':
      return (
        'Plan: follows the main model unless settings.json also sets\n' +
        '  "env": { "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1" }   (moves every subagent)'
      );
    default:
      return `${t.type}: add \`model: ${m}\` to the frontmatter of .claude/agents/${t.type}.md`;
  }
}

function subagentAction(found: Picked[], windowCost: number): Action | undefined {
  // Per-parent findings only: the all-parents summary repeats them.
  const from = found.filter(
    (x) =>
      x.f.analyzer === 'subagent-cost' &&
      typeof x.f.data?.parentSessionId === 'string' &&
      savings(x.f) > 0,
  );
  const types = new Map<string, TypeAgg>();
  for (const { f } of from) {
    const rows = Array.isArray(f.data?.subagentTypes) ? (f.data.subagentTypes as unknown[]) : [];
    for (const r of rows) {
      if (typeof r !== 'object' || r === null) continue;
      const o = r as Record<string, unknown>;
      const type = str(o.type) ?? '(unknown)';
      const t = types.get(type) ?? {
        type,
        agents: 0,
        costUsd: 0,
        savingsUsd: 0,
        target: '',
        explicitModel: 0,
      };
      t.agents += num(o.agents);
      t.costUsd += num(o.costUsd);
      t.savingsUsd += num(o.savingsUsd);
      t.explicitModel += num(o.explicitModel);
      if (t.target === '') t.target = str(o.cheaperModel) ?? '';
      types.set(type, t);
    }
  }
  const top = [...types.values()]
    .filter((t) => t.savingsUsd > 0 && t.target !== '')
    .sort((a, b) => b.savingsUsd - a.savingsUsd || (a.type < b.type ? -1 : 1))
    .slice(0, 3);
  if (top.length === 0) return undefined;
  const targets = [...new Set(top.map((t) => t.target))];
  const cost = sum(from, (f) => f.impact?.costUsd ?? 0);
  const total = sum(from, savings);
  const agents = top.reduce((a, t) => a + t.agents, 0);
  const explicit = top.reduce((a, t) => a + t.explicitModel, 0);
  return action(
    'subagent-model',
    'model',
    from,
    {
      title: `Run ${top.map((t) => t.type).join(', ')} subagents on ${targets.join(' / ')}`,
      why:
        (top.length === 1 && top[0]!.costUsd >= cost - 0.005
          ? `${formatInt(top[0]!.agents)} ${top[0]!.type} subagent${top[0]!.agents === 1 ? '' : 's'} cost ${formatUsd(cost)}`
          : `${top
              .map(
                (t) =>
                  `${formatInt(t.agents)} ${t.type} subagent${t.agents === 1 ? '' : 's'} cost ${formatUsd(t.costUsd)}`,
              )
              .join(', ')} (all subagents: ${formatUsd(cost)})`) +
        `; the same tokens on ${targets.join(' / ')} would cost ${formatUsd(cost - total)}. ` +
        'A cheaper model may need more or fewer tokens and may do worse: try it on routine ' +
        'tasks first.' +
        (explicit > 0
          ? ` ${formatInt(explicit)} of ${formatInt(agents)} launches passed \`model\` ` +
            'explicitly, which wins over settings.'
          : ''),
      change: top.map(typeChange).join('\n'),
    },
    windowCost,
  );
}

// ---- A5: trim big tool outputs ---------------------------------------------------------

const FILE_DUMP = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'nl', 'bat']);
const SEARCH = new Set(['grep', 'rg', 'egrep', 'fgrep', 'ag', 'ack']);

const LOOP = ' (in a loop)';

/** One CLAUDE.md line for a big-output group (tool + two-word command). */
export function trimLine(tool: string, command: string | undefined): string {
  if (tool === 'Bash' && command !== undefined) {
    const loop = command.endsWith(LOOP);
    const cmd = loop ? command.slice(0, -LOOP.length) : command;
    const [w0 = '', w1 = ''] = cmd.split(' ');
    if (loop) return `- Pipe loops that print \`${cmd}\` output through \`| head -n 100\`.`;
    if (FILE_DUMP.has(w0))
      return `- Don't \`${w0}\` whole files: use Read with offset/limit, or \`grep -n\` for the part you need.`;
    if (SEARCH.has(w0) || (w0 === 'git' && w1 === 'grep'))
      return `- Run \`${cmd}\` with \`-l\`, \`-m 20\` or a narrower path.`;
    if (w0 === 'git' && (w1 === 'show' || w1 === 'diff'))
      return `- Run \`${cmd}\` with \`--stat\` first, then show one path.`;
    if (w0 === 'git' && w1 === 'log') return `- Run \`git log\` as \`git log -n 20 --oneline\`.`;
    return `- Run \`${cmd}\` as \`${cmd} … 2>&1 | tail -n 100\`.`;
  }
  if (tool === 'Read') return '- Read big files with offset/limit instead of whole.';
  if (tool === 'Grep') return '- Narrow Grep with a glob or path, or set head_limit.';
  return `- Ask \`${tool}\` for a narrower result.`;
}

/** A5's command, cut to its first two words (no env assignments), like every reporter shows it. */
function commandOf(f: Finding): string | undefined {
  const raw = str(f.data?.command);
  if (raw === undefined) return undefined;
  const loop = raw.endsWith(LOOP);
  const cmd = shortCommand(loop ? raw.slice(0, -LOOP.length) : raw);
  return cmd === '' ? undefined : cmd + (loop ? LOOP : '');
}

function trimAction(found: Picked[], windowCost: number): Action | undefined {
  const from = found.filter((x) => x.f.analyzer === 'big-tool-output' && savings(x.f) > 0);
  if (from.length === 0) return undefined;
  const top = [...from].sort((a, b) => savings(b.f) - savings(a.f)).slice(0, 3);
  const label = (f: Finding): string => {
    const cmd = commandOf(f);
    return cmd !== undefined ? `\`${cmd}\`` : (str(f.data?.tool) ?? 'tool');
  };
  const lines = [...new Set(top.map(({ f }) => trimLine(str(f.data?.tool) ?? '', commandOf(f))))];
  const longest = Math.max(...from.map(({ f }) => num(f.data?.turnsCarriedMax)));
  const count = sum(from, (f) => num(f.data?.count));
  return action(
    'trim-output',
    'context',
    from,
    {
      title: `Trim big tool outputs (${top.map(({ f }) => label(f)).join(', ')})`,
      why:
        `${formatInt(count)} big outputs stayed in context for up to ${formatInt(longest)} turns ` +
        `and cost ${formatUsd(sum(from, (f) => f.impact?.costUsd ?? 0))} to carry; savings ` +
        'assume each is cut to ~1k tokens (about 100 lines).',
      change: `Add to CLAUDE.md:\n${lines.join('\n')}`,
    },
    windowCost,
  );
}

// ---- A11 / A6: reads ----------------------------------------------------------------------

function sharedReadsAction(found: Picked[], windowCost: number): Action | undefined {
  const from = found.filter((x) => x.f.analyzer === 'cross-agent-read' && savings(x.f) > 0);
  if (from.length === 0) return undefined;
  const paths = [...from]
    .sort((a, b) => savings(b.f) - savings(a.f))
    .map(({ f }) => str(f.data?.path) ?? 'the file')
    .slice(0, 3);
  const agents = Math.max(...from.map(({ f }) => num(f.data?.agents)));
  return action(
    'shared-reads',
    'context',
    from,
    {
      title: `Stop every agent reading ${paths[0]}${paths.length > 1 ? ' and others' : ''}`,
      why:
        `Up to ${formatInt(agents)} agents of one session each read and carried their own ` +
        `copy of ${paths.join(', ')}.`,
      change:
        'Add to CLAUDE.md:\n' +
        `- When you start subagents, put the facts they need from ${paths.join(', ')} in their ` +
        'prompt instead of asking each one to read the file.',
    },
    windowCost,
  );
}

function repeatedReadsAction(found: Picked[], windowCost: number): Action | undefined {
  const from = found.filter((x) => x.f.analyzer === 'repeated-read' && savings(x.f) > 0);
  if (from.length === 0) return undefined;
  const paths = [
    ...new Set(
      [...from].sort((a, b) => savings(b.f) - savings(a.f)).map(({ f }) => str(f.data?.path) ?? ''),
    ),
  ]
    .filter(Boolean)
    .slice(0, 3);
  return action(
    'repeated-reads',
    'context',
    from,
    {
      title: 'Stop re-reading files that did not change',
      why: `${formatInt(sum(from, (f) => num(f.data?.rereads)))} re-reads of unchanged files (${paths.join(', ')}) were carried as extra copies.`,
      change:
        'Add to CLAUDE.md:\n- Do not Read a file again unless it changed; refer to the earlier read.',
    },
    windowCost,
  );
}

// ---- A8: context size ----------------------------------------------------------------------

function contextActions(found: Picked[], windowCost: number): Action[] {
  const growth = found.filter((x) => x.f.analyzer === 'context-growth' && savings(x.f) > 0);
  const main = growth.filter((x) => !(num(x.f.data?.subagents) > 0));
  const subs = growth.filter((x) => num(x.f.data?.subagents) > 0);
  const out: (Action | undefined)[] = [
    action(
      'clear-context',
      'context-reset',
      main,
      {
        title: 'Start a new session or /clear between unrelated tasks',
        why:
          `${main.map(({ f }) => f.impact?.basis ?? '').join('; ')}. An upper bound: some of ` +
          'that context was needed.',
        change: '/clear   (or start a new session) when you switch to an unrelated task',
      },
      windowCost,
    ),
    action(
      'narrow-subagents',
      'context-reset',
      subs,
      {
        title: 'Give subagents narrower tasks and short answers',
        why:
          `${subs.map(({ f }) => f.impact?.basis ?? '').join('; ')}. An upper bound: some of ` +
          'that context was needed.',
        change:
          'Add to CLAUDE.md:\n- Give each subagent one narrow task and ask it to return a ' +
          'short summary (paths, line numbers), not whole files or outputs.',
      },
      windowCost,
    ),
  ];
  return out.filter((a): a is Action => a !== undefined);
}

// ---- A2: rebuild causes --------------------------------------------------------------------

const rewrote = (o: Record<string, unknown>, what: string): string =>
  `${what} made Claude Code write ${formatCompact(num(o.tokens))} tokens of cache again ` +
  `(${formatUsd(num(o.costUsd))} at the write price; ` +
  `${formatUsd(num(o.costUsd) - num(o.savingsUsd))} as cache reads).`;
const times = (o: Record<string, unknown>, one: string, many: string): string =>
  num(o.count) === 1 ? one : `${formatInt(num(o.count))} ${many}`;

const CAUSE_ACTIONS: Record<
  string,
  {
    id: string;
    title: (fix: string) => string;
    why: (o: Record<string, unknown>) => string;
    change: string;
  }
> = {
  'ttl-expiry': {
    id: 'cache-breaks',
    title: (fix) =>
      /1h TTL/.test(fix) && !/5m TTL/.test(fix)
        ? 'Batch prompts so breaks stay under 1h'
        : /5m TTL/.test(fix) && !/1h TTL/.test(fix)
          ? 'Batch prompts so gaps stay under 5 minutes'
          : 'Batch prompts so breaks stay under the cache TTL',
    why: (o) => {
      const fix = str(o.fix) ?? '';
      const ttl =
        /1h TTL/.test(fix) && !/5m TTL/.test(fix)
          ? '1h'
          : /5m TTL/.test(fix) && !/1h TTL/.test(fix)
            ? '5-minute'
            : '';
      const label = `break${num(o.count) === 1 ? '' : 's'} longer than the ${ttl ? `${ttl} ` : ''}cache TTL`;
      return rewrote(
        o,
        num(o.count) === 1 ? `One ${label}` : `${formatInt(num(o.count))} ${label}`,
      );
    },
    change:
      'Send related prompts in one sitting so idle gaps stay under the cache TTL; after a ' +
      'longer break, start a new session (or /clear) instead of resuming a large context.',
  },
  'model-switch': {
    id: 'model-switch',
    title: () => 'Pick the model before the session starts',
    why: (o) =>
      rewrote(o, times(o, 'One /model switch mid-session', '/model switches mid-session')),
    change:
      'Choose the model when you start (claude --model …); /model mid-session rewrites the cache.',
  },
  'cc-upgrade': {
    id: 'cc-upgrade',
    title: () => 'Restart long sessions after upgrading Claude Code',
    why: (o) => rewrote(o, times(o, 'One Claude Code upgrade mid-session', 'upgrades mid-session')),
    change:
      'Finish or restart sessions after a Claude Code upgrade (see anthropics/claude-code#46917).',
  },
  'config-edit': {
    id: 'config-edit',
    title: () => 'Edit CLAUDE.md between sessions',
    why: (o) =>
      rewrote(o, times(o, 'One CLAUDE.md edit mid-session', 'CLAUDE.md edits mid-session')),
    change: 'Batch CLAUDE.md edits and make them between sessions, not during one.',
  },
  'tool-set-change': {
    id: 'tool-set-change',
    title: () => 'Set up MCP servers before the session starts',
    why: (o) =>
      rewrote(o, times(o, 'One tool-set change mid-session', 'tool-set changes mid-session')),
    change: 'Add or remove MCP servers and tools before starting a session.',
  },
};

function rebuildActions(found: Picked[], windowCost: number): Action[] {
  const out: Action[] = [];
  for (const x of found) {
    if (x.f.analyzer !== 'cache-rebuild' || !Array.isArray(x.f.data?.causes)) continue;
    for (const c of x.f.data.causes as unknown[]) {
      if (typeof c !== 'object' || c === null) continue;
      const o = c as Record<string, unknown>;
      const spec = CAUSE_ACTIONS[str(o.cause) ?? ''];
      if (spec === undefined) continue;
      const fix = str(o.fix) ?? '';
      const a = action(
        spec.id,
        'rebuild',
        [x],
        {
          title: spec.title(fix),
          why: spec.why(o),
          change: spec.change,
          savingsUsd: num(o.savingsUsd),
        },
        windowCost,
      );
      if (a !== undefined) out.push({ ...a, confidence: 'measured-tokens' });
    }
  }
  return out;
}

// ---- A7: unused MCP tools ------------------------------------------------------------------

// UNVERIFIED: whether a permissions.deny rule removes MCP tool definitions from the prompt or only
// blocks calls; the action's text says so (SPEC §4.4).
function unusedToolsAction(found: Picked[], windowCost: number): Action | undefined {
  const from = found.filter(
    (x) =>
      x.f.analyzer === 'tool-usage' && typeof x.f.data?.server === 'string' && savings(x.f) > 0,
  );
  if (from.length === 0) return undefined;
  const sorted = [...from].sort((a, b) => savings(b.f) - savings(a.f));
  const deny: string[] = [];
  let tools = 0;
  for (const { f } of sorted) {
    const server = str(f.data?.server)!;
    const unused = strs(f.data?.unusedTools);
    tools += unused.length;
    if (strs(f.data?.usedTools).length === 0) deny.push(`mcp__${server}`);
    else deny.push(...unused);
  }
  const MAX = 8;
  const shown = deny.slice(0, MAX).map((d) => `    "${d}"`);
  const more =
    deny.length > MAX ? `\n    … ${deny.length - MAX} more: run \`tknxray fix mcp\`` : '';
  const servers = sorted.map(({ f }) => str(f.data?.server)!);
  return action(
    'unused-tools',
    'tool-definitions',
    from,
    {
      title: `Remove MCP tools you never call (${servers.slice(0, 3).join(', ')}${servers.length > 3 ? ', …' : ''})`,
      why:
        `${formatInt(tools)} MCP tool definitions were sent with every main-session request ` +
        'and never called. Disabling a server removes its definitions; whether a deny rule ' +
        'also removes them (not only blocks calls) is unverified.',
      change:
        'Preview with `tknxray fix mcp`, or add to .claude/settings.json:\n' +
        `"permissions": { "deny": [\n${shown.join(',\n')}${more}\n] }`,
    },
    windowCost,
  );
}

// ---- Combined savings -------------------------------------------------------------------------

/**
 * Conservative union of the chosen actions' savings, per scope (main conversations, subagents):
 * within a scope, the `context` actions (trimming outputs, shared and repeated reads) touch
 * different tool results and are summed, but `context-reset` (/clear, narrower subagents)
 * removes some of the same tokens, so the two only count their max; the other categories act on
 * different levers and combine as independent fractions of the scope's cost:
 * S = C × (1 − Π(1 − S_k / C)). Never more than the plain sum, nor than the cost.
 */
export function combine(actions: readonly Action[], main: number, subagent: number): number {
  const scope = (cost: number, part: (a: Action) => number): number => {
    if (!(cost > 0)) return 0;
    const by = new Map<ActionCategory, number>();
    for (const a of actions) by.set(a.category, (by.get(a.category) ?? 0) + part(a));
    const groups = [
      Math.max(by.get('context') ?? 0, by.get('context-reset') ?? 0),
      by.get('rebuild') ?? 0,
      by.get('tool-definitions') ?? 0,
      by.get('model') ?? 0,
    ];
    const keep = groups.reduce((k, s) => k * (1 - Math.min(1, s / cost)), 1);
    return cost * (1 - keep);
  };
  return scope(main, (a) => a.savingsMainUsd) + scope(subagent, (a) => a.savingsSubagentUsd);
}

/** "These N changes" ("This change" for one), the start of the combined line. */
export const changesPhrase = (n: number): string =>
  n === 1 ? 'This change' : `These ${n} changes`;

export const COMBINE_METHOD =
  'conservative union: per scope (main, subagents), overlapping context levers count their ' +
  'max and the other levers combine as independent fractions of that scope’s cost';

export function buildActionPlan(report: Report): ActionPlan {
  const windowCost = report.totals.all.cost?.total ?? 0;
  // Numbered as every reporter lists them (the pipeline already stores them in this order).
  const found: Picked[] = sortFindings(report.findings).map((f, i) => ({ f, n: i + 1 }));
  const candidates = [
    subagentAction(found, windowCost),
    trimAction(found, windowCost),
    sharedReadsAction(found, windowCost),
    repeatedReadsAction(found, windowCost),
    ...contextActions(found, windowCost),
    ...rebuildActions(found, windowCost),
    unusedToolsAction(found, windowCost),
  ].filter((a): a is Action => a !== undefined && a.savingsUsd >= 0.005);
  const actions = candidates
    .sort((a, b) => b.savingsUsd - a.savingsUsd || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_ACTIONS);
  const roles = report.totals.byRole;
  const mainCost = roles?.main.cost?.total ?? windowCost;
  const subCost = roles?.subagent.cost?.total ?? 0;
  const combined = Math.min(
    windowCost,
    actions.reduce((a, x) => a + x.savingsUsd, 0),
    combine(actions, mainCost, roles !== undefined ? subCost : 0),
  );
  return {
    windowCostUsd: usd(windowCost),
    actions,
    combinedSavingsUsd: usd(combined),
    combinedSharePct: windowCost > 0 ? Math.round((combined / windowCost) * 1000) / 10 : 0,
    ...(actions.some((a) => a.upperBound === true) ? { combinedUpperBound: true as const } : {}),
    method: COMBINE_METHOD,
    note: COST_NOTE,
  };
}
