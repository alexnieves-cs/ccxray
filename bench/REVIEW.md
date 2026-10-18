# False-positive review (SPEC §6 M4)

**Status: PENDING Alex's local run.** Nothing below has been filled in. Pick 20 random findings
from `ccxray --json` on real logs, check each by hand against the transcript, and record only
hashes and a verdict here: never prompt, file or command content. Acceptance: ≤ 2 FP out of 20,
and ≥ 1 true positive per analyzer type (or "none present").

Known false-positive risk to check first: **A8 counts `summary` records as compaction markers**
(FORMAT.md Q5, UNVERIFIED). If Claude Code writes `summary` records for other reasons (e.g. session
titles), A8 may flag sessions as compacted that never were.

| # | analyzer | session hash | turn uuid hash | verdict TP/FP | note |
|---|---|---|---|---|---|
