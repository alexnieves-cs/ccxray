# Real-log validation (SPEC §6 M1, M2, M4, M7; outside logs for 0.2)

One maintainer corpus, run locally with `scripts/real-check.sh` at commit `ae7f6e1` on
2026-10-21 (macOS, Apple M1 Pro, Node 25.8.1). The script prints counts and hashed ids only;
nothing below contains prompts, paths, project names or session ids. Dollar amounts from this
corpus are deliberately not recorded here. Re-run with `bash scripts/real-check.sh`.

## Corpus [M]

| metric | value |
|---|---:|
| JSONL files | 1,495 (3,154.5 MB) |
| lines / malformed / blank | 398,301 / 0 / 0 |
| sessions (of which subagent) | 1,491 (539) |
| assistant turns after dedupe | 45,412 |
| dedupe drops: same response / sidechain replay / cross-session | 46,063 / 7 / 0 |
| unknown record types (ignored) | 22 kinds, 27,339 records |
| Claude Code versions seen | 34 |

## ccusage cross-check (M2, M7)

`ccusage@latest claude session --json` on the same logs, compared by `pnpm validate:real --ccusage`.

| check | target | result |
|---|---|---|
| input / output / cache create / cache read totals | ±0.5% | **+0.00% on all four: PASS** |
| list-price cost total vs ccusage `totalCost` | ±$0.01 | **identical to the cent: PASS** |
| per-session token match | ±0.5% | 860 of 868 ccusage sessions pass; 3 fail, 5 not found (below) |

The 8 per-session mismatches are a grouping difference, not a counting one: the totals match
exactly, and the 5 "not found" ccusage sessions add up, to the cent, to the excess on the 3
"fail" sessions. UNVERIFIED cause: tknxray keys a main transcript by its first record's
`sessionId`, ccusage by the file name; a resumed or continued transcript seems to start with
records carrying the earlier session's id, so both tools count the same turns under different
session keys. `validate:real` now prints, for each "not found" session, whether its file was
grouped under another session, so the next run confirms or refutes this. 89 sessions exist only
in tknxray; UNVERIFIED: they are sessions ccusage omits (likely ones with no usage of their own).

## False-positive spot check (M4)

`scripts/fp-check.ts`, 20 findings sampled round-robin by analyzer from the last 30 days
(542 findings), each checked mechanically against the raw logs: the evidence pointer resolves,
the measured numbers match `usage`, and the analyzer's invariant holds (for example, a cache
rebuild really reads less cache than the turn before).

| # | analyzer | session hash | evidence | usage [M] | invariant |
|---:|---|---|---|---|---|
| 1 | cache-rebuild | 162663a306 | pass | pass | pass |
| 2 | fixed-overhead | e096e05783 | pass | pass | n.a. |
| 3 | big-tool-output | ca952c2810 | pass | n.a. | pass |
| 4 | repeated-read | 9b5bdbb913 | pass | n.a. | pass |
| 5 | tool-usage | c8592e965f | pass | n.a. | n.a. |
| 6 | context-growth | e60c19f4d1 | pass | pass | pass |
| 7 | subagent-cost | 5089d7e575 | pass | pass | pass |
| 8 | error-waste | a8694b6417 | pass | n.a. | pass |
| 9 | cross-agent-read | 05c4196ed3 | pass | n.a. | n.a. |
| 10 | fixed-overhead | 72d7c6a66b | pass | pass | n.a. |
| 11 | big-tool-output | 69453b7d1e | pass | n.a. | pass |
| 12 | repeated-read | e2293a1f00 | pass | n.a. | pass |
| 13 | tool-usage | c8592e965f | pass | n.a. | n.a. |
| 14 | context-growth | f34e9399c4 | pass | pass | pass |
| 15 | subagent-cost | f34e9399c4 | pass | pass | pass |
| 16 | error-waste | fc0aceb2a5 | pass | n.a. | pass |
| 17 | cross-agent-read | b6428b7c4a | pass | n.a. | n.a. |
| 18 | fixed-overhead | c8592e965f | pass | n.a. | n.a. |
| 19 | big-tool-output | e2293a1f00 | pass | n.a. | pass |
| 20 | repeated-read | e2293a1f00 | pass | n.a. | pass |

**20 of 20 pass every mechanical check; 0 fail.** At least one finding per analyzer type was
present in the window (9 of 10 types; cache-ttl had none on this corpus). This shows the findings
point at real records with the stated numbers; whether the advice is right is reviewed below.

## Advice review: is each finding right? (M4)

Reviewed 2026-10-22 by Claude (the project's coding agent, not a human) on the only real logs
readable in the cloud: this project's own build session (1 main session, 24 subagents, 60 MB,
CC 2.1.302). 35 findings; 20 picked round-robin by analyzer, each read against the transcript.
Alex's corpus was not re-read by hand: its transcripts never leave his Mac.

