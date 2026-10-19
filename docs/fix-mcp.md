# `tknxray fix mcp` (preview)

Adds `permissions.deny` rules for MCP tools that were never called in the analyzed sessions,
using the `tool-usage` (A7) findings. Run `tknxray fix mcp --help` for options.

- **Dry run by default.** It prints a unified diff and writes nothing. `--apply` writes.
- **Target:** `--settings FILE`, default `.claude/settings.local.json` in the current
  directory. Alternatives: `.claude/settings.json` (shared with the team),
  `~/.claude/settings.json` (all projects).
- **Rules:** `mcp__<server>__<tool>` per never-called tool. A server none of whose tools was
  called gets one server-wide `mcp__<server>` rule (`--per-tool` turns that off). Rules that
  are already there, including `mcp__<server>` and `mcp__<server>__*`, are not added again.
  Nothing is ever removed. Remove a rule by hand to re-enable a tool.
- **UNVERIFIED:** whether a deny rule also removes the tool's definition from the request,
  which is what would save tokens. Measure with `tknxray` before and after.

## How the file is written

- The JSON is parsed and re-serialized with the file's indent. Key order is kept (except that
  JavaScript puts integer-like keys first). A leading BOM and CRLF line endings are kept.
- **Compact arrays and objects get reflowed** to one item per line (`["a","b"]` becomes a
  multi-line array). The diff shows that reflow; the content is unchanged.
- Files with comments or trailing commas (JSONC) are refused and left untouched.
- With `--apply`: symlinks are followed and the real file is replaced, keeping its permission
  bits. A backup `<file>.tknxray-backup-<UTC timestamp>` (with `-1`, `-2`… if taken) is written
  first. The new text is written to a temp file next to it and renamed into place. If the file
  changed while tknxray was running, nothing is written and the exit code is 2.
