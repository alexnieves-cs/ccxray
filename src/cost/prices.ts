// Bundled API list prices (SPEC §5.1). NO network: this table is the only price source, and it is
// dated. Prices are USD per million tokens, from
//   https://platform.claude.com/docs/en/about-claude/pricing.md
// as read on 2026-10-19. Update PRICES_AS_OF with every edit.
//
// Not modeled (SPEC §5.1 limitations): inference_geo / data-residency multipliers, fast mode,
// the Batch API discount, and web search / fetch request fees. Every $ figure built on this
// table is an estimate [E] of what the tokens would cost at API list prices.

export const PRICES_AS_OF = '2026-10-19';
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing.md';

/** USD per million tokens. */
export interface Price {
  input: number;
  /** 5-minute cache write. */
  write5m: number;
  /** 1-hour cache write. */
  write1h: number;
  /** Cache read (hit). */
  read: number;
  output: number;
}

interface Entry {
  id: string;
  price: Price;
  /** Long-prompt tier: requests whose prompt exceeds `above` tokens use `price` of this tier. */
  tier?: { above: number; price: Price };
}

const p = (input: number, write5m: number, write1h: number, read: number, output: number) => ({
  input,
  write5m,
  write1h,
  read,
  output,
});

const FABLE_5_1 = p(10, 12.5, 20, 0.25, 50);
const FABLE_5 = p(10, 12.5, 20, 1, 50);
const OPUS_5 = p(5, 6.25, 10, 0.5, 25);
const OPUS_4 = p(15, 18.75, 30, 1.5, 75);
const SONNET_5 = p(2, 2.5, 4, 0.2, 10);
const SONNET_4 = p(3, 3.75, 6, 0.3, 15);

const TABLE: Entry[] = [
  { id: 'claude-fable-5-1', price: FABLE_5_1 },
  { id: 'claude-mythos-5-1', price: FABLE_5_1 },
  { id: 'claude-fable-5', price: FABLE_5 },
  { id: 'claude-mythos-5', price: FABLE_5 },
  { id: 'claude-opus-5-5', price: p(4, 5, 8, 0.2, 20) },
  { id: 'claude-opus-5', price: OPUS_5 },
  { id: 'claude-opus-4-8', price: OPUS_5 },
  { id: 'claude-opus-4-7', price: OPUS_5 },
  { id: 'claude-opus-4-6', price: OPUS_5 },
  { id: 'claude-opus-4-5', price: OPUS_5 },
  { id: 'claude-opus-4-1', price: OPUS_4 },
  { id: 'claude-opus-4', price: OPUS_4 },
  { id: 'claude-sonnet-5-5', price: p(2, 2.5, 4, 0.1, 10) },
  { id: 'claude-sonnet-5', price: SONNET_5 },
  { id: 'claude-sonnet-4-6', price: SONNET_4 },
  { id: 'claude-sonnet-4-5', price: SONNET_4 },
  { id: 'claude-sonnet-4', price: SONNET_4 },
  {
    // "Prompt length counts all input tokens, including cache reads and cache writes"; each
    // request is priced on its own.
    id: 'claude-haiku-5-5',
    price: p(0.1, 0.125, 0.2, 0.01, 0.5),
    tier: { above: 100_000, price: p(0.5, 0.625, 1, 0.05, 2.5) },
  },
  { id: 'claude-haiku-4-5', price: p(1, 1.25, 2, 0.1, 5) },
  // Haiku 3.5's API id uses the older naming (`claude-3-5-haiku-20241022`).
  { id: 'claude-3-5-haiku', price: p(0.8, 1, 1.6, 0.08, 4) },
  { id: 'claude-haiku-3-5', price: p(0.8, 1, 1.6, 0.08, 4) },
];

// Longest id first, so `claude-opus-5-5` is tried before `claude-opus-5`.
const BY_LENGTH = [...TABLE].sort((a, b) => b.id.length - a.id.length);

// What may follow a known id: a date (`-20251101`, Vertex-style `@20251101`) and/or a bracketed
// variant (`[1m]`). Anything else (e.g. `claude-opus-4-9`) is a different, unknown model.
const SUFFIX = /^(?:[-@]\d{8})?(?:\[[^\]]*\])?$/;

const cache = new Map<string, Entry | null>();

function entryFor(model: string): Entry | null {
  let e = cache.get(model);
  if (e !== undefined) return e;
  e = null;
  for (const x of BY_LENGTH)
    if (model.startsWith(x.id) && SUFFIX.test(model.slice(x.id.length))) {
      e = x;
      break;
    }
  cache.set(model, e);
  return e;
}

/** The table id a model id is priced as, or undefined when it is unpriced. */
export function pricedId(model: string): string | undefined {
  return entryFor(model)?.id;
}

/**
 * List price of one request on `model` whose prompt (input + cache read + cache write) is
 * `promptTokens`; undefined for an unknown model (`<synthetic>` included). Never guessed.
 */
export function priceFor(model: string, promptTokens = 0): Price | undefined {
  const e = entryFor(model);
  if (e === null) return undefined;
  return e.tier !== undefined && promptTokens > e.tier.above ? e.tier.price : e.price;
}

/**
 * The next tier down for the A9 "cheaper model" lever: Opus / Fable / Mythos → Sonnet 5.5,
 * Sonnet → Haiku 5.5; undefined for Haiku and unknown models.
 */
export function cheaperModel(model: string): string | undefined {
  const id = pricedId(model);
  if (id === undefined) return undefined;
  if (/^claude-(?:opus|fable|mythos)-/.test(id)) return 'claude-sonnet-5-5';
  if (id.startsWith('claude-sonnet-')) return 'claude-haiku-5-5';
  return undefined;
}
