// `ccxray capture` server (opt-in, API-key only; docs/capture.md). Built as its own bundle,
// dist/capture.js, the only file allowed to import node:http (test/no-network.test.ts).
// It binds 127.0.0.1 only, makes no outbound connection, forwards nothing, measures the first
// POST /v1/messages request, answers it with an error and stops.
// Requests with `Authorization: Bearer` (OAuth / subscription) are rejected and not read.
// The x-api-key value is only checked for presence; it is never stored or printed.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { formatMeasurement, measureRequest } from './measure.js';

export interface CaptureOptions {
  port: number;
  timeoutMs: number;
  out: (s: string) => void;
}

export interface CaptureHandle {
  port: number;
  /** Exit code: 0 after a measurement, 1 on rejection, timeout or error. */
  done: Promise<number>;
}

const MAX_BODY = 64 * 1024 * 1024;

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'ccxray_capture', message } }));
}

export function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  let finish!: (code: number) => void;
  const done = new Promise<number>((r) => (finish = r));
  let finished = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const stop = (code: number): void => {
      if (finished) return;
      finished = true;
      const shut = (): void => {
        server.close();
        server.closeAllConnections();
      };
      if (res.closed) shut();
      else res.on('close', shut);
      finish(code);
    };
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^\s*bearer\b/i.test(auth)) {
      req.resume();
      reply(res, 401, 'ccxray capture only measures API-key requests; OAuth requests are refused');
      opts.out('Refused a request with Authorization: Bearer (OAuth). Nothing was recorded.\n');
      return stop(1);
    }
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || path !== '/v1/messages') {
      req.resume();
      return reply(res, 404, 'ccxray capture only measures POST /v1/messages');
    }
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0) {
      req.resume();
      reply(res, 401, 'ccxray capture needs an x-api-key request');
      opts.out('Refused a request without x-api-key. Nothing was recorded.\n');
      return stop(1);
    }
    const enc = req.headers['content-encoding'];
    if (enc !== undefined && enc !== 'identity') {
      req.resume();
      reply(res, 415, 'ccxray capture does not decode compressed bodies');
      opts.out('Refused a compressed request body. Nothing was recorded.\n');
      return stop(1);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) {
        reply(res, 413, 'request body too large');
        opts.out('Request body over 64 MB; not measured.\n');
        return stop(1);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reply(res, 400, 'request body is not JSON');
        opts.out('Request body is not JSON; not measured.\n');
        return stop(1);
      }
      chunks.length = 0;
      opts.out(formatMeasurement(measureRequest(body, size)));
      reply(res, 400, 'ccxray capture measured this request and does not forward it. Stopping.');
      stop(0);
    });
  });
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        opts.out(`No request within ${Math.round(opts.timeoutMs / 1000)} s; stopping.\n`);
        server.close();
        server.closeAllConnections();
        finish(1);
      }, opts.timeoutMs);
      void done.then(() => clearTimeout(timer));
      resolveStart({ port, done });
    });
  });
}
