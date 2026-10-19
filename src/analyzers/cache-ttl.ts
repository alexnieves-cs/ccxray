// A12 cache-ttl (SPEC §5): would the other prompt-cache TTL have been cheaper for the main
// conversations? Claude Code picks 1h for the main conversation on a subscription within the
// plan, else 5m, and `promptCacheTtl` / CLAUDE_CODE_PROMPT_CACHE_TTL (5m | 1h, CC 2.1.242+)
// overrides it (code.claude.com/docs/en/prompt-caching, read 2026-10-19).
//
// Replays each main chain under the other TTL, from measured usage at list prices [E]:
//   5m → 1h: a ttl-expiry rebuild (A2/A3) after a gap of at most 1h would have read the prefix
//     the previous turn cached and written only the rest, at the 1h price. Every other 5m write
//     costs the 1h write price instead: costs Σ w5m × (write1h − write5m).
//   1h → 5m: a turn after a gap of 5m–1h that was not a rebuild read its context from a cache
//     that a 5m TTL would have let expire: costs cacheRead × (write5m − read). Every 1h write
//     costs the 5m price instead: saves Σ w1h × (write1h − write5m).
// A finding only when the net is positive. Subagent chains are left out: A2 does not check them
// for rebuilds, and they use their own setting (`subagentPromptCacheTtl`).
// UNVERIFIED: that the session's other turns would have been the same under the other TTL.
import { promptTokens, writeSplit } from '../cost/cost.js';
import { impact } from '../cost/impact.js';
import { priceFor } from '../cost/prices.js';
import type { Analyzer, Finding, Session, Turn } from '../model/index.js';
import { formatInt, formatUsd } from '../reporters/format.js';
import { findRebuilds, rebuildUsd } from './cache-rebuild.js';
import { evidenceFor, MAX_EVIDENCE, plural, realTurns } from './util.js';

const DOCS = 'https://code.claude.com/docs/en/prompt-caching';
/** Below this net saving the finding is noise. */
const MIN_NET_USD = 0.01;

const mainChain = (s: Session): Turn[] => realTurns(s).filter((t) => !t.isSidechain);

export const TTL_CHANGE = (ttl: '5m' | '1h'): string =>
  `In ~/.claude/settings.json (or the project's .claude/settings.json) set\n` +
  `  "promptCacheTtl": "${ttl}"\n` +
  `or export CLAUDE_CODE_PROMPT_CACHE_TTL=${ttl} (Claude Code 2.1.242 or later).`;

function toHour(
  sessions: readonly Session[],
  rebuilds: ReturnType<typeof findRebuilds>,
  hourMs: number,
): Finding | undefined {
  const five = sessions.filter((s) => !s.isSubagent && s.wrote1hCache !== true);
  const ids = new Set(five.map((s) => s.id));
  const saved = rebuilds.filter(
    (r) => ids.has(r.session.id) && r.cause === 'ttl-expiry' && r.ttl === '5m' && r.gapMs <= hourMs,
  );
  if (saved.length === 0) return undefined;
  const savedTurns = new Set(saved.map((r) => r.turn));
  let avoided = 0;
  let writeCost = 0;
  for (const r of saved) {
    const u = rebuildUsd(r.turn);
    const p = priceFor(r.turn.model, promptTokens(r.turn.usage));
    if (u === null || p === undefined) continue;
    // Under 1h the prefix the previous turn left in the cache is read; the rest of this turn's
    // write is new content, still written, at the 1h price.
    const w = r.turn.usage.cacheWrite;
    const kept = Math.min(w, r.prev.usage.cacheRead + r.prev.usage.cacheWrite);
    avoided += u.cost - (kept * p.read + (w - kept) * p.write1h) / 1e6;
    writeCost += u.cost;
  }
  let extra = 0;
  for (const s of five)
    for (const t of mainChain(s)) {
      if (savedTurns.has(t)) continue;
      const p = priceFor(t.model, promptTokens(t.usage));
      if (p === undefined) continue;
      extra += (writeSplit(t.usage).w5m * (p.write1h - p.write5m)) / 1e6;
    }
  const net = avoided - extra;
  if (!(net >= MIN_NET_USD)) return undefined;
  const evidence = [...saved]
    .sort((a, b) => b.turn.usage.cacheWrite - a.turn.usage.cacheWrite)
    .slice(0, MAX_EVIDENCE)
    .map((r) =>
      evidenceFor(
        r.turn,
        `${Math.round(r.gapMs / 60_000)} min gap; rewrote ${formatInt(r.turn.usage.cacheWrite)} tokens`,
      ),
    );
  return {
    analyzer: 'cache-ttl',
    severity: net >= 1 ? 'warn' : 'info',
    title:
      `${plural(saved.length, 'break')} of 5–60 min expired the 5-minute cache; ` +
      `a 1h TTL would have saved ${formatUsd(net)} net`,
    tokens: { value: saved.reduce((a, r) => a + r.turn.usage.cacheWrite, 0), kind: 'measured' },
    data: { ttl: '1h', rebuilds: saved.length, avoidedUsd: avoided, extraUsd: extra, netUsd: net },
    evidence,
    fix: { summary: 'set "promptCacheTtl": "1h" in settings.json', docsUrl: DOCS },
    impact: impact({
      costUsd: writeCost,
      savingsUsd: net,
      basis:
        `${plural(saved.length, 'rebuild')} after a 5–60 min gap would have read the cache ` +
        `(${formatUsd(avoided)} saved); the 1h write price on every other cache write costs ` +
        `${formatUsd(extra)}`,
      confidence: 'measured-tokens',
    }),
  };
}

