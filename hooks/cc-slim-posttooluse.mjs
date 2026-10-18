#!/usr/bin/env node
// cc-slim prototype hook (opt-in; see docs/cc-slim.md). Two modes:
//
//   node hooks/cc-slim-posttooluse.mjs           PostToolUse hook: reads the hook JSON on stdin
//   some-command 2>&1 | node hooks/cc-slim-posttooluse.mjs --filter   plain text filter
//
// Fail-open: on any problem it prints nothing and exits 0, so Claude Code keeps the original
// output. It never blocks a tool and never exits non-zero.
//
// Hook contract (from Claude Code's hooks docs as known to the author):
// UNVERIFIED: stdin fields { session_id, transcript_path, cwd, hook_event_name: "PostToolUse",
//             tool_name, tool_input, tool_response }; stdout: JSON; exit 0.
// UNVERIFIED: the Bash `tool_response` shape { stdout, stderr, interrupted, isImage }.
// UNVERIFIED: `hookSpecificOutput.updatedMCPToolOutput` is documented for MCP tools; whether
// Claude Code honors it for Bash (replacing what enters the context) is unknown and may be
// ignored. docs/cc-slim.md step 0 of the measurement plan checks this before anything else.
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
  if (typeof res === 'string') {
    const r = slim(res);
    if (r?.stats.changed) updated = r.text;
  } else if (res && typeof res === 'object') {
    const out = slim(res.stdout);
    const err = slim(res.stderr);
    if (out?.stats.changed || err?.stats.changed)
      updated = { ...res, stdout: out?.text ?? res.stdout, stderr: err?.text ?? res.stderr };
  }
  if (updated === undefined) return; // short output: nothing to say, Claude Code keeps it as is
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: updated },
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
