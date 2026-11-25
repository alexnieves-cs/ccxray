#!/usr/bin/env node
// cc-slim prototype hook (opt-in; see docs/cc-slim.md). Two modes:
//
//   node hooks/cc-slim-posttooluse.mjs           PostToolUse hook: reads the hook JSON on stdin
//   some-command 2>&1 | node hooks/cc-slim-posttooluse.mjs --filter   plain text filter
//
// Fail-open: on any problem it prints nothing and exits 0, so Claude Code keeps the original
// output. It never blocks a tool and never exits non-zero.
//
// Hook contract, documented (code.claude.com/docs/en/hooks, "PostToolUse", read 2026-11-25):
// - stdin: { session_id, transcript_path, cwd, permission_mode, hook_event_name: "PostToolUse",
//   tool_name, tool_input, tool_response, tool_use_id, duration_ms? }; exit 0 applies stdout JSON.
// - Bash returns an object with `stdout`, `stderr`, `interrupted` and `isImage`; the docs' own
//   `updatedToolOutput` example for Bash is that object. A built-in tool's replacement that does
//   not match its output schema is ignored and the original output is used.
// - For a failed call, `tool_response` is the error text as a string. This hook leaves it alone:
//   Claude needs the error details, and a string is not the Bash output shape.
// [M] Logged Bash `toolUseResult` objects in six public corpora (CC 2.1) always carry those four
// fields, sometimes with more (noOutputExpected, backgroundTaskId, ...), so the replacement keeps
// every original field and changes only stdout/stderr.
// UNVERIFIED: that a live Claude Code applies the replacement (docs/cc-slim.md §6 step 0).
import { Buffer } from 'node:buffer';

// A closed pipe must not turn into an error exit.
process.stdout.on('error', () => {});

const threshold = Number(process.env.CC_SLIM_THRESHOLD) || 20_000;
const filter = process.argv.includes('--filter');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function run(input) {
  // Loaded here, not statically, so a missing or broken dist/slim.js fails open.
  const { compressBashOutput } = await import('../dist/slim.js');
  const slim = (text) =>
    typeof text === 'string' ? compressBashOutput(text, { threshold }) : null;
  if (filter) {
    process.stdout.write(slim(input).text);
    return;
  }
  const hook = JSON.parse(input);
  if (hook?.hook_event_name !== 'PostToolUse' || hook.tool_name !== 'Bash') return;
  const res = hook.tool_response;
  let updated;
  // A string is a failed call's error text, and isImage means stdout is image data: leave both.
  if (res && typeof res === 'object' && res.isImage !== true) {
    const out = slim(res.stdout);
    const err = slim(res.stderr);
    if (out?.stats.changed || err?.stats.changed)
      updated = { ...res, stdout: out?.text ?? res.stdout, stderr: err?.text ?? res.stderr };
  }
  if (updated === undefined) return; // short output: nothing to say, Claude Code keeps it as is
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated },
    }),
  );
}

let input = '';
try {
  input = await readStdin();
  await run(input);
} catch {
  // Fail open: the hook prints nothing (Claude Code keeps the original output); the filter
  // passes its input through unchanged.
  if (filter) process.stdout.write(input);
}
process.exitCode = 0;
