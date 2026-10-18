// Find Claude Code transcript files (SPEC §3, §4.2). Read-only; never throws.

import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

export interface DiscoveredFile {
  path: string;
  root: string;
  /** Project directory name under the root ('' for a file directly in the root). */
  project: string;
  /** Path segments between the project dir and the file, e.g. ['{sessionId}', 'subagents']. */
  dirs: string[];
  /** true when the file is below a subdirectory of the project dir. */
  nested: boolean;
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
    else if (isFile && e.name.endsWith('.jsonl')) {
      const rp = real(p);
      const st = await stat(p).catch(() => undefined);
      if (rp === undefined || st === undefined) {
        out.errors++;
        continue;
      }
      if (seen.has(rp)) continue;
      seen.add(rp);
      const parts = relative(root, p).split(sep);
      const project = parts.length > 1 ? parts[0]! : '';
      const dirs = parts.slice(1, -1);
      out.files.push({
        path: p,
        root,
        project,
        dirs,
        nested: dirs.length > 0,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ...(names.has(`${e.name.slice(0, -'.jsonl'.length)}.meta.json`)
          ? { metaPath: join(dir, `${e.name.slice(0, -'.jsonl'.length)}.meta.json`) }
          : {}),
      });
    }
  }
}

export const fileStem = (f: DiscoveredFile): string => basename(f.path, '.jsonl');
