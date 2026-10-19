// Find Claude Code transcript files (SPEC §3, §4.2). Read-only; never throws.

import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export interface DiscoveredFile {
  path: string;
  root: string;
  /**
   * Project directory name: the file's immediate parent dir, or for a subagent laid out under
   * its parent session (`subagentOf`), the dir that holds `{sessionId}/`. '' when that is the
   * root itself. Works for any root depth (a `projects/` dir or one above such trees).
   */
  project: string;
  /** Path segments between the project dir and the file: ['{sessionId}', 'subagents'],
   * ['{sessionId}'] or []. */
  dirs: string[];
  /**
   * Parent sessionId when the path is a subagent layout: `{sessionId}/subagents/*.jsonl` ([M]
   * CC 2.1.302) or `{sessionId}/agent-<id>.jsonl` (UNVERIFIED: older layout), where `{sessionId}`
   * is UUID-shaped. Any other file is a main transcript by layout.
   */
  subagentOf?: string;
  size: number;
  mtimeMs: number;
  /** Sibling `<stem>.meta.json` (subagent metadata, [M] CC 2.1.302), when it exists. */
  metaPath?: string;
}

export interface Discovery {
  /** Existing roots, deduped by realpath, in the order given. */
  roots: string[];
  /** Sorted by path, deduped by realpath. */
  files: DiscoveredFile[];
  /** Directories or files that could not be read. */
  errors: number;
}

/** `CLAUDE_CONFIG_DIR` (comma-separated, each `<dir>/projects`), then the two default dirs. */
export function defaultRoots(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string[] {
  const roots = (env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => join(d, 'projects'));
  roots.push(join(home, '.config', 'claude', 'projects'), join(home, '.claude', 'projects'));
  return roots;
}

function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

export async function discover(roots: string[] = defaultRoots()): Promise<Discovery> {
  const out: Discovery = { roots: [], files: [], errors: 0 };
  const seenRoots = new Set<string>();
  const seenFiles = new Set<string>();
  for (const r of roots) {
    const root = resolve(r);
    const rp = real(root);
    if (rp === undefined || seenRoots.has(rp)) continue;
    const st = await stat(root).catch(() => undefined);
    if (!st?.isDirectory()) continue;
    seenRoots.add(rp);
    out.roots.push(root);
    await walk(root, root, out, seenFiles, new Set());
  }
  out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Symlinked files and dirs are followed; `seenDirs` (realpaths) makes link loops safe. */
async function walk(
  dir: string,
  root: string,
  out: Discovery,
  seen: Set<string>,
  seenDirs: Set<string>,
): Promise<void> {
  const rdir = real(dir);
  if (rdir === undefined || seenDirs.has(rdir)) return;
  seenDirs.add(rdir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    out.errors++;
    return;
  }
  // Only *.jsonl is parsed. Other files (*.meta.json, *.prefix.json, tool-results/*.txt…) are
  // ignored, except that a subagent's `.meta.json` is noted for parentToolUseId.
  const names = new Set(entries.map((e) => e.name));
  for (const e of entries) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      const target = await stat(p).catch(() => undefined);
      if (target === undefined) {
        out.errors++;
        continue;
      }
      isDir = target.isDirectory();
      isFile = target.isFile();
    }
    if (isDir) await walk(p, root, out, seen, seenDirs);
    else if (isFile && e.name.endsWith('.jsonl')) await addFile(p, root, out, seen, names);
  }
}

/** Add one `*.jsonl` file (already known to be a file); `names` are its directory's entries. */
async function addFile(
  p: string,
  root: string,
  out: Discovery,
  seen: Set<string>,
  names: ReadonlySet<string>,
): Promise<void> {
  const rp = real(p);
  const st = await stat(p).catch(() => undefined);
  if (rp === undefined || st === undefined) {
    out.errors++;
    return;
  }
  if (seen.has(rp)) return;
  seen.add(rp);
  const stem = basename(p, '.jsonl');
  out.files.push({
    path: p,
    root,
    ...layout(relative(root, p).split(sep)),
    size: st.size,
    mtimeMs: st.mtimeMs,
    ...(names.has(`${stem}.meta.json`) ? { metaPath: join(dirname(p), `${stem}.meta.json`) } : {}),
  });
}

/**
 * The files of one session under `root` (for `tknxray watch`, which re-reads them on every
 * change): the main transcript `mainPath` plus every `*.jsonl` below `{dir}/{name}/` for each
 * name in `dirNames` (the sessionId and the file stem; subagent transcripts live there, [M]
 * CC 2.1.302). Same layout rules as `discover`. Flat `agent-<id>.jsonl` files next to the main
 * transcript (UNVERIFIED older layout) are not included. Never throws.
 */
export async function discoverSession(
  root: string,
  mainPath: string,
  dirNames: readonly string[],
): Promise<Discovery> {
  const out: Discovery = { roots: [resolve(root)], files: [], errors: 0 };
  const seen = new Set<string>();
  const seenDirs = new Set<string>();
  await addFile(resolve(mainPath), out.roots[0]!, out, seen, new Set());
  for (const name of new Set(dirNames)) {
    const dir = join(dirname(resolve(mainPath)), name);
    const st = await stat(dir).catch(() => undefined);
    if (st?.isDirectory()) await walk(dir, out.roots[0]!, out, seen, seenDirs);
  }
  out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export const fileStem = (f: DiscoveredFile): string => basename(f.path, '.jsonl');

/** A Claude Code sessionId (UUID). Fixture and real ids are both this shape. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Classify a path (segments relative to the root, file name last); see DiscoveredFile. */
function layout(parts: string[]): Pick<DiscoveredFile, 'project' | 'dirs' | 'subagentOf'> {
  const name = parts[parts.length - 1]!;
  const dirs = parts.slice(0, -1);
  const n = dirs.length;
  const at = (i: number): string => (i >= 0 ? dirs[i]! : '');
  if (n >= 2 && dirs[n - 1] === 'subagents' && SESSION_ID.test(dirs[n - 2]!))
    return { project: at(n - 3), dirs: dirs.slice(n - 2), subagentOf: dirs[n - 2]! };
  // UNVERIFIED (FORMAT.md Q4): agent-<id>.jsonl directly inside a session dir.
  if (n >= 1 && name.startsWith('agent-') && SESSION_ID.test(dirs[n - 1]!))
    return { project: at(n - 2), dirs: dirs.slice(n - 1), subagentOf: dirs[n - 1]! };
  return { project: at(n - 1), dirs: [] };
}
