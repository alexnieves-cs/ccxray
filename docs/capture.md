# `tknxray capture`: measure one request's tool, system and message sizes (opt-in, API key only)

Status: **preview, opt-in.** It is the only part of tknxray that opens a socket, and it only
**listens** on `127.0.0.1`. It never connects anywhere.

## Why

Transcripts don't always say how big the tool definitions and system prompt are (SPEC §4.4
Q3). A7 (tool-usage) can list unused MCP tools but not what they cost. `capture` measures one
real request from your Claude Code setup, so you can see the per-tool definition size.

## How to use it

```sh
tknxray capture --i-understand-this-is-api-key-only           # prints the port
# in another terminal, with ANTHROPIC_API_KEY set (an API key, not a subscription login):
ANTHROPIC_BASE_URL=http://127.0.0.1:<port> claude -p "say hi"
```

Claude Code shows an API error; that is expected. tknxray prints the sizes and exits.

Options: `--port N` (default: a free port), `--timeout SECONDS` (default 300).

## What it does and doesn't do

- Refuses to start without `--i-understand-this-is-api-key-only`.
- Binds `127.0.0.1` only. Makes **no outbound request**: nothing is forwarded to Anthropic or
  anywhere else. CI checks the built `dist/capture.js` for outbound client calls and for a
  `listen` that is not on `127.0.0.1` (`test/no-network.test.ts`).
- Measures only `POST /v1/messages`. Other paths get a 404 and are not read.
- **Refuses OAuth.** Any request with an `Authorization: Bearer …` header, or an `x-api-key`
  starting with `sk-ant-oat` (an OAuth token), (how a Claude
  subscription login authenticates) gets a 401, its body is not read, nothing is recorded, and
  capture exits. Reusing subscription OAuth outside Claude Code is against the ToS (CLAUDE.md
  rule 5), so capture doesn't touch it.
- Requires `x-api-key`. Its value is only checked for presence; it is never stored, logged or
  printed.
- Prints **sizes only**: request body bytes [M], chars of the tool definitions, system prompt
  and messages [M], each tool's name and definition chars [M], and tokens as chars/4 [E].
  No prompt, system or tool description text is printed or saved.
- Skips requests whose body has no `tools` array (answered with an error, nothing printed but
  their size) and measures the **first request that has one**, answers it with an error and exits.
  **[UNVERIFIED]** that the first request with tools is the main-loop request.
- The server code is a separate bundle (`dist/capture.js`), loaded by the CLI with a dynamic
  import only when `capture` runs, so the main bundle has no network code at all.

## Caveats

- Sizes are chars, not tokens. The [E] token numbers are chars/4.
- What Claude Code sends can differ between the first and later requests and between versions.
- With `ANTHROPIC_API_KEY` set, Claude Code uses API billing, not your subscription. The one
  request is never forwarded, so it is not billed.
