# cc-slim: compress huge Bash outputs before they enter the context (design, preview)

Status: **prototype, opt-in only, no savings claim.** SPEC §6 M5 says no savings claim until
the §8 benchmark exists. Nothing in this document claims that cc-slim saves tokens on real work.

Labels: **[M]** measured, **[E]** estimated, **[UNVERIFIED]** not confirmed against a running
Claude Code.

## 1. Problem

A5 (big-tool-output) finds Bash results of tens of thousands of chars, often `pnpm test`,
builds and logs. The full output enters the context once and is then re-sent on every
following turn (from the cache when it hits, and as a cache write when it doesn't). Most of
it is passing tests, progress lines and repeated stack frames. The model usually needs the
failures, the command's first lines (what ran) and the last lines (the summary).

## 2. What it does

`src/slim/compress.ts` exports a pure, deterministic function
`compressBashOutput(text, opts) → { text, stats }`:

1. Outputs at or under `threshold` chars (default 20,000) are returned **unchanged**.
2. **Failure lines are never dropped.** Any line matching `error`, `fail`/`failed`/`failing`,
   `fatal`, `panic`, `exception`, `Traceback`, `assertion`, `npm ERR!`, `FooError:`, `✗ ✘ ❌ ×`, Jest `●`, ESLint `✖`, pytest `E   …` lines, `assert`,
   or `exit code N` / `exited with status N` (N ≠ 0) is kept verbatim, with 2 lines of context
   on each side. Failure lines are never cut, even when very long.
3. The first `headLines` (30) and last `tailLines` (60) lines are kept. A known non-zero exit
   code doubles the tail.
4. Runs of identical lines become one line plus `… [cc-slim] previous line repeated N more
   times`.
5. Stack frames (JS/Java `at …`, Python `File "…", line N` plus its source line, Go/Rust/Ruby/C
   `file.ext:N`) already printed above are dropped and counted:
   `… [cc-slim] N repeated stack frames omitted (printed above)`.
6. Everything else is replaced by `… [cc-slim] N lines omitted`. Non-failure lines longer than
   2,000 chars are cut in the middle with a count.
7. A one-line `[cc-slim]` header says what was kept and that the omitted lines are not
   available, so the model knows to re-run a narrower command instead of guessing.
8. Idempotent: an output that starts with the `[cc-slim]` header is returned unchanged. If the
   result would not be shorter, the original is returned.

`stats` reports input/output chars and lines, failure lines kept, repeats collapsed, frames
dropped and lines omitted. Counts only, never content.

## 3. Hook integration

### 3.1 Claude Code hook contract (as I know it from the hooks docs)

- Hooks are configured under `"hooks"` in `settings.json` (`~/.claude/settings.json`,
  `.claude/settings.json` or `.claude/settings.local.json`), per event, with a `matcher` on
  the tool name and a list of `{ "type": "command", "command": "…" }` entries.
- The command gets one JSON object on **stdin**: `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, and for tool events `tool_name`, `tool_input` and (PostToolUse only)
  `tool_response`.
- Exit code 0 means success; stdout may hold a JSON response. Exit code 2 is a blocking error
  (stderr is fed back to Claude). Other codes are non-blocking errors.
- PostToolUse JSON output can carry `decision: "block"` + `reason`, and
  `hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext, updatedToolOutput }`.
- **Documented** (code.claude.com/docs/en/hooks, read 2026-10-19): `updatedToolOutput`
  "replaces the tool's output with the provided value before it is sent to Claude" and works for
  all tools; `updatedMCPToolOutput` is the older, MCP-only field. A built-in tool's replacement
  must match that tool's output schema or it is ignored, and the tool has already run.
- **[UNVERIFIED]** The Bash `tool_response` shape `{ stdout, stderr, interrupted, isImage }`, and
  so whether the prototype's replacement (that object with shorter `stdout`/`stderr`) matches
  the schema. Step 0 of the measurement plan (§6) checks it before anything else.

### 3.2 The prototype hook

`hooks/cc-slim-posttooluse.mjs` (uses the built `dist/slim.js`):

- reads the hook JSON from stdin; ignores anything that is not `PostToolUse` for `Bash`;
- compresses `stdout` and `stderr` separately when either is over the threshold
  (`CC_SLIM_THRESHOLD`, default 20,000 chars);
- if something changed, prints
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{…tool_response, stdout, stderr}}}`;
  otherwise prints nothing;
- **fails open**: on malformed input or any error it prints nothing and exits 0, so Claude
  Code keeps the original output. It never blocks a tool.

Install (opt-in, per project):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node /path/to/ccxray/hooks/cc-slim-posttooluse.mjs" }]
      }
    ]
  }
}
```

### 3.3 Fallback design if PostToolUse cannot replace Bash output

The same script has a `--filter` mode (plain text on stdin, compressed text on stdout). A
PreToolUse hook could rewrite the Bash command to `set -o pipefail; ( <cmd> ) 2>&1 | node
…/cc-slim-posttooluse.mjs --filter` using PreToolUse `updatedInput` **[UNVERIFIED: field name
and availability on the user's version]**. This is riskier: it changes the command the user
approved, merges stderr into stdout, needs `pipefail` (bash only; Windows shells differ) to
keep the exit code, and breaks commands that detect a TTY. Not implemented; would need its own
review. A third option is to save the full output to a temp file and print its path in the
header, so the model can `Read` the omitted part; this trades context for disk writes of
possibly sensitive output and is not implemented either.

## 4. Risks

- **Hiding what the model needs.** The worst failure is dropping the line that explains the
  error. Mitigations: every failure line is kept verbatim with context; a non-zero exit keeps
  a longer tail; the header says lines are missing; only outputs over the threshold are
  touched. Residual risk: errors with no recognizable keyword (for example a wrong number in a
  passing-looking line, or a diff the model asked for). This is why it is **opt-in**.
- **Intentional big outputs.** `cat`, `git diff` and `jq` output that the model asked for in
  full get cut. A future allowlist or a "no-slim" marker in the command could exempt them.
- **Cache effects.** Changing the output does not invalidate the cache (it only changes the
  new tool_result), but this is **[UNVERIFIED]** until measured with A2.
- **False reassurance.** "Failure lines kept: 0" does not mean nothing failed.
- **Format drift.** The hook contract is undocumented in places (see §3.1) and may change.

## 5. Opt-in only

cc-slim is never installed by tknxray. The user adds the hook entry by hand (or, later, with an
explicit `tknxray fix slim --apply`, which would print a diff first like `fix mcp`).

## 6. Measurement plan (before any claim)

0. **Does the hook take effect?** Install it in a scratch project, run a command with a large
   output, then check the transcript: tknxray A5 reports the logged `tool_result` chars. If
   they are unchanged, PostToolUse cannot replace Bash output (§3.1) and the §3.3 design is
   the only route.
1. **Compressor behavior on synthetic outputs:** `pnpm bench:slim` (bench/slim.ts) prints chars
   before/after [M] and tokens [E] on made-up test logs, stack traces and build logs. This
   only describes the compressor, it is not a savings number.
2. **Real sessions (SPEC §8):** Alex's own sessions over comparable weeks without and with
   the hook: tool-output tokens per turn (A5, [E]), input + cache write per turn ([M]), cache
   hit ratio ([M]).
3. **Quality:** count the times the model re-ran a command after a `[cc-slim]` header (a sign
   it lacked information), and a task-pass-rate check before any "same quality" statement.
