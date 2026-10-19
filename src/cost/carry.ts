// Carry cost (SPEC §5.2): what a piece of prompt content costs over the turns it stays in context.
//
// Claude Code re-sends the whole conversation on every request, and the prompt cache bills it
// again each time: content that enters the context is written to the cache once (cache-write
// price) and then read back on every later request of the same chain (cache-read price) until a
// compaction drops it or the chain ends. A turn that rewrote its prefix (the chain's first turn,
// or a turn meeting the A2 rebuild rule, sidechains included) pays the write price again for
// everything it carries. So for content of `tokens` tokens that a tool result added after turn i:
//
//   carry = tokens × ( write(i+1) + Σ_{t = i+2 .. end-1} unit(t) ),   turnsCarried = end − (i+1)
//
// where unit(t) = write(t) on a cold/rebuild turn, else read(t), each at turn t's own model
// price (Haiku 5.5 tier included), `end` = the first turn after the next compaction, or the end
// of the chain. Unpriced turns count 0 $ (and the result is flagged `unpriced`).
// Estimated [E]: the tokens are chars/4 estimates and the position of the content in the cache
// is not logged.
// UNVERIFIED: that content stays in the cached prefix of every later request until a compaction,
// and that a turn meeting the A2 usage rule rewrote all of it (SPEC §4.4).
//
// A chain is a subagent transcript, or the main conversation of a session, or the inline
// sidechain turns of one agentId. Built once per (sessions, thresholds) and memoized, so every
// analyzer shares one index.
import type { Session, Thresholds, Turn } from '../model/index.js';
import { meetsRebuildRule, sessionTtl } from '../analyzers/rules.js';
import { unitPrices } from './cost.js';

export interface Chain {
  session: Session;
  turns: Turn[];
  /** Per-token cache-write price of each turn (TTL-weighted), 0 when unpriced. */
  write: Float64Array;
  /** Per-token cache-read price of each turn, 0 when unpriced. */
  read: Float64Array;
  /** true when the turn rewrote its prefix (first turn of the chain, or the A2 rule). */
  cold: Uint8Array;
  /** prefix[k] = Σ unit(t) for t < k, with unit = write on cold turns, else read. */
  prefix: Float64Array;
  /** Index of the first turn after the next compaction (exclusive end of the turn's segment). */
  segEnd: Int32Array;
  priced: Uint8Array;
}

export interface Carry {
  usd: number;
  /** Requests that included the content: the one that wrote it and every later one. */
  turnsCarried: number;
  /** Some carrying turn was on an unpriced model (its share is 0 $). */
  unpriced: boolean;
}

function chainKey(s: Session, t: Turn): string {
  if (s.isSubagent) return 'all';
  return t.isSidechain ? `side:${t.agentId ?? ''}` : 'main';
}

function buildChain(s: Session, turns: Turn[], th: Thresholds, compactions: number[]): Chain {
  const n = turns.length;
  const c: Chain = {
    session: s,
    turns,
    write: new Float64Array(n),
    read: new Float64Array(n),
    cold: new Uint8Array(n),
    prefix: new Float64Array(n + 1),
    segEnd: new Int32Array(n),
    priced: new Uint8Array(n),
  };
  // A turn that wrote nothing is given its session's TTL write rate (sessionTtl, UNVERIFIED).
  const ttl = sessionTtl(s);
  for (let i = 0; i < n; i++) {
    const t = turns[i]!;
    const p = unitPrices(t, ttl);
    if (p !== null) {
      c.write[i] = p.write;
      c.read[i] = p.read;
      c.priced[i] = 1;
    }
    const prev = turns[i - 1];
    c.cold[i] = prev === undefined || meetsRebuildRule(prev, t, th) ? 1 : 0;
    c.prefix[i + 1] = c.prefix[i]! + (c.cold[i] ? c.write[i]! : c.read[i]!);
  }
  // Segment ends: a compaction between turns j-1 and j starts a new segment at j.
  let end = n;
  let k = compactions.length - 1;
  for (let i = n - 1; i >= 0; i--) {
    c.segEnd[i] = end;
    if (i > 0) {
      const lo = turns[i - 1]!.ts;
      const hi = turns[i]!.ts;
      while (k >= 0 && compactions[k]! > hi) k--;
      if (k >= 0 && compactions[k]! > lo) end = i;
    }
  }
  return c;
}

export class CarryIndex {
  private readonly at = new Map<Turn, { chain: Chain; i: number }>();
  private readonly mains = new Map<Session, Chain>();
  readonly chains: Chain[] = [];

  constructor(sessions: readonly Session[], th: Thresholds) {
    for (const s of sessions) {
      const groups = new Map<string, Turn[]>();
      for (const t of s.turns) {
        if (t.isSynthetic) continue;
        const k = chainKey(s, t);
        let g = groups.get(k);
        if (g === undefined) groups.set(k, (g = []));
        g.push(t);
      }
      const compactions = s.events
        .filter((e) => e.kind === 'compaction')
        .map((e) => e.ts)
        .sort((a, b) => a - b);
      for (const [k, turns] of groups) {
        // Inline sidechains have no compaction markers of their own.
        const chain = buildChain(s, turns, th, k.startsWith('side:') ? [] : compactions);
        this.chains.push(chain);
        if (k === 'main' || k === 'all') this.mains.set(s, chain);
        turns.forEach((t, i) => this.at.set(t, { chain, i }));
      }
    }
  }

  /** Carry cost of `tokens` of content added by a tool result of `turn` (enters request i+1). */
  carry(turn: Turn, tokens: number): Carry {
    const pos = this.at.get(turn);
    if (pos === undefined || tokens <= 0) return { usd: 0, turnsCarried: 0, unpriced: false };
    const { chain: c, i } = pos;
    const end = c.segEnd[i]!;
    const first = i + 1;
    if (first >= end) return { usd: 0, turnsCarried: 0, unpriced: false };
    const perToken = c.write[first]! + (c.prefix[end]! - c.prefix[Math.min(first + 1, end)]!);
    let unpriced = false;
    for (let t = first; t < end && !unpriced; t++) unpriced = c.priced[t] === 0;
    return { usd: tokens * perToken, turnsCarried: end - first, unpriced };
  }

  /** The chain a turn belongs to, with its index. */
  position(turn: Turn): { chain: Chain; i: number } | undefined {
    return this.at.get(turn);
  }

  /** The main chain of a session (all turns for a subagent transcript). */
  mainChain(s: Session): Chain | undefined {
    return this.mains.get(s);
  }
}

const memo = new WeakMap<readonly Session[], { th: Thresholds; index: CarryIndex }>();

/** The CarryIndex of `sessions`, built once per sessions array and thresholds object. */
export function carryIndex(sessions: readonly Session[], th: Thresholds): CarryIndex {
  const m = memo.get(sessions);
  if (m !== undefined && m.th === th) return m.index;
  const index = new CarryIndex(sessions, th);
  memo.set(sessions, { th, index });
  return index;
}

/** Per-token price of content that is part of every request of `c` (e.g. tool definitions):
 * written on cold/rebuild turns, read on the others. Σ over the chain. */
export function everyTurnUnit(c: Chain): number {
  return c.prefix[c.turns.length]!;
}
