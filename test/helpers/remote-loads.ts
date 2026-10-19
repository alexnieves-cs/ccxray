// Detector for anything in an HTML page that could load from the network (CLAUDE.md rule 1).
/** Every way an HTML page could load something remote. */
export function remoteLoads(html: string): string[] {
  const hits: string[] = [];
  const tagRe =
    /<(script|link|img|iframe|source|video|audio|embed|object|frame|base|form)\b[^>]*>/gi;
  for (const m of html.matchAll(tagRe)) {
    if (/\b(src|href|data|action|srcset|poster)\s*=\s*["']?\s*(https?:)?\/\//i.test(m[0]))
      hits.push(m[0]);
  }
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    if (/href\s*=\s*["']?\s*(https?:)?\/\//i.test(m[0]) && !/rel="[^"]*noreferrer/.test(m[0])) {
      hits.push(m[0]);
    }
  }
  for (const re of [
    /url\(\s*["']?\s*(https?:)?\/\//i,
    /@import/i,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /WebSocket/,
  ]) {
    const m = re.exec(html);
    if (m) hits.push(m[0]);
  }
  return hits;
}