function toFive(
  sessions: readonly Session[],
  rebuilt: Set<Turn>,
  fiveMs: number,
  hourMs: number,
): Finding | undefined {
  const hour = sessions.filter((s) => !s.isSubagent && s.wrote1hCache === true);
  let premium = 0;
  let lost = 0;
  const kept: Turn[] = [];
  for (const s of hour)
    for (const t of mainChain(s)) {
      const p = priceFor(t.model, promptTokens(t.usage));
      if (p === undefined) continue;
      premium += (writeSplit(t.usage).w1h * (p.write1h - p.write5m)) / 1e6;
      const g = t.gapMs;
      if (g !== null && g > fiveMs && g <= hourMs && !rebuilt.has(t) && t.usage.cacheRead > 0) {
        lost += (t.usage.cacheRead * (p.write5m - p.read)) / 1e6;
        kept.push(t);
      }
    }
  const net = premium - lost;
  if (!(net >= MIN_NET_USD) || premium <= 0) return undefined;
  return {
    analyzer: 'cache-ttl',
    severity: 'info',
    title:
      `The 1h cache TTL kept ${plural(kept.length, 'break')} of 5–60 min warm, ` +
      `but its write premium cost more: a 5m TTL would have saved ${formatUsd(net)} net`,
    tokens: {
      value: hour.reduce(
        (a, s) => a + mainChain(s).reduce((b, t) => b + writeSplit(t.usage).w1h, 0),
        0,
      ),
      kind: 'measured',
    },
    data: { ttl: '5m', warmBreaks: kept.length, premiumUsd: premium, lostUsd: lost, netUsd: net },
    evidence: kept
      .slice(0, MAX_EVIDENCE)
      .map((t) => evidenceFor(t, `${Math.round((t.gapMs ?? 0) / 60_000)} min gap kept warm by 1h`)),
    fix: {
      summary:
        'set "promptCacheTtl": "5m" in settings.json (on a subscription 1h is the in-plan ' +
        'default; this is a list-price comparison)',
      docsUrl: DOCS,
    },
    impact: impact({
      costUsd: premium,
      savingsUsd: net,
      basis:
        `1h writes cost ${formatUsd(premium)} more than 5m writes; a 5m TTL would have expired ` +
        `the cache on ${plural(kept.length, 'break')} of 5–60 min (${formatUsd(lost)} to rewrite)`,
      confidence: 'measured-tokens',
    }),
  };
}

export const cacheTtl: Analyzer = {
  id: 'cache-ttl',
  spec: 'A12',
  description: 'Whether the other prompt-cache TTL (5m or 1h) would have cost less (A12).',
  run(sessions, ctx) {
    const th = ctx.thresholds;
    const rebuilds = findRebuilds(sessions, th);
    const rebuilt = new Set(rebuilds.map((r) => r.turn));
    const found = [
      toHour(sessions, rebuilds, th.ttl1hMs),
      toFive(sessions, rebuilt, th.ttl5mMs, th.ttl1hMs),
    ].filter((f): f is Finding => f !== undefined);
    // A window with both 5m and 1h sessions can price both directions; there is one
    // promptCacheTtl setting, so only the larger net is advised.
    const net = (f: Finding): number => (typeof f.data?.netUsd === 'number' ? f.data.netUsd : 0);
    return found.length > 1 ? [found.reduce((a, b) => (net(b) > net(a) ? b : a))] : found;
  },
};
