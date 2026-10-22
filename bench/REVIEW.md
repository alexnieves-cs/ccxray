# Real-log validation (SPEC §6 M1, M2, M4, M7)

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

Median ratio of the chars/4 estimate to measured tokens: 0.548 over 16,090 samples, so [E]
token figures run about 45% low on this corpus (see FORMAT.md).

## Performance [M]

Wall time and peak RSS of a full `tknxray --json` run, 3 runs each.

| window | wall time | peak RSS |
|---|---|---|
| last 7 days | 8.9 s, 9.0 s, 13.8 s | 428 to 460 MB |
| all time (3.15 GB) | 16.8 s, 14.8 s, 14.8 s | 436 to 469 MB |

Aggregate per-analyzer counts for the whole corpus are in [MY_SESSIONS.md](MY_SESSIONS.md).