| # | analyzer | verdict | note |
|---:|---|---|---|
| 1 | subagent-cost | right | 45% of the session's tokens were Opus subagents doing exploration |
| 2 | context-growth | right | one long session, 7 compactions; /clear between tasks applies |
| 3 | cache-rebuild | **advice wrong** | rebuilds real (breaks of 1h to 39h), but "batch prompts" cannot bridge a 1h+ break. **Fixed:** now says /compact before a long break, or /clear for a new task |
| 4 | big-tool-output | right | 83k-char tool results; the "narrow it" advice is weak for a tool with no arguments |
| 5 | tool-usage | right | 16 of 31 MCP tools never called |
| 6 | cross-agent-read | right | 9 subagents each read docs/SPEC.md |
| 7 | fixed-overhead | right | 124k-token first turn |
| 8 | error-waste | **wrong** | the "re-call" passed a corrected argument of the same length. **Fixed:** inputs are now compared by hash, not size |
| 9 | repeated-read | right | an image re-read unchanged (0 tokens [E]: image size is not estimated) |
| 10 | context-growth | right | a subagent peaked at 383k tokens |
| 11 | big-tool-output | right | whole-file Reads of up to 41k chars |
| 12 | tool-usage | right | an MCP server with 0 of 10 tools used |
| 13 | cross-agent-read | right | docs/FORMAT.md read by 3 subagents |
| 14 | fixed-overhead | right | 64 tool definitions, MCP 48% of their size |
| 15 | error-waste | **wrong** | the same command was re-run after the user granted permission. **Fixed:** a re-call after a new prompt is not counted |
| 16 | big-tool-output | right | `cat` of a 26k-char file |
| 17 | tool-usage | right, title off | "2 of 2 tools never called" next to "1 used" (a tool loaded later). **Fixed:** "2 of 3" |
| 18 | big-tool-output | right | `sed -n` printing 21k chars |
| 19 | tool-usage | right | an MCP server with 0 of 3 tools used |
| 20 | big-tool-output | right | `cat` of a 29k-char file |

