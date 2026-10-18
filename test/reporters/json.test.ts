import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { REPORT_SCHEMA_VERSION } from '../../src/model/index.js';
import { renderJson } from '../../src/reporters/json.js';
import { sampleReport, SAMPLE_HOME } from '../helpers/sample-report.js';

const SCHEMA_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'schema',
  `report.v${REPORT_SCHEMA_VERSION}.json`,
);

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  // ajv-formats is CommonJS; its default export arrives as `default` or `default.default`.
  const mod = formatsModule as unknown as { default: unknown };
  const add = (
    typeof mod.default === 'function' ? mod.default : (mod.default as { default: unknown }).default
  ) as (a: Ajv2020) => void;
  add(ajv);
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object);
}

describe('json reporter', () => {
  it('matches the snapshot', async () => {
    await expect(renderJson(sampleReport(), { homeDir: SAMPLE_HOME })).toMatchFileSnapshot(
      '../__snapshots__/reporters/report.json',
    );
  });

  it('is stable regardless of input key order', () => {
    const a = sampleReport();
    const b = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(b).reverse());
    expect(renderJson(reversed as never)).toBe(renderJson(a));
    expect(renderJson(a).startsWith('{\n  "schemaVersion": 1,\n  "tool"')).toBe(true);
  });

  it('shares no absolute home paths', () => {
    const out = renderJson(sampleReport(), { homeDir: SAMPLE_HOME });
    expect(out).not.toContain('/home/dev');
    expect(out).toContain('"~/.claude/projects"');
    expect(out).toContain(
      '"file": "-home-dev-src-acme-api/3fa2c1d0-1111-4aaa-8bbb-000000000001/subagents/agent-7f3e.jsonl"',
    );
  });

  it('validates against schema/report.v1.json', () => {
    const validate = validator();
    const ok = validate(JSON.parse(renderJson(sampleReport())));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects a report missing a required field', () => {
    const validate = validator();
    const r = JSON.parse(renderJson(sampleReport())) as Record<string, unknown>;
    delete r.totals;
    expect(validate(r)).toBe(false);
    const f = JSON.parse(renderJson(sampleReport())) as { findings: Record<string, unknown>[] };
    delete f.findings[0]?.tokens;
    expect(validate(f)).toBe(false);
  });
});
