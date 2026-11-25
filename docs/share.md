# Sharing results without transcripts: `tknxray share`

tknxray's findings need checking on logs other than its author's. `tknxray share` makes that
possible without anyone sending a transcript.

## Run it

```sh
tknxray share                        # the last 7 days; writes tknxray-share.json
tknxray share --since 2026-11-01     # a longer window
tknxray share --out ~/Desktop/share.json
```

It reads your logs like `tknxray` does and writes one JSON file. Nothing is sent anywhere: you
decide whether to share the file, and with whom. An existing file (maybe one you already reviewed)
is left alone unless you pass `--force`.

## What the file holds

- Token totals (all, by model, main vs subagents) [M] and their $ at API list prices [E].
- Each finding's analyzer id (for example `cache-rebuild`), severity, tokens, $ impact and the
  numbers behind it (counts, sizes, causes like `ttl-expiry`), plus how many evidence turns it
  listed.
- Parse stats: file and line counts, Claude Code versions, record types, dedupe counts.
- Built-in tool names (`Bash`, `Read`), `claude-*` model ids and Claude Code versions.

## What it never holds

No prompts, outputs or file contents, no file paths, commands, project names or log directories,
no finding titles, evidence details or fix text, and no session ids. Sessions appear as salted
hashes so findings that share a session can be grouped; the salt is random for each file and is
not saved, so two files cannot be matched up. MCP tool names read `mcp`, custom subagent types
`(custom)` and any other string `(other)`.

[`schema/share.v1.json`](../schema/share.v1.json) describes the file and allows no other fields, so
you can validate a file against it before you send it. Open the file and read it too: it is plain
JSON.

## Review the findings

The command prints each finding on your terminal, with its number, title and the sessions it came
from. That list is not in the file. (The example is made up.)

```
1. [high] cache-rebuild: 38 rebuilds cost 2.8M cache-write tokens
   sessions: 3fa2c1d0 (5be1f07a92c4 in the file), 9b07e5aa (e04d6c31a8f2 in the file), +2 more
```

For each one, decide whether it is a real problem in your sessions (`tknxray session 3fa2c1d0`
shows that session turn by turn). Then, in the file, set that finding's `review.verdict`:

- `"real"`: the finding is right.
- `"false-positive"`: it flags something that is not a problem, or the numbers are wrong.
- `"unsure"`: you can't tell.

A short `note` helps, in your own words (it is the only free text in the file, so leave out
anything you would not share). `notes` at the end is for anything else.

## Send it

Send the file to whoever asked you to run it, or attach it to an issue on
[the repo](https://github.com/alexnieves-cs/ccxray/issues).