**Before the fixes: 3 of 20 wrong (#3 advice, #8, #15), above the SPEC's limit of 2.** After the
fixes, a re-run on the same logs no longer produces #8 or #15, #3 gives the new advice and #17 the
right count; each fix has a regression test. Limits: one corpus, one reviewer, and the reviewer
wrote the code. A review on other people's logs is still worth doing.

## Estimator calibration [E]

0.1 estimated every text at chars/4. Median ratio of that estimate to measured tokens: 0.548 over
16,090 samples, so [E] token figures ran about 45% low on this corpus. 0.2 estimates tool output
at chars/2.2, fitted on the outside logs below and consistent with this 0.548 (see
[Outside logs](#outside-logs) and SPEC §4.5).

## Performance [M]

Wall time and peak RSS of a full `tknxray --json` run, 3 runs each.

| window | wall time | peak RSS |
|---|---|---|
| last 7 days | 8.9 s, 9.0 s, 13.8 s | 428 to 460 MB |
| all time (3.15 GB) | 16.8 s, 14.8 s, 14.8 s | 436 to 469 MB |

Aggregate per-analyzer counts for the whole corpus are in [MY_SESSIONS.md](MY_SESSIONS.md).

## Outside logs

Six public GitHub repositories that commit their own Claude Code transcripts, read on 2026-11-25
on the `release-0.2` branch (Linux container, Node 22.23.5). Each was downloaded into its own
empty directory and only read; nothing from them was run. Everything below is aggregate counts;
no transcript content is copied here, and session ids are hashed. Dollar amounts are left out, as
above.

| source (repo @ commit) | files | MB | sessions (subagent) | turns [M] | CC versions |
|---|---:|---:|---:|---:|---|
| `boltonbailey/moser` @ `e543f2b` | 2 | 3.0 | 2 (0) | 227 | 2.1.191 to 2.1.232 |
| `cebert/cache-ttl-analyzer` @ `3460eed` | 14 | 31.6 | 14 (0) | 1,566 | 2.1.251 |
| `daniloc/voynich` @ `cc454a7` | 8 | 18.2 | 7 (0) | 568 | 2.1.183 to 2.1.197 |
| `ej31/omc-hook-experiment` @ `fad01e4` | 33 | 13.1 | 30 (8) | 444 | 2.1.74 |
| `joshspeagle/ssc-2026-ai-llm-demo` @ `cee1a71` | 25 | 10.9 | 25 (24) | 562 | 2.1.158 to 2.1.159 |
| `stevkazt/sgva` @ `635e1c4` | 18 | 21.9 | 16 (1) | 1,274 | 2.1.247 to 2.1.299 (6) |
| **all** | **100** | **98.7** | **94 (33)** | **4,641** | 2.1.74 to 2.1.299 |

### ccusage cross-check [M]

`npx ccusage@latest claude session --json` per source, compared with `scripts/validate-real.ts
--ccusage`. **A1 totals (input, output, cache create, cache read) match to +0.00% and the
list-price cost total matches to ±$0.01 on all six: PASS.** Per session, 50 of 62 ccusage
sessions match; the other 12 are all in `stevkazt/sgva`, where ccusage and tknxray key the same
turns under different sessions (12 missing on each side, with 51 cross-session copies dropped by
dedupe). The totals match, so this is a grouping difference; UNVERIFIED which side's grouping is
the one a user would expect. Four sessions exist only in tknxray (UNVERIFIED: likely sessions
ccusage skips, as on the maintainer corpus).

The first run did not match on `cebert/cache-ttl-analyzer`: tknxray left out the advisor tool's
own calls (`usage.iterations[]` entries of type `advisor_message`). Fixed in `ae34421`; they now
count toward A1 totals and $ under the advisor's model, and that source matches 14 of 14 sessions.

### False-positive spot check [M]

`scripts/fp-check.ts --since 2000-01-01 --max 30` per source, the same mechanical checks as
[above](#false-positive-spot-check-m4): the evidence pointer resolves, measured numbers match
`usage`, and the analyzer's invariant holds.

| source | findings | checked | pass |
|---|---:|---:|---:|
| `boltonbailey/moser` | 6 | 6 | 6 |
| `cebert/cache-ttl-analyzer` | 42 | 30 | 30 |
| `daniloc/voynich` | 17 | 17 | 17 |
| `ej31/omc-hook-experiment` | 23 | 23 | 23 |
| `joshspeagle/ssc-2026-ai-llm-demo` | 23 | 23 | 23 |
| `stevkazt/sgva` | 22 | 22 | 22 |
| **all** | **133** | **121** | **121** |

All 10 analyzer types fired at least once (cache-ttl twice). Mechanical checks catch wrong
pointers and numbers, not wrong advice: a human read of findings on other people's logs is what
`tknxray share` (SPEC §3.2) is for.

One finding was wrong in a way the checks could not see: on `joshspeagle/ssc-2026-ai-llm-demo`,
A11 reported one file as two findings because agents ran in a checkout and in a subdirectory of
it, so the same file had two relative paths. Fixed in `d897c40` (findings join on the absolute
path as well as the relative one) with a regression test.

### Estimator calibration [E]

On turns that added exactly one tool_result of at least 1,000 chars, the measured growth of the
prompt (input + cache write + cache read, minus the previous output) against the result's chars:

- chars/4 medians per source: 0.459, 0.568, 0.521, 0.537, 0.531 and 0.528 (the maintainer
  corpus: 0.548), so every corpus ran 43% to 54% low.
- A Theil–Sen fit over all six (3,803 turns): measured ≈ 1.82 × chars/4 + about 34 tokens per
  result, i.e. about 2.2 chars per token. Per source 1.97 to 2.32; per tool, Bash 2.18 and Read
  2.25.
- 0.2 uses chars/2.2 for tool output. Calibration medians with it: 0.835, 1.033, 0.948, 0.975,
  0.965 and 0.959 (36 to 410 samples per source). Other text (tool definitions, CLAUDE.md, tool
  inputs) stays at chars/4, UNVERIFIED: too few clean samples to fit it.

Because tool outputs now estimate about 1.8× larger, A5 (big tool output) crosses its threshold
more often: **12 findings before, 39 after** on these logs; every A5 finding fp-check sampled
passes. Other analyzers' counts did not change.

### Known limits found here

- **Workflow-tool subagents are not linked to the tool call that started them.** In
  `joshspeagle/ssc-2026-ai-llm-demo`, 24 subagents were started by the `Workflow` tool. Its
  `toolUseResult` has `status`, `taskId`, `runId`, `summary`, `transcriptDir` and `scriptPath`
  but no `agentId`, and there is no `agent-<id>.meta.json`, so 0 of 24 link to a `tool_use`.
  They are still counted, under their parent session (from the directory layout); only the
  per-call view (A9 by subagent type) is missing. Not a bug; linking by `transcriptDir` is
  possible later.
- **`tool_result without matching tool_use` (95 on `ej31/omc-hook-experiment`) is benign.** The
  95 results sit in sidechain records that replay the main conversation: their `tool_use` and an
  identical result are both in the main chain, and dedupe drops the 95 replayed responses
  (sidechain replays = 95). Nothing is lost or counted twice.

