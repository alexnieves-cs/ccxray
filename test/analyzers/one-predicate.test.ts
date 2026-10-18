// The cache-rebuild analyzer (A2) and the `session` view's 🔁 / 📄 flags use one rule each.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRebuilds } from '../../src/analyzers/cache-rebuild.js';
import { repeatedReadToolUseIds } from '../../src/analyzers/repeated-read.js';
import { buildSessionView } from '../../src/commands/session.js';
import { DEFAULT_THRESHOLDS } from '../../src/model/index.js';
import { loadSessions } from '../../src/parser/index.js';

const FX = join(import.meta.dirname, '..', 'fixtures', 'projects');
const roots = readdirSync(FX).map((d) => join(FX, d));

describe('one predicate for A2 and A6', () => {
  it('session view flags exactly the turns A2 and A6 report', async () => {
    const { sessions } = await loadSessions({ roots });
    const th = DEFAULT_THRESHOLDS;
    const a2 = new Set(findRebuilds(sessions, th).map((r) => r.turn.uuid));
    const a6 = repeatedReadToolUseIds(sessions);
    const flagged = { rebuild: new Set<string>(), dup: new Set<string>() };
    const turnsByUuid = new Map(sessions.flatMap((s) => s.turns.map((t) => [t.uuid, t])));
    for (const s of sessions.filter((x) => !x.isSubagent)) {
      const { view, subagentRows } = buildSessionView(s, sessions, th);
      for (const r of [...view.rows, ...subagentRows]) {
        if (r.flags.includes('rebuild')) flagged.rebuild.add(r.uuid);
        if (r.flags.includes('dup-read')) flagged.dup.add(r.uuid);
      }
    }
    expect(a2.size).toBeGreaterThan(0);
    expect([...flagged.rebuild].sort()).toEqual([...a2].sort());
    const a6Turns = new Set(
      [...turnsByUuid.values()]
        .filter((t) => t.toolUses.some((u) => a6.has(u.id)))
        .map((t) => t.uuid),
    );
    expect(a6Turns.size).toBeGreaterThan(0);
    expect([...flagged.dup].sort()).toEqual([...a6Turns].sort());
  });
});
