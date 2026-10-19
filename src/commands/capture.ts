// `tknxray capture` (opt-in, API-key only; docs/capture.md). The server lives in a separate
// bundle (dist/capture.js) loaded here only after the explicit flag, so the main bundle keeps
// passing the no-network scan.
import { parseArgs } from 'node:util';
import type { CaptureHandle, CaptureOptions } from '../capture/index.js';

export const CAPTURE_FLAG = 'i-understand-this-is-api-key-only';

export const CAPTURE_HELP = `Usage: tknxray capture --${CAPTURE_FLAG} [--port N] [--timeout SECONDS]

Opt-in, API-key only. Starts a local server on 127.0.0.1 that measures the sizes (tool
definitions, system prompt, messages) of the FIRST request Claude Code sends to it, answers
with an error and exits. Nothing is forwarded anywhere. Requests authenticated with OAuth
(Authorization: Bearer, i.e. a Claude subscription) are refused and not recorded. Only sizes
are printed, never content or the key. See docs/capture.md.

  --port N           port to listen on (default: a free port, printed at start)
  --timeout SECONDS  give up after this long without a request (default 300)
`;

type CaptureModule = { startCapture: (o: CaptureOptions) => Promise<CaptureHandle> };

const loadServer = async (): Promise<CaptureModule> => {
  // Non-literal specifier on purpose: the bundler must leave it alone so the server code stays
  // in dist/capture.js, next to dist/cli.js.
  const spec = new URL('./capture.js', import.meta.url).href;
  return (await import(spec)) as CaptureModule;
};

export async function captureCommand(
  argv: string[],
  out: (s: string) => void,
  load: () => Promise<CaptureModule> = loadServer,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      [CAPTURE_FLAG]: { type: 'boolean' },
      port: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });
  if (values.help) {
    out(CAPTURE_HELP);
    return 0;
  }
  if (values[CAPTURE_FLAG] !== true) {
    out(`Refusing to start: capture is opt-in and API-key only. Pass --${CAPTURE_FLAG}.\n\n`);
    out(CAPTURE_HELP);
    return 2;
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  const timeout = values.timeout === undefined ? 300 : Number(values.timeout);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !(timeout > 0)) {
    out('tknxray capture: --port must be 0-65535 and --timeout a positive number\n');
    return 2;
  }
  const { startCapture } = await load();
  const h = await startCapture({ port, timeoutMs: timeout * 1000, out });
  out(
    `tknxray capture listening on http://127.0.0.1:${h.port} (local only, forwards nothing).\n` +
      `In another terminal, with ANTHROPIC_API_KEY set (not a subscription login), run:\n` +
      `  ANTHROPIC_BASE_URL=http://127.0.0.1:${h.port} claude -p "say hi"\n` +
      `Claude Code will show an error; that is expected.\n`,
  );
  return h.done;
}
