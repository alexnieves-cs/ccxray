# ccxray

> **Status: in development. Nothing works yet.** This repo currently holds the spec only.

`ccxray` will answer one question about your Claude Code usage: **where did my tokens go, and what can I change?**

It will read the session transcripts Claude Code already writes on your machine (`~/.claude/projects/**/*.jsonl`) and show a per-turn breakdown:
- fixed overhead (system prompt, tool definitions, MCP tools)
- large tool outputs
- repeated reads of unchanged files
- cache rebuilds, with the likely cause of each

Every finding will come with a concrete suggested fix.

```bash
npx ccxray          # planned; not published yet (see docs/SPEC.md §Distribution about the npm name)
```

## Principles
- **Local only.** No telemetry, no account, no network calls. Nothing is sent to Anthropic or anyone else.
- **Honest numbers.** Measured values and estimates are labeled differently.
- **Within Anthropic's terms.** Read-only analysis of your own logs. No multi-account or limit-evasion features.

See [docs/SPEC.md](docs/SPEC.md) for the full design and roadmap.

## License
MIT
