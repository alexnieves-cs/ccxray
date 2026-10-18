// Minimal line-based unified diff (LCS over the changed middle). Inputs are settings files, so
// quadratic time on the differing region is fine. Output follows `diff -u` conventions.

const NO_NL = '\u0000no-newline';

function lines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  // A last line without a trailing newline differs from the same text with one (diff -u marker).
  else ls[ls.length - 1] += NO_NL;
  return ls;
}

type Op = { t: ' ' | '-' | '+'; s: string };

function ops(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Op[] = a.slice(0, pre).map((s) => ({ t: ' ', s }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      out.push({ t: ' ', s: A[i++]! });
      j++;
    } else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!))
      out.push({ t: '-', s: A[i++]! });
    else out.push({ t: '+', s: B[j++]! });
  }
  for (const s of a.slice(a.length - suf)) out.push({ t: ' ', s });
  return out;
}

export function unifiedDiff(
  before: string,
  after: string,
  labels: { from: string; to: string },
  context = 3,
): string {
  if (before === after) return '';
  const all = ops(lines(before), lines(after));
  const changes = all.flatMap((o, k) => (o.t === ' ' ? [] : [k]));
  const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
  let c = 0;
  while (c < changes.length) {
    let last = c;
    while (last + 1 < changes.length && changes[last + 1]! - changes[last]! <= 2 * context) last++;
    const start = Math.max(0, changes[c]! - context);
    const end = Math.min(all.length, changes[last]! + context + 1);
    let aLine = 0;
    let bLine = 0;
    for (const o of all.slice(0, start)) {
      if (o.t !== '+') aLine++;
      if (o.t !== '-') bLine++;
    }
    const hunk = all.slice(start, end);
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aLen ? aLine + 1 : aLine},${aLen} +${bLen ? bLine + 1 : bLine},${bLen} @@`);
    for (const o of hunk) {
      if (o.s.endsWith(NO_NL))
        out.push(o.t + o.s.slice(0, -NO_NL.length), '\\ No newline at end of file');
      else out.push(o.t + o.s);
    }
    c = last + 1;
  }
  return `${out.join('\n')}\n`;
}
